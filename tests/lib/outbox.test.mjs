import { describe, it, expect } from 'vitest';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeBoardCtx } from '../../plugin/scripts/lib/boardctx.mjs';
import {
  enqueue, pendingCount, drain, attemptOrDefer, isGithubUnreachable,
  QUEUEABLE_OPS, OUTBOX_RELPATH,
} from '../../plugin/scripts/lib/outbox.mjs';
import { readJson } from '../../plugin/scripts/lib/jsonfile.mjs';
import { makeGh } from '../../plugin/scripts/lib/exec.mjs';
import { REPO_VIEW } from '../helpers/fakegh.mjs';

const noop = () => {};

/**
 * A `fakeGh`-shaped router, but with `maxRetries:0` so a rate-limit-shaped
 * response returns immediately instead of `makeGh`'s real (multi-second)
 * backoff sleeps — the shared `helpers/fakegh.mjs` always uses the live
 * default sleep, which would make the "still unreachable" tests below
 * genuinely slow (and flaky against the vitest timeout) for no test value.
 */
function fastFakeGh(routes) {
  const calls = [];
  const execFn = async (cmd, args) => {
    const joined = args.join(' ');
    calls.push(joined);
    for (const [pred, res] of routes) {
      const hit = typeof pred === 'string' ? joined.startsWith(pred) : pred(joined, args);
      if (hit) {
        const r = typeof res === 'function' ? res(joined, args) : res;
        return { ok: r.ok ?? true, code: r.code ?? (r.ok === false ? 1 : 0), stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
      }
    }
    return { ok: false, code: 1, stdout: '', stderr: `fastFakeGh: unrouted call: gh ${joined}` };
  };
  return { gh: makeGh(execFn, { sleep: async () => {}, maxRetries: 0 }), calls };
}

const CFG = {
  board: {
    projectNumber: 8,
    projectId: 'PVT_test',
    fields: {
      status: { id: 'PVTSSF_s', options: { backlog: 'sb', ready: 'sr', inProgress: 'sp', inReview: 'sv', blocked: 'sk', done: 'sd', wontDo: 'sw' } },
      priority: { id: 'PVTSSF_p', options: { p0: 'a', p1: 'b', p2: 'c' } },
      size: { id: 'PVTSSF_z', options: { xs: '1', s: '2', m: '3', l: '4', xl: '5' } },
      type: { id: 'PVTSSF_t', options: { epic: 'e', item: 'i', bug: 'g', test: 't' } },
    },
    deliveryLogIssue: 15,
  },
  team: { members: [{ github: 'dngioidev', roles: ['maintainer'] }] },
};

async function cwdWithConfig() {
  const dir = await mkdtemp(join(tmpdir(), 'forge-outbox-'));
  await mkdir(join(dir, '.claude'), { recursive: true });
  await writeFile(join(dir, '.claude', 'forge.json'), JSON.stringify(CFG), 'utf8');
  return dir;
}

async function ctxWith(routes) {
  const f = fastFakeGh([['repo view', REPO_VIEW], ...routes]);
  const ctx = await makeBoardCtx({ gh: f.gh, cwd: await cwdWithConfig() });
  expect(ctx.ok).toBe(true);
  return { ctx, calls: f.calls };
}

const RATE_LIMITED_STDERR = 'API rate limit exceeded for installation ID 123.';

describe('lib/outbox — isGithubUnreachable (pure)', () => {
  it('recognizes a rate-limit-shaped error text', () => {
    expect(isGithubUnreachable(RATE_LIMITED_STDERR)).toBe(true);
  });
  it('recognizes a platform-outage-shaped error text', () => {
    expect(isGithubUnreachable('Service Unavailable resolving action-download-info')).toBe(true);
  });
  it('does NOT treat an ordinary failure as unreachable', () => {
    expect(isGithubUnreachable('issue #9999 not found')).toBe(false);
    expect(isGithubUnreachable('')).toBe(false);
    expect(isGithubUnreachable(undefined)).toBe(false);
  });
});

describe('lib/outbox — enqueue / pendingCount', () => {
  it('QUEUEABLE_OPS is exactly the spike\'s five safe-to-defer writes', () => {
    expect(QUEUEABLE_OPS.sort()).toEqual(['comment', 'digest', 'log', 'move', 'receipt']);
  });

  it('enqueue appends, pendingCount reflects it, order is preserved (FIFO)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'forge-outbox-'));
    expect(await pendingCount(dir)).toBe(0);
    const a = await enqueue(dir, { op: 'comment', args: { issue: 1, phase: 'note', body: 'a' } });
    const b = await enqueue(dir, { op: 'comment', args: { issue: 2, phase: 'note', body: 'b' } });
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    expect(await pendingCount(dir)).toBe(2);
    const box = await readJson(join(dir, OUTBOX_RELPATH));
    expect(box.items.map((i) => i.args.issue)).toEqual([1, 2]);
    expect(box.items[0].id).not.toBe(box.items[1].id);
  });

  it('rejects an unknown op rather than silently queueing something nothing can replay', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'forge-outbox-'));
    await expect(enqueue(dir, { op: 'merge', args: {} })).rejects.toThrow(/unknown op/);
  });

  it('pendingCount tolerates a missing outbox.json (fresh repo, nothing ever queued)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'forge-outbox-'));
    expect(await pendingCount(dir)).toBe(0);
  });
});

