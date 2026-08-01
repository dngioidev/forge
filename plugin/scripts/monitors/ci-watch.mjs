#!/usr/bin/env node
/**
 * CI monitor (#151) — a background watcher (plugin monitors) that polls the
 * current branch's PR checks and prints a line only when the rollup transitions,
 * so autopilot's auto-merge bar reacts to green/red instead of polling inline.
 * Each stdout line is delivered to Claude as a notification.
 */
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { run, makeGh } from '../lib/exec.mjs';
import { freshGuard, trackFailure } from './poll-guard.mjs';

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
  const res = await gh(['pr', 'view', '--json', 'number,headRefName,statusCheckRollup'], { parseJson: true });
  if (!res.ok) {
    // Distinguish "no PR yet" (benign, quiet) from a standing gh failure (#318).
    if (isNoPr(res)) return { prev, line: null, ok: true };
    return { prev, line: null, ok: false, reason: String(res?.stderr || 'gh pr view failed') };
  }
  const state = rollupState(res.json?.statusCheckRollup);
  const changed = transition(prev, state);
  if (!changed) return { prev: state, line: null, ok: true };
  return { prev: state, line: `CI ${state} on PR #${res.json.number} (${res.json.headRefName})`, ok: true };
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
