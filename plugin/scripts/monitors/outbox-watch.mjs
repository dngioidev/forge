#!/usr/bin/env node
/**
 * Outbox monitor (#414) — a background watcher (plugin monitors) for
 * autopilot's local GitHub outbox (`.forge/autopilot/outbox.json`,
 * `lib/outbox.mjs`). Mirrors the existing `forge-ci`/`forge-decisions`
 * monitor idiom (`plugin/skills/autopilot/SKILL.md` § Monitor notifications):
 * poll, emit exactly one line to the running loop only on a state
 * transition, throttled error surfacing after a few consecutive failures
 * (#318's poll-guard). This is the background half of the outbox's two-part
 * drain trigger (spike §3) — the other half is the opportunistic drain
 * `lib/outbox.mjs`'s `attemptOrDefer` already runs right after any live
 * outbox-owned write succeeds.
 */
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { run, makeGh, isRateLimited, isPlatformOutage } from '../lib/exec.mjs';
import { makeBoardCtx } from '../lib/boardctx.mjs';
import { pendingCount, drain } from '../lib/outbox.mjs';
import { freshGuard, trackFailure } from './poll-guard.mjs';

/**
 * Is GitHub reachable right now? Reuses #407/#408's existing detectors
 * (`isRateLimited`/`isPlatformOutage`) against a cheap `gh api rate_limit`
 * probe — the same call `rateBudget()` already makes, itself free (doesn't
 * count against any bucket) — rather than inventing a fourth "is GitHub up"
 * signal (spike §3). A probe failure that neither detector recognizes is a
 * real error (auth/network), not a reachability signal — surfaced to the
 * poll guard like any other persistent failure.
 */
export async function probeReachable(gh) {
  const res = await gh(['api', 'rate_limit']);
  if (res.ok) return { ok: true, reachable: true };
  if (isRateLimited(res) || isPlatformOutage(res)) return { ok: true, reachable: false };
  return { ok: false, reachable: false, reason: res.stderr || 'rate_limit probe failed' };
}

/**
 * One poll. Cheap when the queue is empty (no reachability probe fired at
 * all). Emits a line only when the pending count actually changes from
 * `prevPending` — never once per 20s poll while steady-state. A drain that
 * fails for a non-outage reason surfaces immediately (not throttled by the
 * poll guard, which is for reachability noise, not a confirmed replay bug) —
 * that is the ticket's own "escalate only on a non-outage drain failure"
 * trigger (spike §3), left for the loop to act on.
 */
export async function poll(ctx, prevPending, log = () => {}) {
  const pending = await pendingCount(ctx.cwd);
  if (pending === 0) {
    return { prevPending: 0, line: prevPending > 0 ? 'forge-outbox: drained — 0 item(s) queued' : null, ok: true };
  }
  const reach = await probeReachable(ctx.gh);
  if (!reach.ok) return { prevPending: pending, line: null, ok: false, reason: reach.reason };
  if (!reach.reachable) {
    const line = prevPending !== pending ? `forge-outbox: ${pending} item(s) queued (GitHub unreachable)` : null;
    return { prevPending: pending, line, ok: true };
  }
  const res = await drain(ctx.cwd, ctx, log);
  if (!res.ok) {
    return {
      prevPending: pending,
      line: `forge-outbox: drain failed — ${res.error} (a real bug, not GitHub being down — escalation warranted)`,
      ok: true,
      drainFailed: true,
      failedItem: res.failedItem,
    };
  }
  const remaining = res.remaining ?? pending;
  const line = remaining !== prevPending
    ? (remaining === 0 ? 'forge-outbox: drained — 0 item(s) queued' : `forge-outbox: ${remaining} item(s) still queued`)
    : null;
  return { prevPending: remaining, line, ok: true };
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  const gh = makeGh(run);
  const intervalMs = Number(process.env.FORGE_OUTBOX_INTERVAL_MS ?? 20000);
  let guard = freshGuard();
  const surface = (ok, reason) => {
    guard = trackFailure(guard, ok, { name: 'forge-outbox', reason });
    if (guard.line) console.log(guard.line);
  };
  makeBoardCtx({ gh, cwd: process.cwd() }).then((ctx) => {
    if (!ctx.ok) { console.error(ctx.error); process.exit(1); }
    let prevPending = 0;
    const tick = async () => {
      try {
        const r = await poll(ctx, prevPending, () => {});
        prevPending = r.prevPending;
        if (r.line) console.log(r.line);
        surface(r.ok, r.reason);
      } catch (err) {
        surface(false, String(err?.message || err));
      }
      setTimeout(tick, intervalMs);
    };
    tick();
  });
}
