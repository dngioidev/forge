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
import { loadConfig } from '../lib/config.mjs';
import { isShaped } from './readiness.mjs';

// Tier: lower runs first. Resume-in-flight beats fresh work; ready beats backlog.
const TIER = { inProgress: 0, inReview: 0, ready: 1, backlog: 2 };
// Never selected — blocked has a pending decision; the rest are terminal.
const SKIP = new Set(['blocked', 'done', 'wontDo']);
// Umbrella types (#175) are containers, not units of work — a program/epic
// ticket is never itself deliverable, so it must never be selected regardless
// of status. normalize() already captures `type`; this is the guard that uses it.
const UMBRELLA_TYPES = new Set(['program', 'epic']);
const PRIORITY_RANK = { p0: 0, p1: 1, p2: 2 };

/**
 * status → what the loop should do with it. A backlog ticket routes on its
 * readiness (#142, spec §6): SHAPED (has acceptance) → triage/deliver; NOT shaped
 * → `shape` under crazy mode (`--shape`), else `escalate`. When readiness is
 * unknown (not computed) it falls back to the existing auto-triage front door,
 * which itself escalates a genuinely under-specified ticket — so plain autopilot
 * is unchanged.
 */
export function actionFor(status, { shape = false, ready = null } = {}) {
  if (status === 'inProgress' || status === 'inReview') return 'resume';
  if (status === 'ready') return 'deliver';
  if (status === 'backlog') {
    if (ready === false) return shape ? 'shape' : 'escalate';
    return 'triage';
  }
  return null;
}

/**
 * Pick the next actionable ticket. `tickets` are normalized:
 * `{ number, title, status, priority, area? }`. Returns `{ ticket, action }`
 * or `null` when nothing is actionable. Order: tier, then priority, then
 * FIFO (issue number as a creation-order stand-in).
 */
export function selectNext(tickets, { area = null, shape = false } = {}) {
  const actionable = tickets
    .filter((t) => !SKIP.has(t.status) && TIER[t.status] !== undefined)
    .filter((t) => !UMBRELLA_TYPES.has(t.type)) // #175: umbrella items are containers, never deliverable
    .filter((t) => (area ? t.area === area : true))
    .sort((a, b) =>
      (TIER[a.status] - TIER[b.status]) ||
      ((PRIORITY_RANK[a.priority] ?? 3) - (PRIORITY_RANK[b.priority] ?? 3)) ||
      (a.number - b.number));
  const ticket = actionable[0];
  if (!ticket) return null;
  return { ticket, action: actionFor(ticket.status, { shape, ready: ticket.ready ?? null }) };
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
    area: ctx.itemFieldKey(item, 'area'), // #146: null when the board has no Area field
  };
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  const gh = makeGh(run);
  makeBoardCtx({ gh, cwd: process.cwd() }).then(async (ctx) => {
    if (!ctx.ok) { console.error(ctx.error); process.exit(1); }
    const area = process.argv.includes('--area') ? process.argv[process.argv.indexOf('--area') + 1] : null;
    if (area && !ctx.fields.area) console.warn(`autopilot: --area ${area} given but this board has no Area field — forge:init maps one when the project has an "Area" single-select; nothing will match until then.`);
    const shape = process.argv.includes('--shape'); // crazy mode
    const list = await ctx.listItems();
    if (!list.ok) { console.error(list.error); process.exit(1); }
    const tickets = list.items.map((i) => normalize(ctx, i)).filter((t) => t.number != null);
    // #176: forge.json can extend the acceptance-heading list (localized headings);
    // load it once and thread it through so isShaped honors readiness.acHeadings.
    const cfg = await loadConfig(process.cwd());
    // Readiness routing (#142): backlog tickets branch on whether they're shaped.
    // Only the backlog set needs a body read — the rest route on status alone.
    for (const t of tickets.filter((x) => x.status === 'backlog')) {
      const view = await ctx.gh(['issue', 'view', String(t.number), '--json', 'body'], { parseJson: true });
      t.ready = view.ok ? isShaped(view.json?.body, cfg.config) : null;
    }
    const next = selectNext(tickets, { area, shape });
    if (!next) { console.log('autopilot: no actionable ticket — board is clear'); process.exit(0); }
    console.log(`next: #${next.ticket.number} [${next.ticket.status}/${next.ticket.priority ?? '—'}] → ${next.action} — ${next.ticket.title}`);
    if (process.argv.includes('--dry-run')) {
      const q = actionableQueue(tickets, { area, shape });
      console.log(`\nqueue (${q.length})${shape ? ' — crazy mode (--shape)' : ''}:`);
      for (const { ticket, action } of q) console.log(`  #${ticket.number} [${ticket.status}/${ticket.priority ?? '—'}] → ${action} — ${ticket.title}`);
    }
  });
}
