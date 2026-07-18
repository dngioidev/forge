#!/usr/bin/env node
/**
 * forge-control runner entrypoint (C2/#62). Thin daemon shell around the loop in
 * lib/runner.mjs. Deliberately NOT a control.mjs verb: the owner's control
 * vocabulary (enqueue/pause/kill/...) stays an allowlist that can't spawn — the
 * runner is the thing being controlled, started by the owner, not a command.
 *
 *   runner.mjs            drain the queue once through, then exit (one-shot)
 *   runner.mjs --loop     keep looping (a stub sleep between drains)
 *   runner.mjs --once     run exactly one entry
 *
 * Respects the C1 paused flag: if paused, it spawns nothing and exits.
 */
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { work } from './lib/runner.mjs';

export const defaultBase = (home = homedir()) => join(home, '.forge', 'control');

const isMain = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  const argv = process.argv.slice(2);
  const once = argv.includes('--once');
  work(defaultBase(), { once }).then((results) => {
    for (const r of results) {
      if (r.skipped) console.log(`runner: idle (${r.skipped})`);
      else console.log(`runner: ${r.entry?.id} → ${r.outcome}${r.killedReason ? ` (${r.killedReason})` : ''}`);
    }
  }).catch((err) => { console.error(`runner: ${err?.message || err}`); process.exit(1); });
}
