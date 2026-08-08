#!/usr/bin/env node
/**
 * Local GitHub outbox (#414, per the spike's grounded recommendation —
 * `docs/spikes/2026-08-08-github-outbox-design.md`). When GitHub is
 * rate-limited or an Actions outage is underway, the five queue-eligible
 * board writes (trail comments, board-status moves, merge receipts,
 * delivery-log rows, epic digests — spike §1) defer here instead of hard-
 * failing the caller, and drain back out once GitHub recovers. Every other
 * GitHub write (merges, PR creation, escalate.mjs's decision comment,
 * create.mjs, reparent.mjs, close.mjs) is out of scope by design (spike §1) —
 * this module is never imported by any of those call sites.
 *
 * State: `.forge/autopilot/outbox.json`, written via `jsonfile.mjs`'s existing
 * atomic `writeJson` (no new IO primitive). Guarded by its OWN lock —
 * `.forge/autopilot/outbox.lock` — deliberately separate from any future
 * `run.lock` (#387): different resource, different writers/readers; sharing
 * one mutex would make an outbox flush block on unrelated run.json activity
 * (and risk self-deadlock when one process both drains its own outbox and
 * calls `recordOutcome` in the same iteration). Built on the shared
 * `lib/lock.mjs` helper rather than a second copy of the same idiom.
 */
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomBytes } from 'node:crypto';
import { lstat } from 'node:fs/promises';
import { readJson, writeJson } from './jsonfile.mjs';
import { acquireLock } from './lock.mjs';
import { run, makeGh, isRateLimited, isPlatformOutage } from './exec.mjs';
import { makeBoardCtx } from './boardctx.mjs';

export const OUTBOX_RELPATH = join('.forge', 'autopilot', 'outbox.json');
export const OUTBOX_LOCK_RELPATH = join('.forge', 'autopilot', 'outbox.lock');

/**
 * Replayers for every queue-eligible op, resolved via a dynamic `import()` so
 * loading this module never eagerly loads `board/*.mjs` (which statically
 * import THIS module for `attemptOrDefer` — a real logical cycle that dynamic
 * import breaks cleanly since it's only evaluated when a drain actually
 * runs a given op, never at module-load time).
 */
// `isOutboxReplay:true` marks the ctx so `attemptOrDefer` (called again,
// inside the replayed run* function) never re-defers or recurses into another
// drain — without this a still-unreachable replay would try to enqueue a
// SECOND time while this drain still holds the lock (self-contention against
// its own lock, not a deadlock but pointless), and a success would trigger a
// redundant nested drain attempt. The replay's own ok/error result is what
// THIS module's drain loop below reasons about instead.
const REPLAYERS = {
  comment: async (ctx, args, log) => (await import('../board/comment.mjs')).runComment({ ...ctx, isOutboxReplay: true }, args, log),
  move: async (ctx, args, log) => (await import('../board/move.mjs')).runMove({ ...ctx, isOutboxReplay: true }, args, log),
  receipt: async (ctx, args, log) => (await import('../board/receipt.mjs')).runReceipt({ ...ctx, isOutboxReplay: true }, args, log),
  log: async (ctx, args, log) => (await import('../board/log.mjs')).runLog({ ...ctx, isOutboxReplay: true }, args, log),
  digest: async (ctx, args, log) => (await import('../board/digest.mjs')).runDigest({ ...ctx, isOutboxReplay: true }, args, log),
};

export const QUEUEABLE_OPS = Object.keys(REPLAYERS);

/**
 * Does this failure's error text look like GitHub being unreachable (rate
 * limit exhausted or a platform outage), as opposed to a real bug? Reuses
 * #360/#408's existing pure detectors (`isRateLimited`/`isPlatformOutage`)
 * against a synthetic `{stderr}` — the spike's own instruction is to reuse
 * these, not invent a fourth "is GitHub up" signal (§3).
 */
export function isGithubUnreachable(errorText) {
  const res = { ok: false, stderr: String(errorText ?? '') };
  return isRateLimited(res) || isPlatformOutage(res);
}

function freshOutbox() {
  return { version: 1, items: [] };
}

