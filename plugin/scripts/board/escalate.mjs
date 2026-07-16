#!/usr/bin/env node
/**
 * board escalate — the halt-and-ask spine (spec §7; plan T2, AC-3.2).
 * Open: ticket → blocked + decision comment + journal + pending file.
 * Check: detect the human's reply, resolve, hand the decision back.
 */
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { writeFile, mkdir } from 'node:fs/promises';
import { run, makeGh } from '../lib/exec.mjs';
import { makeBoardCtx } from '../lib/boardctx.mjs';
import { upsertMarkedComment, listComments } from '../lib/issues.mjs';
import { append as journalAppend } from '../lib/journal.mjs';
import { pendingDecisions } from '../lib/situation.mjs';
import { runMove } from './move.mjs';
import { writeJson } from '../lib/jsonfile.mjs';

export function parseArgs(argv) {
  const a = { issue: null, reason: null, options: null, recommend: null, context: '', check: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--issue') a.issue = Number(argv[++i]);
    else if (argv[i] === '--reason') a.reason = argv[++i];
    else if (argv[i] === '--options') a.options = argv[++i];
    else if (argv[i] === '--recommend') a.recommend = argv[++i];
    else if (argv[i] === '--context') a.context = argv[++i];
    else if (argv[i] === '--check') a.check = true;
  }
  return a;
}

export async function runEscalate(ctx, args, log = console.log) {
  if (!Number.isInteger(args.issue)) return { ok: false, error: '--issue <number> is required' };
  if (!args.reason) return { ok: false, error: '--reason is required' };
  const options = (args.options ?? '').split('|').map((s) => s.trim()).filter(Boolean);
  if (options.length < 2) return { ok: false, error: '--options "a|b[|c…]" needs at least two options' };

  const id = `esc-${args.issue}-${Date.now().toString(36)}`;

  const moved = await runMove(ctx, { issue: args.issue, status: 'blocked' }, () => {});
  if (!moved.ok) return moved;

  const lines = [
    `🚩 **Decision needed** (\`${id}\`)`,
    '',
    `**Why halted:** ${args.reason}`,
    ...(args.context ? ['', args.context] : []),
    '',
    '**Options:**',
    ...options.map((o, i) => `${i + 1}. ${o}${args.recommend === o || args.recommend === String(i + 1) ? ' ← **recommended**' : ''}`),
    '',
    '_Reply in this thread with your choice (number or text). The pipeline is halted until then (spec §7)._',
  ];
  const comment = await upsertMarkedComment(ctx.gh, ctx.owner, ctx.repo, args.issue, `decision:${id}`, lines.join('\n'));
  if (!comment.ok) return comment;

  await journalAppend(ctx.cwd, 'escalation', { issue: args.issue, id, reason: args.reason, options });

  await mkdir(join(ctx.cwd, '.forge', 'decisions'), { recursive: true });
  await writeJson(join(ctx.cwd, '.forge', 'decisions', `${id}.json`), {
    id, issue: args.issue, reason: args.reason, options, recommend: args.recommend ?? null,
    commentId: comment.id, status: 'pending', createdAt: new Date().toISOString(),
  });

  log(`escalated #${args.issue} (${id}) — board → blocked, decision comment posted`);
  return { ok: true, id };
}

/** Scan pending decisions for a human reply (a later comment with no forge marker). */
export async function runCheck(ctx, args, log = console.log) {
  const pending = await pendingDecisions(ctx.cwd);
  const targets = args.issue ? pending.filter((d) => d.issue === args.issue) : pending;
  if (targets.length === 0) {
    log('no pending decisions');
    return { ok: true, resolved: [] };
  }
  const resolved = [];
  for (const d of targets) {
    const list = await listComments(ctx.gh, ctx.owner, ctx.repo, d.issue);
    if (!list.ok) return list;
    const decisionIdx = list.comments.findIndex((c) => c.body?.includes(`forge:decision:${d.id}`));
    const reply = list.comments.slice(decisionIdx + 1).find((c) => !c.body?.includes('<!-- forge:'));
    if (!reply) continue;
    const answer = reply.body.trim();
    await journalAppend(ctx.cwd, 'escalation-resolved', { issue: d.issue, id: d.id, answer });
    await writeJson(join(ctx.cwd, '.forge', 'decisions', `${d.id}.json`), { ...d, status: 'resolved', answer, resolvedAt: new Date().toISOString() });
    resolved.push({ id: d.id, issue: d.issue, answer });
    log(`decision ${d.id} (#${d.issue}) resolved: ${answer.split(/\r?\n/)[0]}`);
  }
  if (resolved.length === 0) log(`${targets.length} decision(s) still pending`);
  return { ok: true, resolved };
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  const gh = makeGh(run);
  makeBoardCtx({ gh, cwd: process.cwd() }).then(async (ctx) => {
    if (!ctx.ok) { console.error(ctx.error); process.exit(1); }
    const args = parseArgs(process.argv.slice(2));
    const res = args.check ? await runCheck(ctx, args) : await runEscalate(ctx, args);
    if (!res.ok) { console.error(`escalate failed: ${res.error}`); process.exit(1); }
  });
}
