#!/usr/bin/env node
/** board log — delivery-log row on the pinned issue, one per PR (plan T6, AC-2.4b). */
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { run, makeGh } from '../lib/exec.mjs';
import { makeBoardCtx } from '../lib/boardctx.mjs';
import { upsertMarkedComment } from '../lib/issues.mjs';

export function parseArgs(argv) {
  const a = { pr: null, sha: null, title: '', issues: '', date: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--pr') a.pr = Number(argv[++i]);
    else if (argv[i] === '--sha') a.sha = argv[++i];
    else if (argv[i] === '--title') a.title = argv[++i];
    else if (argv[i] === '--issues') a.issues = argv[++i];
    else if (argv[i] === '--date') a.date = argv[++i];
  }
  return a;
}

export async function runLog(ctx, args, log = console.log) {
  if (ctx.deliveryLogIssue == null) return { ok: false, error: 'board.deliveryLogIssue not configured — run /forge:init' };
  if (!Number.isInteger(args.pr)) return { ok: false, error: '--pr is required' };
  const date = args.date ?? new Date().toISOString().slice(0, 10);
  const refs = args.issues ? args.issues.split(',').map((s) => `#${s.trim().replace(/^#/, '')}`).join(' ') : '—';
  const content = `| ${date} | #${args.pr} | ${args.sha ? `\`${args.sha.slice(0, 7)}\`` : '—'} | ${refs} | ${args.title || '—'} |`;
  const res = await upsertMarkedComment(ctx.gh, ctx.owner, ctx.repo, ctx.deliveryLogIssue, `log:pr-${args.pr}`, content);
  if (!res.ok) return res;
  log(`delivery-log row for #${args.pr} ${res.action}`);
  return res;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  const gh = makeGh(run);
  makeBoardCtx({ gh, cwd: process.cwd() }).then(async (ctx) => {
    if (!ctx.ok) { console.error(ctx.error); process.exit(1); }
    const res = await runLog(ctx, parseArgs(process.argv.slice(2)));
    if (!res.ok) { console.error(`log failed: ${res.error}`); process.exit(1); }
  });
}
