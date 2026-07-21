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

export async function poll(gh, prev) {
  const res = await gh(['pr', 'view', '--json', 'number,headRefName,statusCheckRollup'], { parseJson: true });
  if (!res.ok) return { prev, line: null }; // no PR for this branch yet — stay quiet
  const state = rollupState(res.json?.statusCheckRollup);
  const changed = transition(prev, state);
  if (!changed) return { prev: state, line: null };
  return { prev: state, line: `CI ${state} on PR #${res.json.number} (${res.json.headRefName})` };
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  const gh = makeGh(run);
  const intervalMs = Number(process.env.FORGE_CI_INTERVAL_MS ?? 20000);
  let prev = null;
  const tick = async () => {
    try { const r = await poll(gh, prev); prev = r.prev; if (r.line) console.log(r.line); }
    catch { /* transient gh/network error — keep watching */ }
    setTimeout(tick, intervalMs);
  };
  tick();
}
