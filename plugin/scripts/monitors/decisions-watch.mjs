#!/usr/bin/env node
/**
 * Decisions monitor (#151) — a background watcher that polls .forge/decisions/
 * and prints a line the moment an escalation the human answered flips to
 * resolved, so autopilot surfaces the reply without being asked to check.
 */
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readdir } from 'node:fs/promises';
import { readJson } from '../lib/jsonfile.mjs';
import { freshGuard, trackFailure } from './poll-guard.mjs';

/** Decisions that resolved since the last observation (by id). Pure + testable. */
export function newlyResolved(prevResolvedIds, decisions) {
  return decisions.filter((d) => d?.status === 'resolved' && d?.id && !prevResolvedIds.has(d.id));
}

export async function readDecisions(cwd) {
  const dir = join(cwd, '.forge', 'decisions');
  let files;
  try { files = (await readdir(dir)).filter((f) => f.endsWith('.json')); }
  catch (err) {
    if (err && err.code === 'ENOENT') return []; // no decisions dir yet — benign, quiet
    throw err; // a real fs error (permissions/I-O) — let poll surface it (#318)
  }
  const out = [];
  for (const f of files) {
    const d = await readJson(join(dir, f)).catch(() => null);
    if (d) out.push(d);
  }
  return out;
}

/** Poll once. Returns `{ lines, ok, reason }`: `ok:false` marks a real fs error
 * so the loop's guard can surface a persistent stall instead of silently never
 * unblocking parked tickets (#318). A missing decisions dir is ok (quiet). */
export async function poll(cwd, seen) {
  let decisions;
  try { decisions = await readDecisions(cwd); }
  catch (err) { return { lines: [], ok: false, reason: String(err?.message || err) }; }
  const fresh = newlyResolved(seen, decisions);
  for (const d of fresh) seen.add(d.id);
  const lines = fresh.map((d) => `Decision ${d.id} (#${d.issue}) resolved: ${String(d.answer ?? '').split(/\r?\n/)[0]}`);
  return { lines, ok: true };
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  const cwd = process.cwd();
  const intervalMs = Number(process.env.FORGE_DECISIONS_INTERVAL_MS ?? 15000);
  const seen = new Set();
  let guard = freshGuard();
  const surface = (ok, reason) => {
    guard = trackFailure(guard, ok, { name: 'forge-decisions', reason });
    if (guard.line) console.log(guard.line);
  };
  const tick = async () => {
    try {
      const r = await poll(cwd, seen);
      for (const line of r.lines) console.log(line);
      surface(r.ok, r.reason);
    } catch (err) {
      surface(false, String(err?.message || err));
    }
    setTimeout(tick, intervalMs);
  };
  tick();
}
