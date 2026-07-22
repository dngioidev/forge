#!/usr/bin/env node
/**
 * board close (#117) — close an issue for a special reason and reflect it on
 * the board honestly. `completed` → Done; `not-planned`/`not-needed`/
 * `superseded`/`duplicate` → a NOT_PLANNED GitHub close + the **Won't do**
 * status (not "Done" — it wasn't done). Posts a `trail:closed` note.
 * Idempotent: re-running on an already-closed issue just reconciles the board.
 */
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { run, makeGh } from '../lib/exec.mjs';
import { makeBoardCtx } from '../lib/boardctx.mjs';
import { upsertMarkedComment } from '../lib/issues.mjs';
import { verifyStatusMoved } from './move.mjs';

/** reason → GitHub close reason + board status key + human label. */
export const REASONS = {
  completed: { ghReason: 'completed', status: 'done', label: 'completed' },
  'not-planned': { ghReason: 'not planned', status: 'wontDo', label: 'not planned' },
  'not-needed': { ghReason: 'not planned', status: 'wontDo', label: 'not needed' },
  superseded: { ghReason: 'not planned', status: 'wontDo', label: 'superseded' },
  duplicate: { ghReason: 'not planned', status: 'wontDo', label: 'duplicate' },
};

export function parseArgs(argv) {
  const a = { issue: null, reason: null, note: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--issue') a.issue = Number(argv[++i]);
    else if (argv[i] === '--reason') a.reason = argv[++i];
    else if (argv[i] === '--note') a.note = argv[++i];
  }
  return a;
}

export async function runClose(ctx, args, log = console.log) {
  if (!Number.isInteger(args.issue)) return { ok: false, error: '--issue <number> is required' };
  const spec = REASONS[args.reason];
  if (!spec) return { ok: false, error: `--reason must be one of: ${Object.keys(REASONS).join(', ')}` };

  // the target board status must exist (Won't do needs the option present)
  const opt = ctx.resolveOption('status', spec.status);
  if (!opt.ok) return { ok: false, error: `${opt.error} — run forge:init to add the '${spec.status}' status option` };

  // 1. close the issue (idempotent)
  const view = await ctx.gh(['issue', 'view', String(args.issue), '--json', 'state'], { parseJson: true });
  if (!view.ok) return { ok: false, error: view.stderr || 'issue view failed' };
  if (view.json.state !== 'CLOSED') {
    const closed = await ctx.gh(['issue', 'close', String(args.issue), '--reason', spec.ghReason]);
    if (!closed.ok) return { ok: false, error: closed.stderr || 'issue close failed' };
    log(`#${args.issue}: closed (${spec.ghReason})`);
  } else {
    log(`#${args.issue}: already closed`);
  }

  // 2. reflect on the board (findItemByIssue has the lag fallback)
  const found = await ctx.findItemByIssue(args.issue);
  if (!found.ok) return { ok: false, error: found.error };
  if (found.item) {
    const set = await ctx.setSelect(found.item.id, 'status', spec.status);
    if (!set.ok) return { ok: false, error: set.error };
    // #201: the close path is exactly where the #73 silent-drop was observed —
    // a Projects single-select mutation can return ok yet never persist. Re-read
    // and confirm via the #178 helper: FAIL LOUDLY on a confirmed stuck status
    // (don't report a board reconcile that didn't take), WARN-and-proceed on an
    // unreadable re-read (item-list lag) so lag alone never false-fails a close.
    const verified = await verifyStatusMoved(ctx, args.issue, found.item.id, spec.status, log);
    if (!verified.ok) return { ok: false, error: verified.error };
    log(`#${args.issue}: board status -> ${spec.status}`);
  } else {
    log(`#${args.issue}: not on the board (status not set)`);
  }

  // 3. trail note
  const body = `**closed — ${spec.label}.**${args.note ? ` ${args.note}` : ''}`;
  const note = await upsertMarkedComment(ctx.gh, ctx.owner, ctx.repo, args.issue, 'trail:closed', `**forge trail** — ${body}`);
  if (!note.ok) return note;
  log(`#${args.issue} trail:closed ${note.action}`);
  return { ok: true, issue: args.issue, reason: args.reason, status: spec.status };
}

/**
 * Batch wrapper over runClose. `args.issue` may be a comma-separated string
 * (`'12,13'`) or a single value. Validates `--reason` ONCE up front so a bad
 * reason fails fast with no GitHub call. A single issue delegates to runClose
 * and returns its shape verbatim; two or more loop per-issue, continuing past
 * failures, and return a `{ ok, closed, failed, results }` summary.
 */
export async function runCloseBatch(ctx, args, log = console.log) {
  if (!REASONS[args.reason]) {
    return { ok: false, error: `--reason must be one of: ${Object.keys(REASONS).join(', ')}` };
  }
  // strict per-token parsing: split on ',', trim, require positive integers.
  // no silent drops — an empty list or ANY bad token fails before any GitHub call
  // (a lax parse would let '--issue abc' collapse to [] → a no-op reported as
  // success, and empty/whitespace tokens would become issue 0 via Number('')).
  const tokens = String(args.issue ?? '').split(',').map((s) => s.trim());
  const bad = tokens.find((t) => !/^\d+$/.test(t));
  if (bad !== undefined) {
    return { ok: false, error: `--issue must be one or more positive integers, got '${bad}'` };
  }
  const issues = tokens.map((t) => Number(t));

  if (issues.length === 1) return runClose(ctx, { ...args, issue: issues[0] }, log);

  const results = [];
  let closed = 0; let failed = 0;
  for (const n of issues) {
    const r = await runClose(ctx, { ...args, issue: n }, log);
    if (r.ok) closed++; else { failed++; log(`  ✗ #${n}: ${r.error}`); }
    results.push({ ...r, issue: n });
  }
  log(`batch: ${closed} closed, ${failed} failed of ${issues.length}`);
  return { ok: failed === 0, closed, failed, results };
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  const gh = makeGh(run);
  makeBoardCtx({ gh, cwd: process.cwd() }).then(async (ctx) => {
    if (!ctx.ok) { console.error(ctx.error); process.exit(1); }
    const raw = process.argv.slice(2);
    // keep --issue usable for both single and batch: pull the raw string here so
    // runCloseBatch can split on ',' (parseArgs coerces to a single Number).
    const idx = raw.indexOf('--issue');
    const args = parseArgs(raw);
    if (idx !== -1 && raw[idx + 1] !== undefined) args.issue = raw[idx + 1];
    const res = await runCloseBatch(ctx, args);
    if (!res.ok) { console.error(`close failed: ${res.error}`); process.exit(1); }
  });
}