describe('lib/outbox — drain', () => {
  it('drains queued comments in FIFO order once GitHub is reachable again, persisting progress as it goes', async () => {
    const { ctx } = await ctxWith([
      [(j) => j.includes('/comments?'), { stdout: '[]' }],
      [(j) => j.includes('/comments') && !j.includes('?') && j.includes('-f'), { stdout: JSON.stringify({ id: 1 }) }],
    ]);
    await enqueue(ctx.cwd, { op: 'comment', args: { issue: 1, phase: 'note', body: 'first' } });
    await enqueue(ctx.cwd, { op: 'comment', args: { issue: 2, phase: 'note', body: 'second' } });
    const res = await drain(ctx.cwd, ctx, noop);
    expect(res).toMatchObject({ ok: true, drained: 2, remaining: 0 });
    expect(await pendingCount(ctx.cwd)).toBe(0);
  });

  it('AC.4 — pauses (without failing) when GitHub is STILL unreachable, leaving items queued in order, no duplication', async () => {
    const { ctx, calls } = await ctxWith([
      [(j) => j.includes('/comments?'), { ok: false, stderr: RATE_LIMITED_STDERR }],
      ['api', { ok: false, stderr: RATE_LIMITED_STDERR }],
    ]);
    await enqueue(ctx.cwd, { op: 'comment', args: { issue: 1, phase: 'note', body: 'first' } });
    await enqueue(ctx.cwd, { op: 'comment', args: { issue: 2, phase: 'note', body: 'second' } });
    const res = await drain(ctx.cwd, ctx, noop);
    expect(res).toMatchObject({ ok: true, drained: 0, remaining: 2, pausedReason: 'unreachable' });
    expect(await pendingCount(ctx.cwd)).toBe(2);
    // the replay's own attemptOrDefer must NOT have re-enqueued a duplicate —
    // exactly the two original items, not four.
    const box = await readJson(join(ctx.cwd, OUTBOX_RELPATH));
    expect(box.items).toHaveLength(2);
    expect(box.items.map((i) => i.args.issue)).toEqual([1, 2]);
  });

  it('AC.4 — a replay failure for a NON-outage reason surfaces as a real bug (ok:false), item stays queued', async () => {
    const { ctx } = await ctxWith([
      [(j) => j.includes('/comments?'), { ok: false, stderr: 'HTTP 404: Not Found' }],
    ]);
    await enqueue(ctx.cwd, { op: 'comment', args: { issue: 999999, phase: 'note', body: 'x' } });
    const res = await drain(ctx.cwd, ctx, noop);
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/replay of 'comment'/);
    expect(res.remaining).toBe(1);
    expect(res.failedItem.args.issue).toBe(999999);
    expect(await pendingCount(ctx.cwd)).toBe(1); // never dropped
  });

  it('a queued item with an op this build no longer recognizes fails loudly rather than silently vanishing', async () => {
    const { ctx } = await ctxWith([]);
    // hand-craft a malformed queue entry (simulating a future/older-version op)
    const { writeJson } = await import('../../plugin/scripts/lib/jsonfile.mjs');
    await writeJson(join(ctx.cwd, OUTBOX_RELPATH), { version: 1, items: [{ id: 'ob-x', op: 'mystery-op', args: {}, queuedAt: new Date().toISOString() }] });
    const res = await drain(ctx.cwd, ctx, noop);
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/unknown queued op/);
  });

  it('empty queue drains as a clean no-op', async () => {
    const { ctx } = await ctxWith([]);
    const res = await drain(ctx.cwd, ctx, noop);
    expect(res).toMatchObject({ ok: true, drained: 0, remaining: 0 });
  });

  it('lock-busy (another drain holds it) is not an error — reports lockBusy and moves on', async () => {
    const { ctx } = await ctxWith([
      [(j) => j.includes('/comments?'), { stdout: '[]' }],
      [(j) => j.includes('/comments') && !j.includes('?') && j.includes('-f'), { stdout: JSON.stringify({ id: 1 }) }],
    ]);
    await enqueue(ctx.cwd, { op: 'comment', args: { issue: 1, phase: 'note', body: 'x' } });
    const { acquireLock } = await import('../../plugin/scripts/lib/lock.mjs');
    const { OUTBOX_LOCK_RELPATH } = await import('../../plugin/scripts/lib/outbox.mjs');
    const held = await acquireLock(join(ctx.cwd, OUTBOX_LOCK_RELPATH));
    expect(held.ok).toBe(true);
    try {
      const res = await drain(ctx.cwd, ctx, noop);
      expect(res).toMatchObject({ ok: true, drained: 0, remaining: null, lockBusy: true });
    } finally {
      await held.release();
    }
  });
});

