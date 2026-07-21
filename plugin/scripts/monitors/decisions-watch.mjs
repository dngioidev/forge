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

/** Decisions that resolved since the last observation (by id). Pure + testable. */
export function newlyResolved(prevResolvedIds, decisions) {
  return decisions.filter((d) => d?.status === 'resolved' && d?.id && !prevResolvedIds.has(d.id));
}

export async function readDecisions(cwd) {
  const dir = join(cwd, '.forge', 'decisions');
  let files;
  try { files = (await readdir(dir)).filter((f) => f.endsWith('.json')); }
  catch { return []; }
  const out = [];
  for (const f of files) {
    const d = await readJson(join(dir, f)).catch(() => null);
    if (d) out.push(d);
  }
  return out;
}

export async function poll(cwd, seen) {
  const decisions = await readDecisions(cwd);
  const fresh = newlyResolved(seen, decisions);
  for (const d of fresh) seen.add(d.id);
  return fresh.map((d) => `Decision ${d.id} (#${d.issue}) resolved: ${String(d.answer ?? '').split(/\r?\n/)[0]}`);
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  const cwd = process.cwd();
  const intervalMs = Number(process.env.FORGE_DECISIONS_INTERVAL_MS ?? 15000);
  const seen = new Set();
  const tick = async () => {
    try { for (const line of await poll(cwd, seen)) console.log(line); }
    catch { /* transient fs error — keep watching */ }
    setTimeout(tick, intervalMs);
  };
  tick();
}
