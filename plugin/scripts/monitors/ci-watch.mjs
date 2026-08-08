#!/usr/bin/env node
/**
 * CI monitor (#151) — a background watcher (plugin monitors) that polls the
 * current branch's PR checks and prints a line only when the rollup transitions,
 * so autopilot's auto-merge bar reacts to green/red instead of polling inline.
 * Each stdout line is delivered to Claude as a notification.
 *
 * #407 AC.2: this monitor and `autopilot/merge.mjs`'s pre-merge `ciGreen()`
 * re-check are two of the three independent GraphQL pollers of the same PR's
 * `statusCheckRollup` (the third is the delivery subagent's own mandated
 * `gh pr checks <pr> --watch`). The monitor now persists its last observed
 * rollup state to a small on-disk file (`writeCiWatchState`); `ciGreen()` reads
 * it back (`loadCiWatchState`) and, when it's a VERY recent known-green
 * transition for the SAME pr, satisfies the pre-merge check without firing a
 * new GraphQL call — the two processes don't share memory, so this is a file
 * hand-off, not a direct call.
 */
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { lstat } from 'node:fs/promises';
import { run, makeGh } from '../lib/exec.mjs';
import { writeJson, readJson } from '../lib/jsonfile.mjs';
import { freshGuard, trackFailure } from './poll-guard.mjs';

/** Relative path this monitor writes to and `merge.mjs`'s `ciGreen()` reads back (#407 AC.2). */
export const CI_WATCH_RELPATH = join('.forge', 'autopilot', 'ci-watch.json');

/** Best-effort persist of the last observed rollup state. A write failure must
 * never crash the monitor loop — it only means the fresh-transition shortcut
 * is unavailable next merge, not that anything is broken. `sha` (#411) is the
 * commit (`headRefOid`) this observation was taken at, so a consumer can bind
 * the reading to a specific commit instead of trusting the timestamp alone. */
export async function writeCiWatchState(cwd, { pr, state, sha = null, at = new Date().toISOString() }) {
  try {
    await writeJson(join(cwd, CI_WATCH_RELPATH), { pr, state, sha, at });
    return true;
  } catch {
    return false;
  }
}

/** Tolerant read: an absent or corrupt file both mean "no fresh data" (mirrors
 * `sessionpause.mjs`'s `loadUsage`). #411: the write path is symlink-safe
 * (atomic temp-file + rename, `jsonfile.mjs`), but a plain `readFile` follows
 * symlinks — a local attacker with pre-existing write access to `.forge/autopilot/`
 * could otherwise plant a symlink here to forge a fake green reading. `lstat`
 * (which does NOT follow links) gates the read so a symlinked path is treated
 * exactly like a missing/corrupt file — never dereferenced. */
export async function loadCiWatchState(cwd) {
  const path = join(cwd, CI_WATCH_RELPATH);
  try {
    const st = await lstat(path);
    if (st.isSymbolicLink()) return null;
  } catch {
    return null; // absent (or unstattable) — readJson would treat it the same way
  }
  try {
    return await readJson(path);
  } catch {
    return null;
  }
}

const FAIL = new Set(['FAILURE', 'ERROR', 'CANCELLED', 'TIMED_OUT', 'ACTION_REQUIRED', 'STARTUP_FAILURE']);
const DONE = new Set(['SUCCESS', 'NEUTRAL', 'SKIPPED']);

/** Reduce a checks rollup to one of pass | fail | pending (fail-closed on unknowns). */
export function rollupState(checks) {
  const arr = checks ?? [];
  if (arr.length === 0) return 'pending';
  const st = (c) => c.conclusion ?? c.state ?? c.status ?? null;
  if (arr.some((c) => FAIL.has(st(c)))) return 'fail';
  if (arr.every((c) => DONE.has(st(c)))) return 'pass';
  return 'pending';
}

/** Emit the new state only when it changed from the previous observation. */
export function transition(prev, cur) {
  return prev === cur ? null : cur;
}

/** A failed `gh pr view` that just means "no open PR for this branch yet" —
 * benign, must stay quiet and NOT count as a poll failure. Anything else
 * (auth/network/unparseable JSON) is a real error the guard should surface. */
export function isNoPr(res) {
  const s = String(res?.stderr ?? '').toLowerCase();
  return s === '' || s.includes('no pull request') || s.includes('no open pull request') || s.includes('no commits');
}

export async function poll(gh, prev) {
  const res = await gh(['pr', 'view', '--json', 'number,headRefName,headRefOid,statusCheckRollup'], { parseJson: true });
  if (!res.ok) {
    // Distinguish "no PR yet" (benign, quiet) from a standing gh failure (#318).
    if (isNoPr(res)) return { prev, pr: null, sha: null, line: null, ok: true };
    return { prev, pr: null, sha: null, line: null, ok: false, reason: String(res?.stderr || 'gh pr view failed') };
  }
  const state = rollupState(res.json?.statusCheckRollup);
  const pr = res.json?.number ?? null;
  const sha = res.json?.headRefOid ?? null; // #411: the commit this rollup reading belongs to
  const changed = transition(prev, state);
  if (!changed) return { prev: state, pr, sha, line: null, ok: true };
  return { prev: state, pr, sha, line: `CI ${state} on PR #${res.json.number} (${res.json.headRefName})`, ok: true };
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  const gh = makeGh(run);
  const intervalMs = Number(process.env.FORGE_CI_INTERVAL_MS ?? 20000);
  let prev = null;
  let guard = freshGuard();
  const surface = (ok, reason) => {
    guard = trackFailure(guard, ok, { name: 'forge-ci', reason });
    if (guard.line) console.log(guard.line);
  };
  const tick = async () => {
    try {
      const r = await poll(gh, prev);
      prev = r.prev;
      // #407 AC.2: persist every observed reading (not just transitions) so
      // ciGreen()'s freshness window always has an accurate "at" timestamp.
      // #411: also persist the commit (`sha`) this reading was taken at, so
      // ciGreen() can bind the fresh-transition shortcut to the PR's CURRENT
      // head instead of trusting the timestamp alone.
      if (r.ok && r.pr != null) await writeCiWatchState(process.cwd(), { pr: r.pr, state: r.prev, sha: r.sha });
      if (r.line) console.log(r.line);
      surface(r.ok, r.reason);
    } catch (err) {
      // Unexpected throw counts as a failed poll — the guard decides if it surfaces.
      surface(false, String(err?.message || err));
    }
    setTimeout(tick, intervalMs);
  };
  tick();
}
