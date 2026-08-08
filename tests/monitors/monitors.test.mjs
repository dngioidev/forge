import { describe, it, expect } from 'vitest';
import { readFile, mkdtemp, mkdir, writeFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { rollupState, transition, poll as ciPoll, isNoPr, writeCiWatchState, loadCiWatchState, CI_WATCH_RELPATH, allQueued } from '../../plugin/scripts/monitors/ci-watch.mjs';
import { newlyResolved, poll as decisionsPoll } from '../../plugin/scripts/monitors/decisions-watch.mjs';
import { probeReachable, poll as outboxPoll } from '../../plugin/scripts/monitors/outbox-watch.mjs';
import { trackFailure, freshGuard, FAILURE_THRESHOLD, REEMIT_EVERY } from '../../plugin/scripts/monitors/poll-guard.mjs';
import { makeBoardCtx } from '../../plugin/scripts/lib/boardctx.mjs';
import { makeGh } from '../../plugin/scripts/lib/exec.mjs';
import { enqueue, pendingCount } from '../../plugin/scripts/lib/outbox.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

describe('CI monitor (#151)', () => {
  it('reduces a checks rollup to pass | fail | pending (fail-closed)', () => {
    expect(rollupState([])).toBe('pending');
    expect(rollupState([{ conclusion: 'SUCCESS' }, { conclusion: 'SKIPPED' }])).toBe('pass');
    expect(rollupState([{ conclusion: 'SUCCESS' }, { conclusion: 'FAILURE' }])).toBe('fail');
    expect(rollupState([{ conclusion: 'SUCCESS' }, { status: 'IN_PROGRESS', conclusion: null }])).toBe('pending');
    expect(rollupState([{ state: 'ERROR' }])).toBe('fail');
  });

  it('emits only on a state change', () => {
    expect(transition('pending', 'pending')).toBe(null);
    expect(transition('pending', 'pass')).toBe('pass');
    expect(transition(null, 'fail')).toBe('fail');
  });

  it('poll stays quiet with no PR, and reports the transition when checks land', async () => {
    const quiet = await ciPoll(async () => ({ ok: false }), null);
    expect(quiet.line).toBe(null);
    const gh = async () => ({ ok: true, json: { number: 42, headRefName: 'feat/x', headRefOid: 'aaa111', statusCheckRollup: [{ conclusion: 'SUCCESS' }] } });
    const first = await ciPoll(gh, null);
    expect(first.line).toMatch(/CI pass on PR #42 \(feat\/x\)/);
    expect(first.pr).toBe(42); // #407 AC.2: poll() now surfaces the pr number so the caller can persist it
    expect(first.sha).toBe('aaa111'); // #411: poll() also surfaces the commit this rollup reading belongs to
    const second = await ciPoll(gh, first.prev); // unchanged → silent
    expect(second.line).toBe(null);
    expect(second.pr).toBe(42);
    expect(second.sha).toBe('aaa111');
  });

  // #407 AC.2 — the monitor persists its last observed state so merge.mjs's
  // ciGreen() can thread a very-recent known-green transition into the
  // pre-merge check instead of firing a redundant GraphQL re-fetch.
  describe('ci-watch state persistence (AC-407.2)', () => {
    it('writeCiWatchState -> loadCiWatchState round-trips {pr, state, sha, at}', async () => {
      const cwd = await mkdtemp(join(tmpdir(), 'forge-ciwatch-'));
      expect(await loadCiWatchState(cwd)).toBeNull(); // absent -> null, never throws
      await writeCiWatchState(cwd, { pr: 9, state: 'pass', sha: 'aaa111' });
      const loaded = await loadCiWatchState(cwd);
      expect(loaded.pr).toBe(9);
      expect(loaded.state).toBe('pass');
      expect(loaded.sha).toBe('aaa111'); // #411: the commit this reading was taken at
      expect(typeof loaded.at).toBe('string'); // defaulted to "now" when the caller omits it
      expect(Date.parse(loaded.at)).not.toBeNaN();
    });

    it('writeCiWatchState defaults sha to null when the caller omits it', async () => {
      const cwd = await mkdtemp(join(tmpdir(), 'forge-ciwatch-'));
      await writeCiWatchState(cwd, { pr: 9, state: 'pass' });
      expect((await loadCiWatchState(cwd)).sha).toBeNull();
    });

    it('loadCiWatchState tolerates a corrupt file — never throws', async () => {
      const cwd = await mkdtemp(join(tmpdir(), 'forge-ciwatch-'));
      await mkdir(dirname(join(cwd, CI_WATCH_RELPATH)), { recursive: true });
      await writeFile(join(cwd, CI_WATCH_RELPATH), '{not json', 'utf8');
      await expect(loadCiWatchState(cwd)).resolves.toBeNull();
    });

    it('a later writeCiWatchState overwrites the earlier reading (only the latest transition matters)', async () => {
      const cwd = await mkdtemp(join(tmpdir(), 'forge-ciwatch-'));
      await writeCiWatchState(cwd, { pr: 9, state: 'pending' });
      await writeCiWatchState(cwd, { pr: 9, state: 'pass' });
      expect((await loadCiWatchState(cwd)).state).toBe('pass');
    });

    // #411 — the write path was already symlink-safe (atomic temp-file + rename);
    // the read path used a plain `readFile`, which DOES follow symlinks. A local
    // attacker with pre-existing write access to `.forge/autopilot/` could plant
    // a symlink at the ci-watch.json path pointing at attacker-controlled content
    // to forge a fake green reading. `loadCiWatchState` must never dereference it.
    it('loadCiWatchState never follows a symlink planted at the state path', async () => {
      const cwd = await mkdtemp(join(tmpdir(), 'forge-ciwatch-'));
      const targetDir = await mkdtemp(join(tmpdir(), 'forge-ciwatch-target-'));
      const target = join(targetDir, 'forged.json');
      await writeFile(target, JSON.stringify({ pr: 9, state: 'pass', sha: 'forged-sha', at: new Date().toISOString() }));
      const linkPath = join(cwd, CI_WATCH_RELPATH);
      await mkdir(dirname(linkPath), { recursive: true });
      try {
        await symlink(target, linkPath, 'file');
      } catch (err) {
        // Symlink creation needs elevated privilege on some platforms (notably
        // Windows without Developer Mode/admin) — the guard itself is exercised
        // by the platforms that CAN create one; skip rather than false-fail here.
        if (err?.code === 'EPERM' || err?.code === 'EACCES') return;
        throw err;
      }
      await expect(loadCiWatchState(cwd)).resolves.toBeNull(); // never dereferenced — treated as absent, not as the forged content
    });
  });
});

// #408 — GitHub Actions platform-outage detection on the CI-watch path.
describe('CI monitor — platform-outage detection (AC-408.1/AC-408.4, #408)', () => {
  it('allQueued: true only when every check is QUEUED; false on empty, mixed, or in-progress', () => {
    expect(allQueued([])).toBe(false);
    expect(allQueued([{ status: 'QUEUED' }, { status: 'QUEUED' }])).toBe(true);
    expect(allQueued([{ status: 'queued' }])).toBe(true); // case-insensitive
    expect(allQueued([{ status: 'QUEUED' }, { status: 'IN_PROGRESS' }])).toBe(false);
    expect(allQueued([{ conclusion: 'SUCCESS' }])).toBe(false);
  });

  it('poll suspects an outage once a fully-queued rollup crosses the threshold, using its own clock', async () => {
    const gh = async () => ({ ok: true, json: { number: 7, headRefName: 'feat/y', statusCheckRollup: [{ status: 'QUEUED' }, { status: 'QUEUED' }] } });
    let now = 1_000_000;
    const clock = () => now;
    const first = await ciPoll(gh, null, { now: clock, stuckQueuedMs: 60_000 });
    expect(first.queuedSince).toBe(1_000_000);
    expect(first.line).toMatch(/CI pending on PR #7/); // ordinary null->pending transition; not stuck yet
    now += 30_000; // still under threshold
    const second = await ciPoll(gh, first.prev, { queuedSince: first.queuedSince, outageReported: first.outageReported, now: clock, stuckQueuedMs: 60_000 });
    expect(second.line).toBe(null);
    now += 40_000; // now 70s queued, past the 60s threshold
    const third = await ciPoll(gh, second.prev, { queuedSince: second.queuedSince, outageReported: second.outageReported, now: clock, stuckQueuedMs: 60_000 });
    expect(third.outage).toBe(true);
    expect(third.line).toMatch(/CI outage-suspected on PR #7 \(feat\/y\)/);
    expect(third.line).toMatch(/stuck queued/);
    expect(third.line).not.toMatch(/^CI pending/); // not the ordinary transition line
  });

  it('reports the outage line at most once per stuck episode (no per-poll spam)', async () => {
    const gh = async () => ({ ok: true, json: { number: 7, headRefName: 'feat/y', statusCheckRollup: [{ status: 'QUEUED' }] } });
    let now = 0;
    const clock = () => now;
    let state = await ciPoll(gh, null, { now: clock, stuckQueuedMs: 1000 });
    now = 2000; // past threshold
    state = await ciPoll(gh, state.prev, { queuedSince: state.queuedSince, outageReported: state.outageReported, now: clock, stuckQueuedMs: 1000 });
    expect(state.outage).toBe(true);
    now = 4000; // still stuck, well past threshold — must NOT re-emit
    state = await ciPoll(gh, state.prev, { queuedSince: state.queuedSince, outageReported: state.outageReported, now: clock, stuckQueuedMs: 1000 });
    expect(state.outage).toBe(false);
    expect(state.line).toBe(null);
  });

  it('queuedSince and the outage flag reset the moment the rollup stops being all-queued', async () => {
    let now = 0;
    const clock = () => now;
    const stuckGh = async () => ({ ok: true, json: { number: 7, headRefName: 'feat/y', statusCheckRollup: [{ status: 'QUEUED' }] } });
    let state = await ciPoll(stuckGh, null, { now: clock, stuckQueuedMs: 1000 });
    now = 5000;
    state = await ciPoll(stuckGh, state.prev, { queuedSince: state.queuedSince, outageReported: state.outageReported, now: clock, stuckQueuedMs: 1000 });
    expect(state.outage).toBe(true);
    const progressedGh = async () => ({ ok: true, json: { number: 7, headRefName: 'feat/y', statusCheckRollup: [{ status: 'IN_PROGRESS' }] } });
    state = await ciPoll(progressedGh, state.prev, { queuedSince: state.queuedSince, outageReported: state.outageReported, now: clock, stuckQueuedMs: 1000 });
    expect(state.queuedSince).toBe(null);
    expect(state.outageReported).toBe(false);
  });

  it('a real fail transition still emits the ordinary CI fail line, not an outage line', async () => {
    const gh = async () => ({ ok: true, json: { number: 7, headRefName: 'feat/y', statusCheckRollup: [{ conclusion: 'FAILURE' }] } });
    const r = await ciPoll(gh, null);
    expect(r.line).toMatch(/CI fail on PR #7/);
    expect(r.outage).toBe(false);
  });
});

describe('decisions monitor (#151)', () => {
  it('emits a resolved decision once, never a pending one', () => {
    const seen = new Set();
    const decisions = [
      { id: 'a', issue: 1, status: 'pending' },
      { id: 'b', issue: 2, status: 'resolved', answer: 'option 2\nmore' },
    ];
    const fresh = newlyResolved(seen, decisions);
    expect(fresh.map((d) => d.id)).toEqual(['b']);
    fresh.forEach((d) => seen.add(d.id));
    expect(newlyResolved(seen, decisions)).toEqual([]); // already surfaced
  });
});

// #414 — outbox monitor: mirrors forge-ci/forge-decisions' poll-transition
// idiom, but for `.forge/autopilot/outbox.json`'s pending count. Reuses
// #407/#408's isRateLimited/isPlatformOutage detectors for reachability
// rather than inventing a new signal (spike §3).
describe('outbox monitor (#414)', () => {
  const RATE_LIMITED = { ok: false, code: 1, stdout: '', stderr: 'API rate limit exceeded for installation ID 123.' };
  const REPO_VIEW = { ok: true, stdout: JSON.stringify({ owner: { login: 'dngioidev' }, name: 'forge', defaultBranchRef: { name: 'main' } }) };
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

  async function ctxWithRoutes(routes) {
    const dir = await mkdtemp(join(tmpdir(), 'forge-outbox-watch-'));
    await mkdir(join(dir, '.claude'), { recursive: true });
    await writeFile(join(dir, '.claude', 'forge.json'), JSON.stringify(CFG), 'utf8');
    const execFn = async (cmd, args) => {
      const joined = args.join(' ');
      for (const [pred, res] of [['repo view', REPO_VIEW], ...routes]) {
        const hit = typeof pred === 'string' ? joined.startsWith(pred) : pred(joined, args);
        if (hit) return typeof res === 'function' ? res(joined, args) : res;
      }
      return { ok: false, code: 1, stdout: '', stderr: `unrouted: gh ${joined}` };
    };
    const gh = makeGh(execFn, { sleep: async () => {}, maxRetries: 0 });
    const ctx = await makeBoardCtx({ gh, cwd: dir });
    expect(ctx.ok).toBe(true);
    return ctx;
  }

  describe('probeReachable', () => {
    it('a successful rate_limit probe means reachable', async () => {
      const ctx = await ctxWithRoutes([['api rate_limit', { ok: true, stdout: '{}' }]]);
      expect(await probeReachable(ctx.gh)).toEqual({ ok: true, reachable: true });
    });
    it('a rate-limited probe response means NOT reachable, but is not itself an error', async () => {
      const ctx = await ctxWithRoutes([['api rate_limit', RATE_LIMITED]]);
      expect(await probeReachable(ctx.gh)).toEqual({ ok: true, reachable: false });
    });
    it('a platform-outage-shaped probe failure also means NOT reachable', async () => {
      const ctx = await ctxWithRoutes([['api rate_limit', { ok: false, stderr: 'Service Unavailable resolving action-download-info' }]]);
      expect(await probeReachable(ctx.gh)).toEqual({ ok: true, reachable: false });
    });
    it('any other probe failure is a real error, not a reachability signal', async () => {
      const ctx = await ctxWithRoutes([['api rate_limit', { ok: false, stderr: 'authentication required' }]]);
      const r = await probeReachable(ctx.gh);
      expect(r).toMatchObject({ ok: false, reachable: false });
      expect(r.reason).toMatch(/authentication required/);
    });
  });

  describe('poll', () => {
    it('an empty queue is cheap and silent — no gh call at all', async () => {
      const ctx = await ctxWithRoutes([]); // no rate_limit route registered — a call here would 404 the test
      const r = await outboxPoll(ctx, 0);
      expect(r).toMatchObject({ ok: true, line: null, prevPending: 0 });
    });

    it('draining to empty from a nonzero prevPending emits exactly one "drained" line', async () => {
      const ctx = await ctxWithRoutes([]);
      const r = await outboxPoll(ctx, 3);
      expect(r).toMatchObject({ ok: true, line: 'forge-outbox: drained — 0 item(s) queued', prevPending: 0 });
    });

    it('pending + unreachable emits a line only on a transition, silent when unchanged', async () => {
      const ctx = await ctxWithRoutes([['api rate_limit', RATE_LIMITED]]);
      await enqueue(ctx.cwd, { op: 'comment', args: { issue: 1, phase: 'note', body: 'x' } });
      const first = await outboxPoll(ctx, 0);
      expect(first).toMatchObject({ ok: true, prevPending: 1, line: 'forge-outbox: 1 item(s) queued (GitHub unreachable)' });
      const second = await outboxPoll(ctx, first.prevPending);
      expect(second).toMatchObject({ ok: true, prevPending: 1, line: null }); // unchanged — silent
    });

    it('pending + reachable drains and reports the new remaining count', async () => {
      const ctx = await ctxWithRoutes([
        ['api rate_limit', { ok: true, stdout: '{}' }],
        [(j) => j.includes('/comments?'), { ok: true, stdout: '[]' }],
        [(j) => j.includes('/comments') && !j.includes('?') && j.includes('-f'), { ok: true, stdout: JSON.stringify({ id: 1 }) }],
      ]);
      await enqueue(ctx.cwd, { op: 'comment', args: { issue: 1, phase: 'note', body: 'x' } });
      const r = await outboxPoll(ctx, 1);
      expect(r).toMatchObject({ ok: true, prevPending: 0, line: 'forge-outbox: drained — 0 item(s) queued' });
      expect(await pendingCount(ctx.cwd)).toBe(0);
    });

    it('a non-outage drain failure is surfaced immediately as an escalation-worthy line', async () => {
      const ctx = await ctxWithRoutes([
        ['api rate_limit', { ok: true, stdout: '{}' }],
        [(j) => j.includes('/comments?'), { ok: false, stderr: 'HTTP 404: Not Found' }],
      ]);
      await enqueue(ctx.cwd, { op: 'comment', args: { issue: 999999, phase: 'note', body: 'x' } });
      const r = await outboxPoll(ctx, 1);
      expect(r.ok).toBe(true); // the POLL itself didn't crash — it reports the failure as a line
      expect(r.drainFailed).toBe(true);
      expect(r.line).toMatch(/drain failed/);
      expect(r.line).toMatch(/escalation warranted/);
    });
  });
});

describe('monitor persistent-error surfacing (#318)', () => {
  // Drive the pure guard over a poll sequence, collecting every surfaced line.
  const drive = (results, name = 'forge-ci') => {
    let guard = freshGuard();
    const lines = [];
    for (const ok of results) {
      guard = trackFailure(guard, ok, { name, reason: 'boom' });
      if (guard.line) lines.push(guard.line);
    }
    return { guard, lines };
  };

  it('AC-318.1: N consecutive failures surface exactly one error line, polling continues', () => {
    const seq = Array(FAILURE_THRESHOLD).fill(false); // exactly N failed polls
    const { lines, guard } = drive(seq);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toBe(`forge-ci error: boom (${FAILURE_THRESHOLD} consecutive polls)`);
    expect(guard.fails).toBe(FAILURE_THRESHOLD); // the loop kept counting — it did not stop
  });

  it('AC-318.1: a lasting outage is throttled — not one line per poll', () => {
    const { lines } = drive(Array(FAILURE_THRESHOLD + REEMIT_EVERY).fill(false));
    // one at the threshold, one more after REEMIT_EVERY further failures — never spam
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain(`(${FAILURE_THRESHOLD + REEMIT_EVERY} consecutive polls)`);
  });

  it('AC-318.2: a single/transient failure surfaces nothing', () => {
    expect(drive([false]).lines).toEqual([]);
    expect(drive(Array(FAILURE_THRESHOLD - 1).fill(false)).lines).toEqual([]); // still under threshold
  });

  it('AC-318.2: a success resets the counter — an occasional blip never accumulates', () => {
    // fail just below threshold, recover, repeat: the reset means we never surface.
    const blips = [];
    for (let i = 0; i < 4; i++) { for (let j = 0; j < FAILURE_THRESHOLD - 1; j++) blips.push(false); blips.push(true); }
    const { lines, guard } = drive(blips);
    expect(lines).toEqual([]);
    expect(guard.fails).toBe(0); // last poll was a success → clean slate
  });

  it('AC-318.2: ci poll marks a real gh failure ok:false but stays ok on no-PR', async () => {
    const authFail = await ciPoll(async () => ({ ok: false, stderr: 'gh: To authenticate, run: gh auth login' }), null);
    expect(authFail.ok).toBe(false);
    expect(authFail.line).toBe(null); // poll itself is silent; the guard decides surfacing
    const noPr = await ciPoll(async () => ({ ok: false, stderr: 'no pull requests found for branch "x"' }), null);
    expect(noPr.ok).toBe(true);
    expect(isNoPr({ stderr: '' })).toBe(true); // empty stderr treated as benign no-PR
  });

  it('AC-318.1: decisions poll marks a real fs error ok:false (and stays ok normally)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'forge-dec-'));
    // .forge/decisions as a FILE, not a dir → readdir throws ENOTDIR (a real fs error)
    await mkdir(join(dir, '.forge'), { recursive: true });
    await writeFile(join(dir, '.forge', 'decisions'), 'not a dir');
    const bad = await decisionsPoll(dir, new Set());
    expect(bad.ok).toBe(false);
    expect(bad.lines).toEqual([]);

    // a healthy poll keeps the { lines, ok:true } shape and still emits resolved lines
    const good = await mkdtemp(join(tmpdir(), 'forge-dec-'));
    await mkdir(join(good, '.forge', 'decisions'), { recursive: true });
    await writeFile(join(good, '.forge', 'decisions', 'd1.json'), JSON.stringify({ id: 'd1', issue: 9, status: 'resolved', answer: 'go' }));
    const ok = await decisionsPoll(good, new Set());
    expect(ok.ok).toBe(true);
    expect(ok.lines).toEqual(['Decision d1 (#9) resolved: go']);
  });
});

describe('monitors manifest', () => {
  it('declares the three autopilot watchers with when: on-skill-invoke:autopilot', async () => {
    const arr = JSON.parse(await readFile(join(root, 'plugin', 'monitors', 'monitors.json'), 'utf8'));
    expect(arr).toHaveLength(3);
    for (const m of arr) {
      expect(m.name && m.command && m.description).toBeTruthy();
      expect(m.command).toContain('${CLAUDE_PLUGIN_ROOT}');
      expect(m.when).toBe('on-skill-invoke:autopilot');
    }
    expect(arr.map((m) => m.name).sort()).toEqual(['forge-ci', 'forge-decisions', 'forge-outbox']);
  });
});
