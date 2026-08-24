#!/usr/bin/env node
/** board move — status transition by config key (plan T3, AC-2.2). */
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { run, makeGh } from '../lib/exec.mjs';
import { makeBoardCtx } from '../lib/boardctx.mjs';
import { attemptOrDefer } from '../lib/outbox.mjs';

export function parseArgs(argv) {
  const a = { issue: null, status: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--issue') a.issue = Number(argv[++i]);
    else if (argv[i] === '--status') a.status = argv[++i];
  }
  return a;
}

/** Accept kebab-case status aliases (in-progress, in-review) for the camelCase config keys (#108). */
export function normalizeStatusKey(s) {
  return String(s ?? '').replace(/-([a-z])/g, (_, c) => c.toUpperCase());
}

/**
 * #178: a Projects single-select mutation can return ok yet silently NOT persist
 * (observed on iomanage #73 — the issue was CLOSED but the Status field stayed
 * put, so the post-merge ritual reported "board → Done" while the field sat at
 * Backlog). After a move we RE-READ the item and confirm the field now equals
 * the requested status. A concrete mismatch is retried once, then FAILS LOUDLY
 * rather than reporting a move that never took — a closed issue stuck at a
 * non-Done status is a reliable tell of a dropped board mutation. An unreadable
 * status (item-list index lag returning a fallback item with no field, #114)
 * can be neither confirmed nor disproved — we WARN and proceed unverified so
 * lag alone never manufactures a false failure.
 *
 * #528 (reviewer fix-wave): this re-read MUST go through `ctx.findItemFresh`
 * (the full `listItems()` scan), never `ctx.findItemByIssue`'s scoped-primary
 * path — measured live, the scoped issue-side query is NOT immediately
 * consistent for a field value THIS SAME PROCESS just mutated (a same-
 * process, zero-delay re-read via the scoped query still returned the
 * pre-mutation value). Using it here would turn this exact safety net into a
 * source of false "did NOT persist" failures.
 */
export async function verifyStatusMoved(ctx, issue, itemId, status, log = console.log) {
  let current = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    const re = await ctx.findItemFresh(issue);
    if (!re.ok) return { ok: false, error: `verify move failed: ${re.error}` };
    current = re.item ? ctx.itemFieldKey(re.item, 'status') : null;
    if (current === status) return { ok: true, verified: true };
    if (attempt === 1) {
      log(`#${issue}: status still '${current ?? 'unreadable'}' after move — retrying once`);
      const redo = await ctx.setSelect(itemId, 'status', status);
      if (!redo.ok) return { ok: false, error: redo.error };
    }
  }
  // re-read after the retry STILL doesn't match:
  if (current == null) {
    log(`#${issue}: could not confirm status moved to ${status} (item not readable on re-read) — proceeding unverified`);
    return { ok: true, verified: false };
  }
  return {
    ok: false,
    error: `move to '${status}' did NOT persist — board Status is still '${current}' after re-read (a silently-dropped Projects mutation; a closed issue stuck at '${current}' is the #73 tell). Re-run the move or fix the Status field by hand.`,
  };
}

export async function runMove(ctx, args, log = console.log) {
  if (!Number.isInteger(args.issue)) return { ok: false, error: '--issue <number> is required' };
  const status = normalizeStatusKey(args.status);
  const opt = ctx.resolveOption('status', status);
  if (!opt.ok) return { ok: false, error: opt.error };

  const found = await ctx.findItemByIssue(args.issue);
  if (!found.ok) return { ok: false, error: found.error };
  if (!found.item) return { ok: false, error: `issue #${args.issue} is not on board #${ctx.projectNumber} — run board create first` };

  if (ctx.itemFieldKey(found.item, 'status') === status) {
    log(`#${args.issue}: already ${status}`);
    return { ok: true, changed: false };
  }
  // #414: "board-status drift is already a routine, tolerated eventual-
  // consistency gap" (spike §1) — safe to queue and replay when GitHub
  // recovers rather than hard-fail the caller.
  const set = await attemptOrDefer(ctx, {
    op: 'move',
    args: { issue: args.issue, status: args.status },
    attempt: () => ctx.setSelect(found.item.id, 'status', status),
  });
  if (!set.ok) return set;
  if (set.deferred) {
    log(`#${args.issue}: move to ${status} deferred to outbox (GitHub unreachable) — ${set.id}`);
    return set;
  }
  // AC1: confirm the mutation actually took before reporting success.
  const verified = await verifyStatusMoved(ctx, args.issue, found.item.id, status, log);
  if (!verified.ok) return verified;
  log(`#${args.issue}: status -> ${status}`);
  return { ok: true, changed: true, verified: verified.verified };
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
