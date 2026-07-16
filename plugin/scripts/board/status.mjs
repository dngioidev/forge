#!/usr/bin/env node
/**
 * board status — minimal catch-up card from board + PR data (plan T8, AC-2.6).
 * Situation derivation + journal events upgrade this at SP3 (spec §7).
 */
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { run, makeGh } from '../lib/exec.mjs';
import { makeBoardCtx } from '../lib/boardctx.mjs';
import { deriveSituation } from '../lib/situation.mjs';

export async function runStatus(ctx, log = console.log) {
  const list = await ctx.listItems();
  if (!list.ok) return list;
  const items = list.items.filter((i) => i.content?.number != null);

  const byKey = new Map();
  for (const i of items) {
    const key = ctx.itemFieldKey(i, 'status') ?? 'none';
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(i);
  }
  const count = (k) => (byKey.get(k) ?? []).length;
  const show = (i) => `#${i.content.number} ${i.title ?? i.content?.title ?? ''}`.trim();

  const prs = await ctx.gh(['pr', 'list', '--state', 'open', '--json', 'number,title,isDraft'], { parseJson: true });
  const openPrs = prs.ok ? prs.json : [];

  const lines = [];
  lines.push(`forge status — ${ctx.owner}/${ctx.repo} · board #${ctx.projectNumber}`);
  const blocked = byKey.get('blocked') ?? [];
  const situation = await deriveSituation(ctx.cwd, { blocked: blocked.length, inProgress: count('inProgress') });
  lines.push(`situation: ${situation.glyph} ${situation.label}${situation.pendingCount ? ` (${situation.pendingCount} pending decision${situation.pendingCount > 1 ? 's' : ''})` : ''}`);
  for (const d of situation.pending) lines.push(`  🚩 decision pending: #${d.issue} — ${d.reason} (${d.id})`);
  lines.push(`counts: backlog ${count('backlog')} · ready ${count('ready')} · in-progress ${count('inProgress')} · in-review ${count('inReview')} · blocked ${blocked.length} · done ${count('done')}`);
  for (const b of blocked) lines.push(`  🚩 blocked: ${show(b)}`);
  for (const w of byKey.get('inProgress') ?? []) lines.push(`  ▶ in progress: ${show(w)}`);
  for (const p of openPrs) lines.push(`  ⇡ open PR: #${p.number} ${p.title}${p.isDraft ? ' (draft)' : ''}`);
  lines.push(`next: ${blocked.length ? 'answer the blocked decision(s)' : openPrs.length ? 'review/merge the open PR(s)' : count('inProgress') ? 'continue the in-progress work' : 'pick the next ready/backlog item'}`);

  const text = lines.join('\n');
  log(text);
  return { ok: true, text };
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  const gh = makeGh(run);
  makeBoardCtx({ gh, cwd: process.cwd() }).then(async (ctx) => {
    if (!ctx.ok) { console.error(ctx.error); process.exit(1); }
    const res = await runStatus(ctx);
    if (!res.ok) { console.error(`status failed: ${res.error}`); process.exit(1); }
  });
}
