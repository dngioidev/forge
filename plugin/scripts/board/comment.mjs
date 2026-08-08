#!/usr/bin/env node
/**
 * board comment — ticket-trail comment, idempotent per phase marker
 * (spec §6 ticket-trail law; plan T4, AC-2.3).
 */
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { run, makeGh } from '../lib/exec.mjs';
import { makeBoardCtx } from '../lib/boardctx.mjs';
import { upsertMarkedComment } from '../lib/issues.mjs';
import { attemptOrDefer } from '../lib/outbox.mjs';

export const PHASES = ['started', 'spec', 'plan', 'pr', 'gate-fail', 'escalation', 'ci-green', 'merged', 'note'];

export function parseArgs(argv) {
  const a = { issue: null, phase: null, body: null, actor: null, session: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--issue') a.issue = Number(argv[++i]);
    else if (argv[i] === '--phase') a.phase = argv[++i];
    else if (argv[i] === '--body') a.body = argv[++i];
    else if (argv[i] === '--actor') a.actor = argv[++i];
    else if (argv[i] === '--session') a.session = argv[++i];
  }
  return a;
}

export async function runComment(ctx, args, log = console.log) {
  if (!Number.isInteger(args.issue)) return { ok: false, error: '--issue <number> is required' };
  if (!PHASES.includes(args.phase)) return { ok: false, error: `unknown phase '${args.phase}' — valid: ${PHASES.join(', ')}` };
  if (!args.body) return { ok: false, error: '--body is required' };

  // #108: optional actor + session so a picked ticket records who + which session.
  const meta = [args.actor && `by @${args.actor}`, args.session && `session \`${args.session}\``].filter(Boolean).join(' · ');
  const content = `**forge trail** — ${args.body}${meta ? `\n\n<sub>${meta}</sub>` : ''}`;
  // #414: a pure narration write (nothing waits on it landing immediately) —
  // safe to queue and replay when GitHub recovers rather than hard-fail.
  const res = await attemptOrDefer(ctx, {
    op: 'comment',
    args,
    attempt: () => upsertMarkedComment(ctx.gh, ctx.owner, ctx.repo, args.issue, `trail:${args.phase}`, content),
  });
  if (!res.ok) return res;
  if (res.deferred) {
    log(`#${args.issue} trail:${args.phase} deferred to outbox (GitHub unreachable) — ${res.id}`);
    return res;
  }
  log(`#${args.issue} trail:${args.phase} ${res.action}`);
  return res;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  const gh = makeGh(run);
  makeBoardCtx({ gh, cwd: process.cwd() }).then(async (ctx) => {
    if (!ctx.ok) { console.error(ctx.error); process.exit(1); }
    const res = await runComment(ctx, parseArgs(process.argv.slice(2)));
    if (!res.ok) { console.error(`comment failed: ${res.error}`); process.exit(1); }
  });
}
