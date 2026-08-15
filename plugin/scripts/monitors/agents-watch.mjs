#!/usr/bin/env node
/**
 * Agent-liveness monitor (#505, epic #503) — a background watcher (plugin
 * monitors) that detects a delivery subagent that never returns at all.
 *
 * `autopilot/watchdog.mjs`'s `resolveReturnedTicket()` is return-time only —
 * it classifies a subagent's *terminal report*. A subagent that never
 * produces one (the field-evidence #457 shape: a delivery subagent died
 * silently mid-run, no notification at all, and the stall cost 5.3 hours of
 * a 6.6-hour ticket before a human noticed) is invisible to that mechanism
 * by construction: there is no report to classify. This monitor is the
 * detection layer that shape was missing — it does NOT resolve anything
 * (§ AC.5 below), it only surfaces a line to the running loop while the loop
 * is still blocked awaiting the spawn.
 *
 * Mechanism, mirroring `ci-watch.mjs`'s `writeCiWatchState`/`loadCiWatchState`
 * + monitor-poll pattern exactly: a delivered subagent best-effort writes/
 * refreshes `.forge/agents/<id>.json` (`{id, issue, branch, phase, spawnedAt,
 * lastArtifactAt}`) at spawn and at each phase change (SKILL.md § Orchestration
 * documents the call sites). This monitor polls every record under
 * `.forge/agents/`, classifies each with the pure `classifyLiveness`, and
 * emits a line only on a per-id transition into or out of `stale` — never a
 * line per poll. `clearAgentHeartbeat` is the paired cleanup the orchestrator
 * calls once a ticket's outcome is recorded, so a resolved ticket's record
 * never lingers to false-positive on a later run.
 *
 * AC.5 — the boundary with `watchdog.mjs`/#474: this module never calls
 * `resolveReturnedTicket` and never classifies a returned report. A never-
 * returned agent has no report to classify — full stop. Detection only
 * surfaces the `forge-agents` monitor line while the spawn is still in
 * flight; actually resuming/re-spawning the stalled subagent is #474's scope
 * (a `SendMessage` carrying a disk-state re-anchor), deliberately not built
 * here.
 *
 * Threshold — `DEFAULT_STALE_MS` (60 minutes), justified in
 * `docs/plans/2026-08-15-505-agent-liveness-detection.md` § Design: 6x the
 * harness's own 600s silent-stall kill floor (a shorter threshold would be
 * redundant — the harness already notifies at 600s), while comfortably above
 * every observed legitimate quiet phase (a full `pnpm verify`, a `gh pr
 * checks --watch` wait, a rebase) so a healthy run never false-positives.
 * Staleness keys on `lastArtifactAt` (elapsed-time-*without*-a-new-heartbeat),
 * not raw elapsed-since-spawn — mirrors `ci-watch.mjs`'s `queuedSince`, which
 * resets the moment the observed shape changes, so a single long phase never
 * itself reads as a stall the instant it starts.
 *
 * Honest limit (not quietly shipped — see the plan doc + PR body): a
 * heartbeat written BY the subagent is briefing-dependent, same as the
 * mechanism it exists to add a layer over. There is no documented, stable,
 * harness-side output/transcript path discoverable from a monitor process in
 * this repo today, so the cooperation-free mtime approach that diagnosed
 * #457 by hand is not buildable here. A subagent wedged badly enough to never
 * execute its own heartbeat-write call is invisible to this monitor exactly
 * as it was invisible before.
 */
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readdir } from 'node:fs/promises';
import { readJson, writeJson } from '../lib/jsonfile.mjs';
import { rm } from 'node:fs/promises';
import { freshGuard, trackFailure } from './poll-guard.mjs';

/** Relative dir this monitor reads and the delivery subagent writes to. */
export const AGENTS_DIR_RELPATH = join('.forge', 'agents');

/** Default heartbeat-staleness threshold — see module docblock § Threshold. */
export const DEFAULT_STALE_MS = 60 * 60 * 1000;

/** Path helper for one record. */
function recordPath(cwd, id) {
  return join(cwd, AGENTS_DIR_RELPATH, `${id}.json`);
}

/**
 * Best-effort heartbeat write, called by the delivery subagent itself at
 * spawn and at each phase change. Mirrors `writeCiWatchState`'s never-fail-
 * the-caller contract — a write failure must never crash or block the
 * subagent's actual work, it only means this liveness signal goes dark.
 */
export async function writeAgentHeartbeat(cwd, { id, issue, branch, phase, spawnedAt, lastArtifactAt = new Date().toISOString() }) {
  try {
    await writeJson(recordPath(cwd, id), { id, issue, branch, phase, spawnedAt, lastArtifactAt });
    return true;
  } catch {
    return false;
  }
}

/**
 * Best-effort cleanup, called by the orchestrator once a ticket's outcome is
 * recorded (§ Orchestration step 2) — so a resolved ticket's heartbeat record
 * never lingers to false-positive as "stale" on a later run. Clearing a
 * record that doesn't exist is a quiet no-op, not an error.
 */
export async function clearAgentHeartbeat(cwd, id) {
  try {
    await rm(recordPath(cwd, id), { force: true });
    return true;
  } catch {
    return false;
  }
}

/**
 * Read every heartbeat record under `.forge/agents/`. A missing dir reads as
 * `[]` (benign — no agents ever spawned this run, mirrors `readDecisions`).
 * One corrupt/unreadable record among several valid ones is skipped, not
 * fatal to the read. A genuine fs error (not ENOENT on the dir itself)
 * propagates so `poll` can surface it via the shared poll-guard (#318).
 */
