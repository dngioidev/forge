#!/usr/bin/env node
/** board receipt — merge receipt per issue, idempotent (plan T5, AC-2.4a). */
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { run, makeGh } from '../lib/exec.mjs';
import { makeBoardCtx } from '../lib/boardctx.mjs';
import { upsertMarkedComment } from '../lib/issues.mjs';

export function parseArgs(argv) {
  const a = { issue: null, pr: null, sha: null, title: '' };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--issue') a.issue = Number(argv[++i]);
    else if (argv[i] === '--pr') a.pr = Number(argv[++i]);
    else if (argv[i] === '--sha') a.sha = argv[++i];
    else if (argv[i] === '--title') a.title = argv[++i];
  }
  return a;
}

export async function runReceipt(ctx, args, log = console.log) {
  if (!Number.isInteger(args.issue) || !Number.isInteger(args.pr)) {
    return { ok: false, error: '--issue and --pr are required' };
  }
  const sha = args.sha ? ` → \`${args.sha.slice(0, 7)}\`` : '';
  const content = `**forge receipt** — merged via #${args.pr}${sha}${args.title ? ` — ${args.title}` : ''}`;
  const res = await upsertMarkedComment(ctx.gh, ctx.owner, ctx.repo, args.issue, `receipt:pr-${args.pr}`, content);
  if (!res.ok) return res;
  log(`#${args.issue} receipt:pr-${args.pr} ${res.action}`);
  return res;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  const gh = makeGh(run);
  makeBoardCtx({ gh, cwd: process.cwd() }).then(async (ctx) => {
    if (!ctx.ok) { console.error(ctx.error); process.exit(1); }
    const res = await runReceipt(ctx, parseArgs(process.argv.slice(2)));
    if (!res.ok) { console.error(`receipt failed: ${res.error}`); process.exit(1); }
  });
}
