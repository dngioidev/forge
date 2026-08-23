#!/usr/bin/env node
/**
 * board comment — ticket-trail comment, idempotent per phase marker
 * (spec §6 ticket-trail law; plan T4, AC-2.3).
 */
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { run, makeGh } from '../lib/exec.mjs';
import { makeBoardCtx } from '../lib/boardctx.mjs';
import { upsertMarkedComment } from '../lib/issues.mjs';
import { attemptOrDefer } from '../lib/outbox.mjs';

export const PHASES = ['started', 'spec', 'plan', 'pr', 'gate-fail', 'escalation', 'ci-green', 'merged', 'note'];

const KNOWN_FLAGS = '--issue --phase --body --body-file --actor --session';

export function parseArgs(argv) {
  const a = { issue: null, phase: null, body: null, bodyFile: null, actor: null, session: null, unknownFlags: [] };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--issue') a.issue = Number(argv[++i]);
    else if (k === '--phase') a.phase = argv[++i];
    else if (k === '--body') a.body = argv[++i];
    else if (k === '--body-file') a.bodyFile = argv[++i];
    else if (k === '--actor') a.actor = argv[++i];
    else if (k === '--session') a.session = argv[++i];
    else a.unknownFlags.push(k); // #557 (AC-4): never silently drop — mirrors create.mjs (#104)
  }
  return a;
}

export async function runComment(ctx, args, log = console.log) {
  // #557 (AC-4): fail-fast on unrecognized flags rather than dropping them
  // silently, matching create.mjs's existing behaviour (#104).
  if (args.unknownFlags?.length) {
    return { ok: false, error: `unrecognized flag(s): ${args.unknownFlags.join(', ')} — supported: ${KNOWN_FLAGS}` };
  }
  if (!Number.isInteger(args.issue)) return { ok: false, error: '--issue <number> is required' };
  if (!PHASES.includes(args.phase)) return { ok: false, error: `unknown phase '${args.phase}' — valid: ${PHASES.join(', ')}` };
  // #557 (AC-3): --body and --body-file are mutually exclusive, resolved as a
  // hard error rather than one silently winning — a caller who passes both
  // gets told immediately instead of guessing which one landed.
  if (args.body && args.bodyFile) {
    return { ok: false, error: '--body and --body-file are mutually exclusive — pass one, not both' };
  }
  // #557 (AC-2): --body-file reads the comment body from a file, same
  // semantics (and the same read-error message shape) as create.mjs's
  // --body-file (#104) — this is the mechanism the denylist literal-string
  // mitigation every skill prescribes actually depends on for a trail comment.
  if (args.bodyFile) {
    try { args = { ...args, body: await readFile(args.bodyFile, 'utf8') }; }
    catch (e) { return { ok: false, error: `--body-file: cannot read ${args.bodyFile}: ${e.message}` }; }
  }
  if (!args.body) return { ok: false, error: '--body or --body-file is required' };

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
