#!/usr/bin/env node
/**
 * autopilot environment preflight (#504, epic #183/#503) — the third RUN
 * START gate, alongside `preflight.mjs` (merge authority, #316) and
 * `ratebudget.mjs` (the GraphQL bucket, #407). Neither of those two looks at
 * the machine: nothing verified that `gh`/`node`/`pnpm` resolve, that
 * `node_modules` exists, that the board's Status option keys match the ones
 * `select.mjs` reads, or that the statusline plugin path on disk still
 * exists. `doctor.mjs` covers part of this ground but is a separate,
 * manually-invoked, read-only skill — never wired into the loop and returns
 * no GO/NO-GO verdict a loop can gate on. So a run could burn setup work and
 * only wedge mid-flight on an environment problem that was true before the
 * first subagent ever spawned.
 *
 * Mirrors `preflight.mjs`/`ratebudget.mjs`'s shape exactly, so this composes
 * instead of inventing a third pattern:
 *  - `evaluateEnvPreflight(probes)` — pure: probe results → `{verdict,
 *    blockers, warnings}`. No IO, no filesystem, no shell (AC.1).
 *  - `probeEnv(ctx)` — the IO wrapper: runs the six probes (AC.2) with
 *    injectable `exec`/`gh`/`stat`/`readJson`, reusing `lib/board.mjs`'s
 *    `getProjectFields`/`optionKey` (the same primitives `doctor.mjs`'s own
 *    board check already uses) rather than duplicating them.
 *
 * Fail closed but narrow (AC.4, matching `ratebudget.mjs`'s degrade-don't-
 * hard-block rule): a probe that *cannot complete* (an unexpected thrown
 * error — a broken double in tests, or a genuinely unanticipated local
 * failure) degrades to a WARNING via the shared `runProbe` wrapper below. A
 * probe that completes and finds a real, specific problem (gh genuinely not
 * on PATH; node_modules genuinely absent; the statusline path genuinely
 * missing on disk) is a BLOCKER — that distinction is what AC.2 exists to
 * catch, so it must never itself degrade to a warning. A broken probe must
 * never be able to block a healthy run; a probe that works must never be
 * able to hide a real one.
 *
 * Out of scope (ticket's own boundary): no auto-repair. This gate reports
 * and refuses — installing deps or rewriting settings stays a human step or
 * a later ticket.
 */
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { stat as fsStat } from 'node:fs/promises';
import { run, makeGh } from '../lib/exec.mjs';
import { loadConfig } from '../lib/config.mjs';
import { getProjectFields, optionKey } from '../lib/board.mjs';
import { readJson } from '../lib/jsonfile.mjs';
import { TIER, SKIP } from './select.mjs';

/** The exact Status keys `select.mjs` consumes — `actionFor`'s branches plus `SKIP`. */
export const SELECT_STATUS_KEYS = [...Object.keys(TIER), ...SKIP];

/**
 * Run one probe, catching anything it throws (AC.4): a thrown error means
 * the check itself could not complete, which degrades to a warning rather
 * than a blocker. A probe that completes normally — including one that
 * completes by returning a `fail` result — is untouched by this wrapper.
 */
async function runProbe(id, fn, crashFix) {
  try {
    return await fn();
  } catch (err) {
    return {
      id,
      status: 'warn',
      detail: `${id} probe could not complete (${err && err.message ? err.message : String(err)})`,
      fix: crashFix ?? `investigate the ${id} probe (envpreflight.mjs) and re-run`,
    };
  }
}

/**
 * Pure boundary decision (AC.1, mirrors `shouldPauseForBudget`): no IO.
 * Partitions already-run probe results into blockers (verdict-flipping) and
 * warnings (surfaced but never block). Every blocker carries a stable `id`,
 * a `detail`, and a concrete `fix` — AC.1's contract for what a caller can
 * act on.
 */