describe('lib/outbox — attemptOrDefer (AC.1: no behavior change when GitHub is reachable)', () => {
  it('a live success passes through unchanged', async () => {
    const { ctx } = await ctxWith([]);
    const res = await attemptOrDefer(ctx, { op: 'comment', args: {}, attempt: async () => ({ ok: true, action: 'created' }) });
    expect(res).toEqual({ ok: true, action: 'created' });
  });

  it('a real (non-reachability) failure is returned untouched — never masked as deferred', async () => {
    const { ctx } = await ctxWith([]);
    const res = await attemptOrDefer(ctx, { op: 'comment', args: { issue: 1 }, attempt: async () => ({ ok: false, error: 'issue #1 not found' }) });
    expect(res).toEqual({ ok: false, error: 'issue #1 not found' });
    expect(await pendingCount(ctx.cwd)).toBe(0); // never queued
  });

  it('a reachability-shaped failure is queued instead of hard-failing the caller', async () => {
    const { ctx } = await ctxWith([]);
    const args = { issue: 1, phase: 'note', body: 'x' };
    const res = await attemptOrDefer(ctx, { op: 'comment', args, attempt: async () => ({ ok: false, error: RATE_LIMITED_STDERR }) });
    expect(res.ok).toBe(true);
    expect(res.deferred).toBe(true);
    expect(res.id).toMatch(/^ob-/);
    expect(await pendingCount(ctx.cwd)).toBe(1);
  });

  it('opportunistic drain: a live success also drains anything already queued (spike §3)', async () => {
    const { ctx } = await ctxWith([
      [(j) => j.includes('/comments?'), { stdout: '[]' }],
      [(j) => j.includes('/comments') && !j.includes('?') && j.includes('-f'), { stdout: JSON.stringify({ id: 1 }) }],
    ]);
    await enqueue(ctx.cwd, { op: 'comment', args: { issue: 7, phase: 'note', body: 'stale queued item' } });
    expect(await pendingCount(ctx.cwd)).toBe(1);
    const res = await attemptOrDefer(ctx, { op: 'comment', args: { issue: 8 }, attempt: async () => ({ ok: true, action: 'created' }) });
    expect(res).toEqual({ ok: true, action: 'created' }); // the live write's own result is unaffected
    expect(await pendingCount(ctx.cwd)).toBe(0); // and the stale queued item drained along the way
  });

  it('a replay (isOutboxReplay:true) never re-defers or recurses into a nested drain', async () => {
    const { ctx } = await ctxWith([]);
    const replayCtx = { ...ctx, isOutboxReplay: true };
    const res = await attemptOrDefer(replayCtx, { op: 'comment', args: {}, attempt: async () => ({ ok: false, error: RATE_LIMITED_STDERR }) });
    expect(res).toEqual({ ok: false, error: RATE_LIMITED_STDERR }); // plain passthrough, no enqueue attempt
    expect(await pendingCount(ctx.cwd)).toBe(0);
  });
});
