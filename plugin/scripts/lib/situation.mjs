import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { read as readJournal } from './journal.mjs';

/**
 * Situation derivation (spec §7): computed from journal + decisions + board,
 * never set by hand. Priority: security-response > incident >
 * awaiting-decision > building > idle. (degraded/migrating/maintenance derive
 * from signals that arrive with later sub-projects.)
 */
export const SITUATIONS = {
  'security-response': { glyph: '🔒', label: 'security-response' },
  incident: { glyph: '🔥', label: 'incident' },
  'awaiting-decision': { glyph: '🚩', label: 'awaiting-decision' },
  building: { glyph: '▶', label: 'building' },
  idle: { glyph: '·', label: 'idle' },
};

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

export async function deriveSituation(cwd, board = { blocked: 0, inProgress: 0 }) {
  const journal = await readJournal(cwd);
  const events = journal.events;
  const pending = await pendingDecisions(cwd);

  let key = 'idle';
  if (lastOpen(events, (e) => e.kind === 'respond-open', (e) => e.kind === 'respond-close')) {
    key = 'security-response';
  } else if (lastOpen(events, (e) => e.kind === 'incident' && e.phase !== 'closed', (e) => e.kind === 'incident' && e.phase === 'closed')) {
    key = 'incident';
  } else if (pending.length > 0 || board.blocked > 0) {
    key = 'awaiting-decision';
  } else if (board.inProgress > 0) {
    key = 'building';
  }
  // decision files and blocked board items usually describe the same tickets — report the larger set
  const pendingCount = Math.max(pending.length, board.blocked ?? 0);
  return { key, ...SITUATIONS[key], pendingCount, pending };
}