export function evaluateEnvPreflight(probes) {
  const list = Array.isArray(probes) ? probes : [];
  const blockers = list
    .filter((p) => p && p.status === 'fail')
    .map((p) => ({ id: p.id, detail: p.detail, fix: p.fix }));
  const warnings = list
    .filter((p) => p && p.status === 'warn')
    .map((p) => ({ id: p.id, detail: p.detail, fix: p.fix }));
  return { verdict: blockers.length ? 'no-go' : 'go', blockers, warnings };
}

/** Numbered blocker list with per-blocker fixes (AC.3) — pure text, no IO. */
export function formatBlockers(blockers) {
  return (blockers ?? []).map((b, i) => `${i + 1}. [${b.id}] ${b.detail} — fix: ${b.fix}`);
}

/** `gh`/`node`/`pnpm` resolvable (AC.2). `exec` is injected — never a bare shell call in tests. */
export async function probeExecutable(id, cmd, exec, installFix) {
  const res = await exec(cmd, ['--version']);
  if (res && res.ok) {
    const firstLine = String(res.stdout ?? '').split(/\r?\n/).find((l) => l.trim()) ?? '';
    return { id, status: 'ok', detail: `${cmd} resolvable (${firstLine.trim() || 'no version output'})` };
  }
  return { id, status: 'fail', detail: `${cmd} is not resolvable on PATH`, fix: installFix };
}

/** `node_modules` present in the checkout (AC.2). */
export async function probeNodeModules({ cwd, stat = fsStat }) {
  const id = 'node-modules';
  try {
    await stat(join(cwd, 'node_modules'));
    return { id, status: 'ok', detail: 'node_modules present' };
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      return { id, status: 'fail', detail: 'node_modules not found in the checkout', fix: 'run pnpm install' };
    }
    throw err; // not a definitive "missing" — let runProbe degrade it to a warning
  }
}

/**
 * Board Status option keys match the keys `select.mjs` consumes (AC.2). This
 * closes a real latent bug (triage, #504): `doctor.mjs`'s board check
 * verifies configured option **ids** still resolve, but never checks that
 * `optionKey()`-normalized option **names** match `select.mjs`'s hardcoded
 * `TIER`/`SKIP` keys — a board admin renaming "In Progress" to "Doing" would
 * silently break `actionFor()` routing with zero signal.
 */
export async function probeBoardStatusKeys({ cwd, gh, loadConfigFn = loadConfig, getFields = getProjectFields }) {
  const id = 'board-status-keys';
  const cfg = await loadConfigFn(cwd);
  if (!cfg.ok) {
    return { id, status: 'warn', detail: `${cfg.errors?.[0] ?? 'forge.json invalid or missing'} — cannot verify board Status keys`, fix: 'run /forge:init, or fix .claude/forge.json (doctor.mjs already gates config validity)' };
  }
  const statusField = cfg.config.board?.fields?.status;
  if (!statusField) {
    return { id, status: 'warn', detail: 'no board.fields.status in forge.json — cannot verify Status keys', fix: 're-run /forge:init to re-discover board fields' };
  }
  const pf = await getFields(gh, cfg.config.board.projectId);
  if (!pf.ok) {
    return { id, status: 'warn', detail: `could not fetch live board fields (${pf.error})`, fix: 'confirm gh is authenticated with project scope and the project id resolves, then re-run' };
  }
  const live = Object.values(pf.fields).find((f) => f.id === statusField.id);
  if (!live) {
    return { id, status: 'fail', detail: 'the Status field id does not resolve on the live board', fix: 're-run /forge:init to re-discover board fields' };
  }
  const liveKeys = new Set((live.options ?? []).map((o) => optionKey(o.name)));
  const missing = SELECT_STATUS_KEYS.filter((k) => !liveKeys.has(k));
  if (missing.length) {
    return {
      id,
      status: 'fail',
      detail: `board Status options don't cover the keys select.mjs routes on: ${missing.join(', ')}`,
      fix: `rename the Status option(s) so they normalize (boardctx.mjs optionKey) to: ${missing.join(', ')} — or update select.mjs's TIER/SKIP if the board is authoritative`,
    };
  }
  return { id, status: 'ok', detail: 'board Status option keys match select.mjs' };
}

