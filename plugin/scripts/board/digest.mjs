#!/usr/bin/env node
/**
 * board digest — epic body carries a managed block with the live child table,
 * blocked-first (plan T7, AC-2.5), plus flow metrics computed from data the
 * board + journal already hold (spec §5; SP7 T5). Metrics we can't compute
 * honestly (backend cost — no spend data yet) are omitted, not faked.
 */
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { run, makeGh } from '../lib/exec.mjs';
import { makeBoardCtx } from '../lib/boardctx.mjs';
import { getSubIssues, getIssueBody, setIssueBody } from '../lib/issues.mjs';
import { upsertBlock } from '../lib/markers.mjs';
import { read as readJournal } from '../lib/journal.mjs';

const METRIC_KINDS = ['gate-fail', 'cmd-fail', 'blocked-edit', 'backend-fallback', 'escalation', 'incident'];

const STATUS_ORDER = ['blocked', 'inReview', 'inProgress', 'ready', 'backlog', 'done'];

export function parseArgs(argv) {
  const a = { epic: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--epic') a.epic = Number(argv[++i]);
  }
  return a;
}

export function renderChildTable(rows) {
  const lines = [
    '### Children',
    '',
    '| # | title | status | assignee | state |',
    '| --- | --- | --- | --- | --- |',
  ];
  const rank = (r) => {
    const i = STATUS_ORDER.indexOf(r.statusKey ?? '');
    return i === -1 ? STATUS_ORDER.length : i;
  };
  for (const r of [...rows].sort((a, b) => rank(a) - rank(b) || a.number - b.number)) {
    const flag = r.statusKey === 'blocked' ? ' 🚩' : '';
    lines.push(`| #${r.number} | ${r.title}${flag} | ${r.status ?? '—'} | ${r.assignee ?? '—'} | ${r.state.toLowerCase()} |`);
  }
  const blocked = rows.filter((r) => r.statusKey === 'blocked').length;
  const done = rows.filter((r) => r.statusKey === 'done').length;
  lines.push('', `${rows.length} children · ${done} done${blocked ? ` · **${blocked} blocked — needs a decision**` : ''}`);
  return lines.join('\n');
}

export function cycleDays(createdAt, closedAt) {
  if (!createdAt || !closedAt) return null;
  const ms = new Date(closedAt) - new Date(createdAt);
  return Number.isFinite(ms) && ms >= 0 ? Math.round((ms / 86_400_000) * 10) / 10 : null;
}

export function computeFlowMetrics(rows, events) {
  const shipped = rows
    .map((r) => ({ number: r.number, size: r.size ?? null, cycle: cycleDays(r.createdAt, r.closedAt) }))
    .filter((r) => r.cycle !== null);
  const sorted = shipped.map((r) => r.cycle).sort((a, b) => a - b);
  const median = sorted.length
    ? Math.round(((sorted.length % 2 ? sorted[(sorted.length - 1) / 2] : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2)) * 10) / 10
    : null;
  const counts = {};
  for (const e of events) counts[e.kind] = (counts[e.kind] ?? 0) + 1;
  return { shipped, medianCycle: median, counts };
}

export function renderFlow(metrics) {
  const lines = ['### Flow', ''];
  if (metrics.shipped.length) {
    lines.push('| # | size | cycle |', '| --- | --- | --- |');
    for (const r of metrics.shipped) lines.push(`| #${r.number} | ${r.size ?? '—'} | ${r.cycle}d |`);
    lines.push('', `median cycle: ${metrics.medianCycle}d`);
  } else {
    lines.push('_no shipped children yet — cycle times appear as children close_');
  }
  const journalLine = METRIC_KINDS.filter((k) => metrics.counts[k])
    .map((k) => `${metrics.counts[k]} ${k}`).join(' · ');
  lines.push('', `journal since last archive: ${journalLine || 'clean'}`);
  return lines.join('\n');
}

export async function runDigest(ctx, args, log = console.log) {
  if (!Number.isInteger(args.epic)) return { ok: false, error: '--epic <number> is required' };

  const sub = await getSubIssues(ctx.gh, ctx.owner, ctx.repo, args.epic);
  if (!sub.ok) return sub;
  const list = await ctx.listItems();
  if (!list.ok) return list;
  const byNumber = new Map(list.items.map((i) => [i.content?.number, i]));

  const rows = sub.children.map((c) => {
    const item = byNumber.get(c.number);
    return {
      number: c.number,
      title: c.title,
      state: c.state,
      createdAt: c.createdAt ?? null,
      closedAt: c.closedAt ?? null,
      status: item?.status ?? null,
      statusKey: item ? ctx.itemFieldKey(item, 'status') : null,
      assignee: item?.assignees?.[0] ?? null,
      size: item?.size ?? null,
    };
  });

  const journal = await readJournal(ctx.cwd, { kinds: METRIC_KINDS });
  const flow = renderFlow(computeFlowMetrics(rows, journal.events));

  const body = await getIssueBody(ctx.gh, args.epic);
  if (!body.ok) return body;
  const updated = upsertBlock(body.body ?? '', 'digest', `${renderChildTable(rows)}\n\n${flow}`);
  if (updated === body.body) {
    log(`digest: #${args.epic} unchanged`);
    return { ok: true, changed: false, rows: rows.length };
  }
  const set = await setIssueBody(ctx.gh, args.epic, updated);
  if (!set.ok) return set;
  log(`digest: #${args.epic} refreshed (${rows.length} children)`);
  return { ok: true, changed: true, rows: rows.length };
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  const gh = makeGh(run);
  makeBoardCtx({ gh, cwd: process.cwd() }).then(async (ctx) => {
    if (!ctx.ok) { console.error(ctx.error); process.exit(1); }
    const res = await runDigest(ctx, parseArgs(process.argv.slice(2)));
    if (!res.ok) { console.error(`digest failed: ${res.error}`); process.exit(1); }
  });
}