/**
 * Tolerant read: an absent OR corrupt outbox.json both read as empty — same
 * tolerance `ledger.mjs` applies to `run.json` (#164/#185's idiom): a
 * genuine I/O error (EACCES/EBUSY/…) still propagates, only ENOENT/SyntaxError
 * degrade to "fresh". Symlink-safe (found in review, mirrors
 * `monitors/ci-watch.mjs`'s `loadCiWatchState`): the WRITE path is already
 * symlink-safe for free (`writeJson`'s atomic rename replaces whatever
 * directory entry sits at the path, symlink or not, never dereferencing it),
 * but a plain `readJson`/`readFile` on the READ side follows a symlink — a
 * local attacker with pre-existing write access to `.forge/autopilot/` could
 * otherwise plant one to make reads (and writes, once resolved to the
 * symlink's target on the NEXT process that opens the real path fresh)
 * reflect an arbitrary file. `lstat` (no-follow) gates the read so a
 * symlinked path reads as absent/empty, same as a missing file.
 */
async function readOutbox(cwd) {
  const path = join(cwd, OUTBOX_RELPATH);
  try {
    const st = await lstat(path);
    if (st.isSymbolicLink()) return freshOutbox();
  } catch {
    return freshOutbox(); // absent (or unstattable) — readJson would treat it the same way
  }
  try {
    return (await readJson(path)) ?? freshOutbox();
  } catch (err) {
    if (err instanceof SyntaxError) return freshOutbox();
    throw err;
  }
}

/** Read-only pending count for the ledger report line and the board-status
 * field (spike §4) — never touches the lock, a read racing a concurrent
 * enqueue/drain sees either the old or new complete file (atomic writes),
 * never a torn one. */
export async function pendingCount(cwd) {
  const box = await readOutbox(cwd).catch(() => freshOutbox());
  return box.items.length;
}

/** Queue one write for later replay. Lock-guarded read-modify-write so two
 * concurrent enqueues never clobber each other (the same race #387 found in
 * `run.json`, avoided here from day one instead of inherited). */
export async function enqueue(cwd, { op, args }) {
  if (!QUEUEABLE_OPS.includes(op)) throw new Error(`outbox: unknown op '${op}' — valid: ${QUEUEABLE_OPS.join(', ')}`);
  const lock = await acquireLock(join(cwd, OUTBOX_LOCK_RELPATH));
  if (!lock.ok) return { ok: false, error: `outbox: could not lock the queue to enqueue — ${lock.error}` };
  try {
    const box = await readOutbox(cwd);
    const item = { id: `ob-${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`, op, args, queuedAt: new Date().toISOString() };
    box.items.push(item);
    await writeJson(join(cwd, OUTBOX_RELPATH), box);
    return { ok: true, id: item.id, pending: box.items.length };
  } finally {
    await lock.release();
  }
}

/**
 * Attempt a drain pass in FIFO order (oldest queued first — nothing
 * reordered, nothing dropped). Stops WITHOUT failing the moment either the
 * queue empties or a replay fails for a reachability reason (GitHub is still
 * down) — the ticket's own "no fixed ceiling" recommendation (spike §3):
 * this is an ordinary, self-resolving wait, not a decision a human can act on
 * faster by being paged. A replay failing for any OTHER reason IS a real bug
 * (a stale mutation, a malformed queued entry) — surfaced via `ok:false` so
 * the caller can escalate; the failed item and everything behind it stays
 * queued, in order, for the next attempt.
 *
 * If the lock is currently held by another process (another drain or an
 * enqueue in flight), this returns `{ok:true, lockBusy:true}` rather than
 * treating "someone else has it right now" as an error — draining is
 * opportunistic by design (spike §3), not a thing that must succeed on every
 * call.
 */
