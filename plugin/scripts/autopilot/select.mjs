#!/usr/bin/env node
/**
 * autopilot select — "what's the next actionable ticket?" (#128, spec §5).
 * Pure selection over normalized board tickets, so the order is testable in
 * isolation from GitHub. The loop reads the board fresh each iteration and
 * asks this for the next unit of work.
 */
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { run, makeGh } from '../lib/exec.mjs';
import { makeBoardCtx } from '../lib/boardctx.mjs';

// Tier: lower runs first. Resume-in-flight beats fresh work; ready beats backlog.
const TIER = { inProgress: 0, inReview: 0, ready: 1, backlog: 2 };
// Never selected — blocked has a pending decision; the rest are terminal.
const SKIP = new Set(['blocked', 'done', 'wontDo']);
const PRIORITY_RANK = { p0: 0, p1: 1, p2: 2 };

/** status → what the loop should do with it. */
export function actionFor(status) {
  if (status === 'inProgress' || status === 'inReview') return 'resume';
  if (status === 'ready') return 'deliver';
  if (status === 'backlog') return 'triage'; // the auto-triage front door, then deliver
  return null;
}

/**
 * Pick the next actionable ticket. `tickets` are normalized:
 * `{ number, title, status, priority, area? }`. Returns `{ ticket, action }`
 * or `null` when nothing is actionable. Order: tier, then priority, then
 * FIFO (issue number as a creation-order stand-in).
 */
export function selectNext(tickets, { area = null } = {}) {
  const actionable = tickets
    .filter((t) => !SKIP.has(t.status) && TIER[t.status] !== undefined)
    .filter((t) => (area ? t.area === area : true))
    .sort((a, b) =>
      (TIER[a.status] - TIER[b.status]) ||
      ((PRIORITY_RANK[a.priority] ?? 3) - (PRIORITY_RANK[b.priority] ?? 3)) ||
      (a.number - b.number));
  const ticket = actionable[0];
  if (!ticket) return null;
  return { ticket, action: actionFor(ticket.status) };
}

/** Everything the loop could still touch, in the order it will touch it. */
export function actionableQueue(tickets, opts = {}) {
  const q = [];
  let pool = tickets;
  // selectNext is stable enough to just re-rank the whole set once:
  const ranked = [];
  let pick;
  const seen = new Set();
  while ((pick = selectNext(pool.filter((t) => !seen.has(t.number)), opts))) {
    ranked.push(pick);
    seen.add(pick.ticket.number);
  }
  return ranked;
}

/** Map a raw board item (gh project item-list) to the normalized shape. */
export function normalize(ctx, item) {
  return {
    number: item.content?.number ?? null,
    title: item.content?.title ?? item.title ?? '',
    status: ctx.itemFieldKey(item, 'status'),
    priority: ctx.itemFieldKey(item, 'priority'),
    type: ctx.itemFieldKey(item, 'type'),
  };
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  const gh = makeGh(run);
  makeBoardCtx({ gh, cwd: process.cwd() }).then(async (ctx) => {
    if (!ctx.ok) { console.error(ctx.error); process.exit(1); }
    const area = process.argv.includes('--area') ? process.argv[process.argv.indexOf('--area') + 1] : null;
    const list = await ctx.listItems();
    if (!list.ok) { console.error(list.error); process.exit(1); }
    const tickets = list.items.map((i) => normalize(ctx, i)).filter((t) => t.number != null);
    const next = selectNext(tickets, { area });
    if (!next) { console.log('autopilot: no actionable ticket — board is clear'); process.exit(0); }
    console.log(`next: #${next.ticket.number} [${next.ticket.status}/${next.ticket.priority ?? '—'}] → ${next.action} — ${next.ticket.title}`);
    if (process.argv.includes('--dry-run')) {
      const q = actionableQueue(tickets, { area });
      console.log(`\nqueue (${q.length}):`);
      for (const { ticket, action } of q) console.log(`  #${ticket.number} [${ticket.status}/${ticket.priority ?? '—'}] → ${action} — ${ticket.title}`);
    }
  });
}
