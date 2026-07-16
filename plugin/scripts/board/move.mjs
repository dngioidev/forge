#!/usr/bin/env node
/** board move — status transition by config key (plan T3, AC-2.2). */
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { run, makeGh } from '../lib/exec.mjs';
import { makeBoardCtx } from '../lib/boardctx.mjs';

export function parseArgs(argv) {
  const a = { issue: null, status: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--issue') a.issue = Number(argv[++i]);
    else if (argv[i] === '--status') a.status = argv[++i];
  }
  return a;
}

export async function runMove(ctx, args, log = console.log) {
  if (!Number.isInteger(args.issue)) return { ok: false, error: '--issue <number> is required' };
  const opt = ctx.resolveOption('status', args.status ?? '');
  if (!opt.ok) return { ok: false, error: opt.error };

  const found = await ctx.findItemByIssue(args.issue);
  if (!found.ok) return { ok: false, error: found.error };
  if (!found.item) return { ok: false, error: `issue #${args.issue} is not on board #${ctx.projectNumber} — run board create first` };

  if (ctx.itemFieldKey(found.item, 'status') === args.status) {
    log(`#${args.issue}: already ${args.status}`);
    return { ok: true, changed: false };
  }
  const set = await ctx.setSelect(found.item.id, 'status', args.status);
  if (!set.ok) return set;
  log(`#${args.issue}: status -> ${args.status}`);
  return { ok: true, changed: true };
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  const gh = makeGh(run);
  makeBoardCtx({ gh, cwd: process.cwd() }).then(async (ctx) => {
    if (!ctx.ok) { console.error(ctx.error); process.exit(1); }
    const res = await runMove(ctx, parseArgs(process.argv.slice(2)));
    if (!res.ok) { console.error(`move failed: ${res.error}`); process.exit(1); }
  });
}