export async function drain(cwd, ctx, log = () => {}) {
  const lockPath = join(cwd, OUTBOX_LOCK_RELPATH);
  const lock = await acquireLock(lockPath);
  if (!lock.ok) return { ok: true, drained: 0, remaining: null, lockBusy: true };
  try {
    const box = await readOutbox(cwd);
    let drained = 0;
    while (box.items.length) {
      const item = box.items[0];
      const replay = REPLAYERS[item.op];
      if (!replay) {
        return { ok: false, error: `outbox: unknown queued op '${item.op}' for item ${item.id}`, drained, remaining: box.items.length, failedItem: item };
      }
      // `isOutboxReplay` (set by the REPLAYERS wrapper) makes this a plain
      // ok/error result — never `{deferred:true}` — so there's exactly two
      // outcomes to reason about here: it landed, or it didn't. A replayed
      // run* function is only shape-checked on its OWN primary key
      // (`args.issue` etc.) — a hand-corrupted queue entry with a wrong-typed
      // secondary field (e.g. a non-string `sha`) can still throw instead of
      // returning `{ok:false}` (found in review). Caught here so that's a
      // reported failure like any other, never an unhandled rejection.
      let res;
      try {
        res = await replay(ctx, item.args, log);
      } catch (err) {
        return { ok: false, error: `outbox: replay of '${item.op}' (${item.id}) threw: ${err?.message || err}`, drained, remaining: box.items.length, failedItem: item };
      }
      if (res.ok) {
        box.items.shift();
        drained++;
        await writeJson(join(cwd, OUTBOX_RELPATH), box); // persist progress incrementally — a crash mid-drain loses nothing already confirmed
        continue;
      }
      if (isGithubUnreachable(res.error)) {
        log(`outbox: drain paused — GitHub still unreachable (${box.items.length} item(s) remain queued)`);
        return { ok: true, drained, remaining: box.items.length, pausedReason: 'unreachable' };
      }
      return { ok: false, error: `outbox: replay of '${item.op}' (${item.id}) failed: ${res.error}`, drained, remaining: box.items.length, failedItem: item };
    }
    return { ok: true, drained, remaining: 0 };
  } finally {
    await lock.release();
  }
}

/**
 * Wraps one board write: try it live first (AC.1 — no behavior change when
 * GitHub is reachable, the common case). Only on a failure whose error text
 * looks like GitHub being unreachable does this queue the write instead of
 * surfacing a hard failure; any other failure (a real bug — bad input, a 404,
 * a permissions error) is returned untouched, never masked as "deferred."
 *
 * On a successful LIVE attempt, opportunistically tries to drain anything
 * already queued (spike §3's second opportunistic trigger — "immediately
 * after any outbox-owned write finally succeeds live"). Best-effort: a drain
 * hiccup here must never turn a successful write into a reported failure.
 *
 * `ctx` must carry `cwd` (every `makeBoardCtx` context does) — a `ctx` without
 * one (e.g. a bare test double) skips outbox handling entirely and returns
 * the live result as-is, deferred or not.
 */
export async function attemptOrDefer(ctx, { op, args, attempt }) {
  const res = await attempt();
  // A drain replay calls back into this same function (via the wrapped run*
  // function) — never re-defer or opportunistically drain from inside a
  // drain already in progress (see the REPLAYERS comment above). The plain
  // result flows straight back to `drain`'s own loop, which decides.
  if (ctx.isOutboxReplay) return res;
  if (res.ok) {
    if (ctx.cwd) {
      const pending = await pendingCount(ctx.cwd).catch(() => 0);
      if (pending > 0) await drain(ctx.cwd, ctx, () => {}).catch(() => {});
    }
    return res;
  }
  if (!ctx.cwd || !isGithubUnreachable(res.error)) return res;
  const q = await enqueue(ctx.cwd, { op, args });
  if (!q.ok) return { ok: false, error: `${res.error} (also failed to queue for outbox: ${q.error})` };
  return { ok: true, deferred: true, id: q.id, reason: res.error };
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  const sub = process.argv[2];
  if (sub !== 'drain') {
    console.error('usage: outbox.mjs drain');
    process.exit(1);
  }
  const gh = makeGh(run);
  makeBoardCtx({ gh, cwd: process.cwd() }).then(async (ctx) => {
    if (!ctx.ok) { console.error(ctx.error); process.exit(1); }
    const res = await drain(ctx.cwd, ctx, console.log);
    if (!res.ok) { console.error(`outbox drain failed: ${res.error}`); process.exit(1); }
    console.log(`outbox: drained ${res.drained}, ${res.remaining ?? 0} remaining${res.lockBusy ? ' (lock busy)' : ''}`);
  });
}
