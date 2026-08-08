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
import { pendingCount } from '../lib/outbox.mjs';

/**
 * The catch-up card's underlying data (#399): the same computation `runStatus`
 * formats into CLI text, factored out so a non-CLI caller (the `board_status`
 * MCP tool) can consume it as structured JSON instead of scraping/reimplementing
 * a subset of this logic. Returns the same shape whether called from the CLI
 * path or directly.
 */
export async function computeStatus(ctx) {
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
  // Deliberately NOT trimmed here (#399 review): the CLI text line trims the whole
  // "#N title" substring as one unit (see `show` in runStatus below), which is not
  // the same as trimming the title alone first — a title with leading whitespace
  // would otherwise render with different internal spacing than before this split.
  const summarize = (i) => ({ number: i.content.number, title: i.title ?? i.content?.title ?? '' });

  const prs = await ctx.gh(['pr', 'list', '--state', 'open', '--json', 'number,title,isDraft'], { parseJson: true });
  const openPrs = (prs.ok ? prs.json : []).map((p) => ({ number: p.number, title: p.title, isDraft: !!p.isDraft }));

  const blocked = byKey.get('blocked') ?? [];
  const inProgress = byKey.get('inProgress') ?? [];
  const situation = await deriveSituation(ctx.cwd, { blocked: blocked.length, inProgress: inProgress.length });
  const next = blocked.length ? 'answer the blocked decision(s)' : openPrs.length ? 'review/merge the open PR(s)' : inProgress.length ? 'continue the in-progress work' : 'pick the next ready/backlog item';
  // #414: read-only against outbox.json's pending count (spike §4) — never
  // changes `next`/`situation`, an outbox backlog isn't a decision, it
  // resolves itself the moment GitHub answers.
  const outboxPending = ctx.cwd ? await pendingCount(ctx.cwd).catch(() => 0) : 0;

  return {
    ok: true,
    owner: ctx.owner,
    repo: ctx.repo,
    projectNumber: ctx.projectNumber,
    situation: { key: situation.key, glyph: situation.glyph, label: situation.label, pendingCount: situation.pendingCount, pending: situation.pending },
    counts: { backlog: count('backlog'), ready: count('ready'), inProgress: inProgress.length, inReview: count('inReview'), blocked: blocked.length, done: count('done') },
    blocked: blocked.map(summarize),
    inProgress: inProgress.map(summarize),
    openPrs,
    outboxPending,
    next,
  };
}

export async function runStatus(ctx, log = console.log) {
  const data = await computeStatus(ctx);
  if (!data.ok) return data;

  const lines = [];
  lines.push(`forge status — ${data.owner}/${data.repo} · board #${data.projectNumber}`);
  const { situation, counts, blocked, inProgress, openPrs, outboxPending, next } = data;
  const show = (i) => `#${i.number} ${i.title}`.trim(); // matches the original show(item) exactly
  lines.push(`situation: ${situation.glyph} ${situation.label}${situation.pendingCount ? ` (${situation.pendingCount} pending decision${situation.pendingCount > 1 ? 's' : ''})` : ''}`);
  for (const d of situation.pending) lines.push(`  🚩 decision pending: #${d.issue} — ${d.reason} (${d.id})`);
  lines.push(`counts: backlog ${counts.backlog} · ready ${counts.ready} · in-progress ${counts.inProgress} · in-review ${counts.inReview} · blocked ${counts.blocked} · done ${counts.done}`);
  for (const b of blocked) lines.push(`  🚩 blocked: ${show(b)}`);
  for (const w of inProgress) lines.push(`  ▶ in progress: ${show(w)}`);
  for (const p of openPrs) lines.push(`  ⇡ open PR: #${p.number} ${p.title}${p.isDraft ? ' (draft)' : ''}`);
  if (outboxPending) lines.push(`  📮 outbox: ${outboxPending} write(s) queued (GitHub was unreachable — not a decision, drains on its own)`);
  lines.push(`next: ${next}`);

  const text = lines.join('\n');
  log(text);
  return { ok: true, text, data };
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