/** Parse the script path out of a `statusLine.command` string (two quoted argv tokens: node exe, script). */
export function parseStatuslineScriptPath(command) {
  const quoted = [...String(command ?? '').matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  return quoted[1] ?? quoted[0] ?? null;
}

/**
 * The statusline plugin path in settings exists on disk (AC.2). Closes the
 * gap `doctor.mjs`'s own `statusline` check leaves open — it only checks the
 * config key is present ("wired"), never that the path it points to still
 * resolves (a stale plugin cache path renders the bar silently blank).
 */
export async function probeStatuslinePath({ cwd, stat = fsStat, readJsonFn = readJson }) {
  const id = 'statusline-path';
  const settingsLocal = await readJsonFn(join(cwd, '.claude', 'settings.local.json')).catch(() => null);
  const settings = await readJsonFn(join(cwd, '.claude', 'settings.json')).catch(() => null);
  const statusLine = settingsLocal?.statusLine ?? settings?.statusLine;
  if (!statusLine) {
    return { id, status: 'ok', detail: 'no statusline wired — nothing to verify (doctor.mjs already advises on this separately)' };
  }
  const scriptPath = parseStatuslineScriptPath(statusLine.command);
  if (!scriptPath) {
    return { id, status: 'warn', detail: 'statusline is wired but no path could be parsed from statusLine.command', fix: 'inspect statusLine.command in .claude/settings*.json' };
  }
  try {
    await stat(scriptPath);
    return { id, status: 'ok', detail: 'statusline plugin path resolves on disk' };
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      return { id, status: 'fail', detail: `statusline plugin path does not exist: ${scriptPath}`, fix: 're-run /forge:init --statusline (or forge:statusline) to re-wire the path' };
    }
    throw err; // not a definitive "missing" — let runProbe degrade it to a warning
  }
}

/**
 * Orchestrator-facing decision (IO wrapper, AC.2/AC.4): runs all six probes
 * through `runProbe` (so a crash in any one degrades to a warning, never a
 * hard failure of the whole preflight) and maps the results through
 * `evaluateEnvPreflight`. `ctx.exec`/`ctx.gh`/`ctx.stat`/`ctx.readJson` are
 * all injectable — the only IO seam, so `probeEnv` itself stays a thin
 * composition the tests can drive with doubles (AC.6).
 */
export async function probeEnv(ctx) {
  const {
    cwd, gh, exec = run, stat = fsStat, readJsonFn = readJson,
    loadConfigFn = loadConfig, getFields = getProjectFields,
  } = ctx;

  const probes = await Promise.all([
    runProbe('gh', () => probeExecutable('gh', 'gh', exec, 'install the GitHub CLI (https://cli.github.com) and ensure gh is on PATH')),
    runProbe('node', () => probeExecutable('node', 'node', exec, 'install Node >=22.13 and ensure node is on PATH (spec §6)')),
    runProbe('pnpm', () => probeExecutable('pnpm', 'pnpm', exec, 'install pnpm (https://pnpm.io/installation) and ensure pnpm is on PATH')),
    runProbe('node-modules', () => probeNodeModules({ cwd, stat })),
    runProbe('board-status-keys', () => probeBoardStatusKeys({ cwd, gh, loadConfigFn, getFields })),
    runProbe('statusline-path', () => probeStatuslinePath({ cwd, stat, readJsonFn })),
  ]);

  return { ...evaluateEnvPreflight(probes), probes };
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  const gh = makeGh(run);
  probeEnv({ cwd: process.cwd(), gh }).then((decision) => {
    console.log(`autopilot env preflight: ${decision.verdict}`);
    if (decision.verdict === 'no-go') {
      for (const line of formatBlockers(decision.blockers)) console.log(line);
    }
    for (const w of decision.warnings) console.log(`⚠ [${w.id}] ${w.detail}${w.fix ? `  → ${w.fix}` : ''}`);
    process.exit(decision.verdict === 'go' ? 0 : 3);
  });
}
