#!/usr/bin/env node
/**
 * autopilot run ledger — the top-level state the loop owns (#129, spec §3/§8).
 * One JSON file per repo: what the current run has merged / escalated / skipped
 * / filed, so a fresh session resumes and the end-of-run report is exact.
 * Per-ticket state stays inside forge:deliver — this is only the run.
 */
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readJson, writeJson } from '../lib/jsonfile.mjs';
import { mergeAuthPreflight } from './preflight.mjs';

export const RUN_RELPATH = join('.forge', 'autopilot', 'run.json');
export const OUTCOMES = ['merged', 'escalated', 'skipped', 'awaiting-human'];

export function freshRun(startedAt = null) {
  return { version: 1, startedAt, iterations: 0, outcomes: [], filed: [], mergeMode: null, mergeReason: null };
}

/**
 * Read the on-disk run, tolerating a truncated/corrupt file. `writeJson` is atomic,
 * but a run.json left half-written by an older build (or hand-edited) must not wedge
 * the loop with an unhandled SyntaxError — a corrupt ledger is treated as absent (#164).
 */
async function readRun(cwd) {
  try {
    return await readJson(join(cwd, RUN_RELPATH));
  } catch (err) {
    // readJson maps a MISSING file (ENOENT) to null, but propagates a real I/O
    // error (EACCES/EIO/EBUSY/…) and a JSON.parse SyntaxError (#185). A truncated
    // or hand-corrupted ledger (SyntaxError) is treated as a fresh run; a genuine
    // read failure must surface here, not silently overwrite an in-flight run.json
    // with a fresh one. This re-throw branch is now reachable (it was dead while
    // readJson swallowed every read error as null upstream — the #185 fix).
    if (err instanceof SyntaxError) return null;
    throw err;
  }
}

export async function loadRun(cwd) {
  return (await readRun(cwd)) ?? freshRun();
}

/**
 * Pure state transition: record what happened to one ticket this iteration.
 * Last write for an issue wins (a re-run of the same ticket supersedes), so
 * the ledger is idempotent under resume. Bumps the iteration counter.
 */
export function applyOutcome(run, { issue, outcome, ref = null }) {
  if (!OUTCOMES.includes(outcome)) throw new Error(`unknown outcome '${outcome}' — valid: ${OUTCOMES.join(', ')}`);
  const outcomes = run.outcomes.filter((o) => o.issue !== issue);
  outcomes.push({ issue, outcome, ref, at: new Date().toISOString() });
  return { ...run, iterations: run.iterations + 1, outcomes };
}

/** Record a ticket the run filed mid-delivery (bug/spike/follow-up). */
export function applyFiled(run, { issue, kind, from }) {
  if (run.filed.some((f) => f.issue === issue)) return run;
  return { ...run, filed: [...run.filed, { issue, kind, from }] };
}

/**
 * Loop backstop (spec §8): a pathological file-a-ticket-per-iteration run must
 * not loop forever. Once iterations exceed board size × factor, stop and escalate.
 */
export function guardTripped(run, boardSize, factor = 2) {
  return run.iterations >= Math.max(1, boardSize) * factor;
}

export function renderReport(run) {
  const by = (o) => run.outcomes.filter((x) => x.outcome === o);
  const line = (o) => {
    const items = by(o);
    return items.length ? `  ${o}: ${items.map((x) => `#${x.issue}${x.ref ? ` (${x.ref})` : ''}`).join(', ')}` : null;
  };
  const parts = [
    `autopilot run — ${run.iterations} iteration(s)`,
    ...OUTCOMES.map(line).filter(Boolean),
    run.filed.length ? `  filed: ${run.filed.map((f) => `#${f.issue} (${f.kind})`).join(', ')}` : null,
  ].filter(Boolean);
  if (parts.length === 1) parts.push('  (nothing actionable — board was already clear)');
  return parts.join('\n');
}

// IO wrappers the loop calls.
export async function recordOutcome(cwd, entry) {
  const run = applyOutcome(await loadRun(cwd), entry);
  await writeJson(join(cwd, RUN_RELPATH), run);
  return run;
}
export async function recordFiled(cwd, entry) {
  const run = applyFiled(await loadRun(cwd), entry);
  await writeJson(join(cwd, RUN_RELPATH), run);
  return run;
}
/**
 * Begin (or resume) the run and record the merge-authorization decision (#316).
 * When `opts` carries an `authorized` flag, the run-start merge-auth preflight is
 * evaluated and its effective mode + reason are persisted into run.json so the
 * decision is auditable and the merge path can gate on it. The in-session grant is
 * NOT file-backed — a resumed/restarted session is a new session and must re-obtain
 * a live grant — so on resume we keep the original start time but REFRESH the mode
 * from the freshly re-run preflight (absent an `authorized` opt, resume is untouched).
 */
export async function startRun(cwd, opts = {}) {
  const hasAuth = Object.prototype.hasOwnProperty.call(opts, 'authorized');
  const preflight = hasAuth ? mergeAuthPreflight(opts) : null;
  const decision = preflight ? { mergeMode: preflight.mode, mergeReason: preflight.reason } : {};
  const existing = await readRun(cwd);
  if (existing?.startedAt) {
    if (!preflight) return existing; // resume — keep the original start, no new decision
    const run = { ...existing, ...decision }; // resume — re-run the (non-file-backed) preflight
    await writeJson(join(cwd, RUN_RELPATH), run);
    return run;
  }
  const run = { ...freshRun(new Date().toISOString()), ...decision };
  await writeJson(join(cwd, RUN_RELPATH), run);
  return run;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  const sub = process.argv[2];
  if (sub === 'report') {
    // A genuine read failure on an existing run.json (EACCES/EBUSY/AV-lock) now
    // propagates (#185) — catch it so it exits cleanly instead of surfacing as a
    // raw unhandled-rejection trace (#204).
    loadRun(process.cwd())
      .then((run) => console.log(renderReport(run)))
      .catch((err) => { console.error(`ledger report failed: ${err.message}`); process.exit(1); });
  } else {
    console.error('usage: ledger.mjs report');
    process.exit(1);
  }
}