export async function readAgentRecords(cwd) {
  const dir = join(cwd, AGENTS_DIR_RELPATH);
  let files;
  try {
    files = (await readdir(dir)).filter((f) => f.endsWith('.json'));
  } catch (err) {
    if (err && err.code === 'ENOENT') return [];
    throw err;
  }
  const out = [];
  for (const f of files) {
    const record = await readJson(join(dir, f)).catch(() => null);
    if (record) out.push(record);
  }
  return out;
}

/**
 * Pure liveness decision (AC.1/AC.2) — no IO, injected clock, mirrors
 * `sessionpause.mjs`'s `shouldPause` / `ratebudget.mjs`'s
 * `shouldPauseForBudget`. A missing/unparsable `lastArtifactAt` classifies
 * `unknown` rather than `stale` — fail-quiet on a malformed record, never an
 * alarm on bad data. The boundary is inclusive (age === thresholdMs → stale),
 * mirroring `shouldPause`'s `>=`.
 */
export function classifyLiveness({ record, now = Date.now(), thresholdMs = DEFAULT_STALE_MS } = {}) {
  const raw = record?.lastArtifactAt;
  const last = typeof raw === 'string' ? Date.parse(raw) : NaN;
  if (Number.isNaN(last)) {
    return { status: 'unknown', ageMs: null, reason: 'no (or unparsable) lastArtifactAt on record — cannot classify' };
  }
  const ageMs = now - last;
  if (ageMs < 0) {
    // Clock skew (a record written "in the future" relative to `now`) — treat as healthy
    // rather than manufacture a negative-age false stale.
    return { status: 'healthy', ageMs, reason: 'lastArtifactAt is ahead of now (clock skew) — treated as healthy' };
  }
  const stale = ageMs >= thresholdMs;
  return {
    status: stale ? 'stale' : 'healthy',
    ageMs,
    reason: stale
      ? `no heartbeat update in ${Math.round(ageMs / 60000)}m (>= ${Math.round(thresholdMs / 60000)}m threshold)`
      : `heartbeat is fresh (${Math.round(ageMs / 60000)}m ago, < ${Math.round(thresholdMs / 60000)}m threshold)`,
  };
}

/** Human-readable line for a per-id status transition. */
function transitionLine(record, from, to) {
  const issue = record?.issue ?? '?';
  const branch = record?.branch ?? '?';
  const phase = record?.phase ?? '?';
  if (to === 'stale') {
    return `Agent stall suspected: issue #${issue} (branch ${branch}, phase ${phase}) — no heartbeat update past the threshold`;
  }
  if (from === 'stale' && to === 'healthy') {
    return `Agent recovered: issue #${issue} (branch ${branch}) — heartbeat resumed`;
  }
  return null;
}

/**
 * Poll once. `prevStatuses` is a `Map<id,status>` threaded across polls by
 * the caller (mirrors `ci-watch.mjs`'s `prev`). Returns `{ lines, statuses,
 * ok, reason }` — a line is emitted only for an id whose status transitions
 * into or out of `stale`; `unknown` never emits (fail-quiet) and never
 * overwrites a prior known status in the returned map's transition logic
 * beyond recording it, so a later valid record still classifies normally.
 */
export async function poll(cwd, prevStatuses, { now = Date.now, thresholdMs } = {}) {
  let records;
  try {
    records = await readAgentRecords(cwd);
  } catch (err) {
    return { lines: [], statuses: prevStatuses, ok: false, reason: String(err?.message || err) };
  }
  const nowTs = now();
  const statuses = new Map();
  const lines = [];
  for (const record of records) {
    const id = record?.id ?? record?.issue;
    if (id == null) continue;
    const { status } = classifyLiveness({ record, now: nowTs, thresholdMs });
    statuses.set(id, status);
    const prev = prevStatuses instanceof Map ? prevStatuses.get(id) : undefined;
    if (status !== 'unknown' && prev !== status && (status === 'stale' || prev === 'stale')) {
      const line = transitionLine(record, prev, status);
      if (line) lines.push(line);
    }
  }
  return { lines, statuses, ok: true };
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  const argv = process.argv.slice(2);
  const val = (flag) => (argv.includes(flag) ? argv[argv.indexOf(flag) + 1] : undefined);
  const cwd = process.cwd();

  if (argv.includes('--write')) {
    const ok = await writeAgentHeartbeat(cwd, {
      id: val('--id'),
      issue: val('--issue'),
      branch: val('--branch'),
      phase: val('--phase'),
      spawnedAt: val('--spawned-at') ?? new Date().toISOString(),
    });
    console.log(ok ? `forge-agents: heartbeat written for ${val('--id')}` : 'forge-agents: heartbeat write failed (best-effort, non-fatal)');
    process.exit(0);
  } else if (argv.includes('--clear')) {
    const id = val('--clear');
    await clearAgentHeartbeat(cwd, id);
    console.log(`forge-agents: cleared heartbeat for ${id}`);
    process.exit(0);
  } else {
    const intervalMs = Number(process.env.FORGE_AGENTS_INTERVAL_MS ?? 20000);
    let statuses = new Map();
    let guard = freshGuard();
    const surface = (ok, reason) => {
      guard = trackFailure(guard, ok, { name: 'forge-agents', reason });
      if (guard.line) console.log(guard.line);
    };
    const tick = async () => {
      try {
        const r = await poll(cwd, statuses);
        statuses = r.statuses;
        for (const line of r.lines) console.log(line);
        surface(r.ok, r.reason);
      } catch (err) {
        surface(false, String(err?.message || err));
      }
      setTimeout(tick, intervalMs);
    };
    tick();
  }
}
