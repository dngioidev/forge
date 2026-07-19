import { readdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { read as readJournal } from './journal.mjs';

/**
 * Situation derivation (spec §7): computed from journal + decisions + board +
 * the machine kill switch, never set by hand. Priority: security-response >
 * incident > paused > awaiting-decision > building > idle. (degraded/migrating/
 * maintenance derive from signals that arrive with later sub-projects.)
 */
export const SITUATIONS = {
  'security-response': { glyph: '🔒', label: 'security-response' },
  incident: { glyph: '🔥', label: 'incident' },
  paused: { glyph: '⏸', label: 'paused' },
  'awaiting-decision': { glyph: '🚩', label: 'awaiting-decision' },
  building: { glyph: '▶', label: 'building' },
  idle: { glyph: '·', label: 'idle' },
};

/**
 * Default forge-control base — the same path C1's control plane writes to.
 * `FORGE_CONTROL_BASE` overrides it (relocates the base; and lets tests point at a
 * clean dir so they don't read the real machine kill switch — #93).
 */
export const controlBase = (home = homedir()) => process.env.FORGE_CONTROL_BASE || join(home, '.forge', 'control');

/**
 * The C1 machine kill switch: `<base>/paused` present = engaged (#68). Read
 * directly, NOT via control/lib — the distributable plugin must not depend on
 * the inner control project; they share only this file contract.
 */
export async function machinePaused(base = controlBase()) {
  try { await readFile(join(base, 'paused'), 'utf8'); return true; } catch { return false; }
}

export async function pendingDecisions(cwd) {
  const dir = join(cwd, '.forge', 'decisions');
  let files;
  try {
    files = await readdir(dir);
  } catch {
    return [];
  }
  const pending = [];
  for (const f of files.filter((f) => f.endsWith('.json'))) {
    try {
      const d = JSON.parse(await readFile(join(dir, f), 'utf8'));
      if (d.status === 'pending') pending.push(d);
    } catch { /* unreadable decision file — ignore */ }
  }
  return pending;
}

/** open = a *-open / phase:open event without a matching close after it. */
function lastOpen(events, openTest, closeTest) {
  let open = false;
  for (const e of events) {
    if (openTest(e)) open = true;
    else if (closeTest(e)) open = false;
  }
  return open;
}

export async function deriveSituation(cwd, board = { blocked: 0, inProgress: 0 }, opts = {}) {
  const journal = await readJournal(cwd);
  const events = journal.events;
  const pending = await pendingDecisions(cwd);
  // paused may be injected (tests / callers that already know); else read the flag
  // (from an injected base if given, e.g. tests — default is the real control base).
  const paused = opts.paused ?? await machinePaused(opts.controlBase ?? controlBase());

  let key = 'idle';
  if (lastOpen(events, (e) => e.kind === 'respond-open', (e) => e.kind === 'respond-close')) {
    key = 'security-response';
  } else if (lastOpen(events, (e) => e.kind === 'incident' && e.phase !== 'closed', (e) => e.kind === 'incident' && e.phase === 'closed')) {
    key = 'incident';
  } else if (paused) {
    key = 'paused';
  } else if (pending.length > 0 || board.blocked > 0) {
    key = 'awaiting-decision';
  } else if (board.inProgress > 0) {
    key = 'building';
  }
  // decision files and blocked board items usually describe the same tickets — report the larger set
  const pendingCount = Math.max(pending.length, board.blocked ?? 0);
  // `paused` is reported independent of `key` so a higher care-situation can win the
  // display while the gate still sees the machine is held.
  return { key, ...SITUATIONS[key], pendingCount, pending, paused };
}
