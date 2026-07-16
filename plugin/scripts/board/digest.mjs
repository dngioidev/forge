#!/usr/bin/env node
/**
 * board digest — epic body carries a managed block with the live child table,
 * blocked-first (plan T7, AC-2.5). Flow metrics land with SP7.
 */
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { run, makeGh } from '../lib/exec.mjs';
import { makeBoardCtx } from '../lib/boardctx.mjs';
import { getSubIssues, getIssueBody, setIssueBody } from '../lib/issues.mjs';
import { upsertBlock } from '../lib/markers.mjs';

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
      status: item?.status ?? null,
      statusKey: item ? ctx.itemFieldKey(item, 'status') : null,
      assignee: item?.assignees?.[0] ?? null,
    };
  });

  const body = await getIssueBody(ctx.gh, args.epic);
  if (!body.ok) return body;
  const updated = upsertBlock(body.body ?? '', 'digest', renderChildTable(rows));
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
