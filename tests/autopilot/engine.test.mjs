import { describe, it, expect, vi } from 'vitest';
import { mkdtemp, readFile, writeFile, mkdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { selectNext, actionFor, actionableQueue, normalize } from '../../plugin/scripts/autopilot/select.mjs';
import { evaluateMergeBar, autoMergeEnabled, ciGreen, runMerge, BAR_SIGNALS } from '../../plugin/scripts/autopilot/merge.mjs';
import { applyOutcome, applyFiled, guardTripped, renderReport, freshRun, startRun, recordOutcome, loadRun, RUN_RELPATH } from '../../plugin/scripts/autopilot/ledger.mjs';
import { toType, fileWork, KIND_TO_TYPE } from '../../plugin/scripts/autopilot/newwork.mjs';
import { isShaped, DEFAULT_AC_HEADINGS } from '../../plugin/scripts/autopilot/readiness.mjs';
import { ALLOW, permsBlock } from '../../plugin/scripts/autopilot/perms.mjs';

const t = (number, status, priority = 'p1') => ({ number, status, priority, title: `#${number}` });

describe('autopilot selection (#128, AC-1/AC-2)', () => {
  it('resume-in-flight beats ready beats backlog; within a tier, p0<p1<p2 then FIFO', () => {
    const tickets = [
      t(5, 'backlog', 'p0'), t(4, 'ready', 'p2'), t(3, 'ready', 'p0'),
      t(2, 'inReview', 'p2'), t(1, 'done', 'p0'),
    ];
    // inReview (resume tier) wins despite low priority
    expect(selectNext(tickets).ticket.number).toBe(2);
    // drop the resume ticket → best ready by priority (p0 #3), not the backlog p0
    expect(selectNext(tickets.filter((x) => x.number !== 2)).ticket.number).toBe(3);
  });

  it('maps status → action (resume/deliver/triage) and never selects terminal/blocked', () => {
    expect(actionFor('inProgress')).toBe('resume');
    expect(actionFor('inReview')).toBe('resume');
    expect(actionFor('ready')).toBe('deliver');
    expect(actionFor('backlog')).toBe('triage'); // the auto-triage front door
    expect(selectNext([t(1, 'done'), t(2, 'wontDo'), t(3, 'blocked')])).toBeNull();
  });

  it('backlog is selectable but routed through triage first (AC-2 front door)', () => {
    const pick = selectNext([t(9, 'backlog', 'p1')]);
    expect(pick.action).toBe('triage');
  });

  it('area filter narrows the pool; queue is the full ordered plan', () => {
    const tickets = [{ ...t(1, 'ready'), area: 'ui' }, { ...t(2, 'ready'), area: 'api' }];
    expect(selectNext(tickets, { area: 'api' }).ticket.number).toBe(2);
    expect(actionableQueue(tickets).map((q) => q.ticket.number)).toEqual([1, 2]);
  });

  it('#146: normalize populates area so --area actually filters (was a no-op)', () => {
    const ctx = { itemFieldKey: (item, key) => item[key] ?? null };
    const item = { content: { number: 5, title: 't' }, status: 'ready', priority: 'p1', area: 'api' };
    expect(normalize(ctx, item)).toMatchObject({ number: 5, status: 'ready', area: 'api' });
    // no Area field on the board → area is null, not undefined
    expect(normalize({ itemFieldKey: () => null }, { content: { number: 6 } }).area).toBe(null);
  });
});

describe('umbrella-type exclusion (#175, AC1/AC2)', () => {
  const u = (number, status, type) => ({ ...t(number, status), type });

  it('AC1: a program/epic ticket is never selected, in any status', () => {
    for (const status of ['inProgress', 'ready', 'backlog']) {
      for (const type of ['program', 'epic']) {
        expect(selectNext([u(1, status, type)])).toBeNull();
      }
    }
  });

  it('AC2: umbrella items are excluded across tiers while deliverable siblings remain', () => {
    const tickets = [
      u(1, 'inProgress', 'program'),
      u(2, 'ready', 'epic'),
      u(3, 'backlog', 'program'),
      { ...t(4, 'ready'), type: 'bug' },
    ];
    // only the bug survives — despite the program sitting in the higher resume tier
    expect(selectNext(tickets).ticket.number).toBe(4);
    expect(actionableQueue(tickets).map((q) => q.ticket.number)).toEqual([4]);
  });

  it('a non-umbrella (or untyped) ticket is still selectable', () => {
    expect(selectNext([{ ...t(1, 'ready'), type: 'feature' }]).ticket.number).toBe(1);
    expect(selectNext([t(1, 'ready')]).ticket.number).toBe(1); // type undefined → not umbrella
  });
});

describe('crazy-mode readiness routing (#142, AC-1)', () => {
  it('isShaped detects acceptance criteria (Acceptance section or AC-ids)', () => {
    expect(isShaped('## Acceptance\n- AC-1: does X')).toBe(true);
    expect(isShaped('blah\n### acceptance criteria\n...')).toBe(true);
    expect(isShaped('needs AC-12 to hold')).toBe(true);
    expect(isShaped('just a one-line idea, no shape')).toBe(false);
    expect(isShaped('')).toBe(false);
    expect(isShaped(undefined)).toBe(false);
  });

  // #176: localized (non-English) acceptance-criteria headings.
  it('AC1: a body whose only AC section is under a built-in localized heading is shaped', () => {
    // Vietnamese built-ins — the iomanage language policy.
    expect(isShaped('## Tiêu chí nghiệm thu\n- làm X')).toBe(true);
    expect(isShaped('### Tiêu chí chấp nhận\n...')).toBe(true);
    // case-insensitive + Unicode-safe (lowercased diacritics still match).
    expect(isShaped('## tiêu chí nghiệm thu\n...')).toBe(true);
    // built-in list is exported and carries the Vietnamese headings.
    expect(DEFAULT_AC_HEADINGS).toEqual(expect.arrayContaining(['Tiêu chí nghiệm thu', 'Tiêu chí chấp nhận']));
    // NFD-encoded body (macOS/IME authoring) matches the same visible heading.
    expect(isShaped('## Tiêu chí nghiệm thu\n- x'.normalize('NFD'))).toBe(true);
    // no false positive: a heading that merely starts with a built-in word.
    expect(isShaped('## Acceptances of the plan were noted')).toBe(false);
    // English + AC-id behavior is unchanged.
    expect(isShaped('## Acceptance\n- AC-1: does X')).toBe(true);
    expect(isShaped('needs AC-12 to hold')).toBe(true);
  });

  it('AC2/AC3: the heading list is extensible via forge.json (readiness.acHeadings) without a code change', () => {
    const config = { readiness: { acHeadings: ['Критерии приёмки', 'Definition of Done'] } };
    // a custom config-supplied heading is recognized...
    expect(isShaped('## Критерии приёмки\n- пункт', config)).toBe(true);
    expect(isShaped('## Definition of Done\n- item', config)).toBe(true);
    // ...without disabling the built-ins.
    expect(isShaped('## Tiêu chí nghiệm thu\n...', config)).toBe(true);
    expect(isShaped('## Acceptance\n...', config)).toBe(true);
    // an unknown heading (not built-in, not configured) is still unshaped.
    expect(isShaped('## Критерии приёмки\n...')).toBe(false);
    // a malformed/missing readiness block is tolerated, not thrown.
    expect(isShaped('## Acceptance', { readiness: null })).toBe(true);
    expect(isShaped('## Acceptance', {})).toBe(true);
    expect(isShaped('## Acceptance', { readiness: { acHeadings: 'nope' } })).toBe(true);
  });

  it('an UNSHAPED backlog ticket → shape under --shape, escalate without it', () => {
    const unshaped = { ...t(1, 'backlog'), ready: false };
    expect(selectNext([unshaped], { shape: true }).action).toBe('shape');
    expect(selectNext([unshaped], { shape: false }).action).toBe('escalate');
  });

  it('a SHAPED (or unknown) backlog ticket keeps the triage front door — default unchanged', () => {
    expect(selectNext([{ ...t(1, 'backlog'), ready: true }], { shape: true }).action).toBe('triage');
    expect(selectNext([t(1, 'backlog')], { shape: true }).action).toBe('triage'); // ready unknown → triage
    expect(actionFor('backlog')).toBe('triage'); // back-compat: no opts
  });
});

describe('autopilot merge bar (#127, AC-3) — the trust reversal', () => {
  const allGreen = { ship: true, gates: true, reviewer: true, security: true, ci: true };

  it('merges only when every one of the five signals is green', () => {
    expect(evaluateMergeBar(allGreen).merge).toBe(true);
    expect(BAR_SIGNALS).toEqual(['ship', 'gates', 'reviewer', 'security', 'ci']);
  });

  it('NOTHING merges on red — any missing/false signal blocks (fail-closed)', () => {
    for (const s of BAR_SIGNALS) {
      const signals = { ...allGreen, [s]: false };
      const bar = evaluateMergeBar(signals);
      expect(bar.merge, `${s}=false should block the merge`).toBe(false);
      expect(bar.blockedOn).toContain(s);
    }
    // a signal simply absent is also red, not assumed-green
    expect(evaluateMergeBar({ ship: true }).merge).toBe(false);
  });

  it('a critical finding forces an escalation regardless of the other signals', () => {
    const bar = evaluateMergeBar(allGreen, { critical: true });
    expect(bar.merge).toBe(false);
    expect(bar.escalate).toBe(true);
    expect(bar.blockedOn).toContain('security:critical');
  });

  it('features.autopilotAutoMerge defaults ON, false parks at the PR', () => {
    expect(autoMergeEnabled({})).toBe(true);
    expect(autoMergeEnabled({ features: {} })).toBe(true);
    expect(autoMergeEnabled({ features: { autopilotAutoMerge: false } })).toBe(false);
  });

  it('ciGreen is fail-closed: empty rollup is NOT green; a failure is NOT green', async () => {
    const gh = (json) => async () => ({ ok: true, json });
    expect((await ciGreen(gh({ statusCheckRollup: [] }))).green).toBe(false);
    expect((await ciGreen(gh({ statusCheckRollup: [{ conclusion: 'SUCCESS' }, { conclusion: 'FAILURE', name: 'x' }] }))).green).toBe(false);
    expect((await ciGreen(gh({ statusCheckRollup: [{ conclusion: 'SUCCESS' }, { conclusion: 'SKIPPED' }] }))).green).toBe(true);
  });

  it('runMerge: disabled → park; bar red → no merge call; all green → squash-merge', async () => {
    const calls = [];
    const gh = async (args) => {
      calls.push(args.join(' '));
      if (args[0] === 'pr' && args[1] === 'view') return { ok: true, json: { statusCheckRollup: [{ conclusion: 'SUCCESS' }] } };
      return { ok: true };
    };
    // disabled
    const parked = await runMerge({ config: { features: { autopilotAutoMerge: false } }, gh }, { issue: 1, pr: 9, signals: {} }, () => {});
    expect(parked).toMatchObject({ merged: false, parked: true, outcome: 'awaiting-human' });
    expect(calls.some((c) => c.startsWith('pr merge'))).toBe(false);
    // enabled but a subagent verdict missing → red, no merge
    const red = await runMerge({ config: {}, gh }, { issue: 1, pr: 9, signals: { ship: true, gates: true, reviewer: true /* security missing */ } }, () => {});
    expect(red.merged).toBe(false);
    expect(calls.some((c) => c.startsWith('pr merge'))).toBe(false);
    // all verdicts + green CI → merge
    const ok = await runMerge({ config: {}, gh }, { issue: 1, pr: 9, signals: { ship: true, gates: true, reviewer: true, security: true } }, () => {});
    expect(ok).toMatchObject({ merged: true, outcome: 'merged' });
    expect(calls).toContain('pr merge 9 --squash --delete-branch');
  });
});

describe('autopilot enforced merge path (#315, AC-315.1/AC-315.2) — runMerge is the gated entry point', () => {
  // A gh double: CI rollup is controllable; every other call (incl. pr merge) records + succeeds.
  const ghDouble = (rollup) => {
    const calls = [];
    const gh = async (args) => {
      calls.push(args.join(' '));
      if (args[0] === 'pr' && args[1] === 'view') return { ok: true, json: { statusCheckRollup: rollup } };
      return { ok: true };
    };
    return { calls, gh };
  };
  const green = [{ conclusion: 'SUCCESS' }];
  const heldVerdicts = { ship: true, gates: true, reviewer: true, security: true };

  it('AC-315.1: the live squash-merge fires only through runMerge when the full bar is green', async () => {
    const { calls, gh } = ghDouble(green);
    const res = await runMerge({ config: {}, gh }, { issue: 1, pr: 9, signals: heldVerdicts }, () => {});
    expect(res).toMatchObject({ ok: true, merged: true, outcome: 'merged' });
    expect(calls).toContain('pr merge 9 --squash --delete-branch');
  });

  it('AC-315.2: any red/undefined BAR_SIGNAL makes the merge mechanically impossible — no pr merge call', async () => {
    for (const s of ['ship', 'gates', 'reviewer', 'security']) {
      const { calls, gh } = ghDouble(green); // CI itself is green; a held verdict is the red one
      const signals = { ...heldVerdicts, [s]: false };
      const res = await runMerge({ config: {}, gh }, { issue: 1, pr: 9, signals }, () => {});
      expect(res.merged, `${s}=false must not merge`).toBe(false);
      expect(res.blockedOn, `${s}=false must be blocked on ${s}`).toContain(s);
      expect(calls.some((c) => c.startsWith('pr merge')), `${s}=false must not squash-merge`).toBe(false);
    }
    // A verdict simply absent (undefined) is red too — omit `security` entirely.
    const absent = ghDouble(green);
    const resAbsent = await runMerge({ config: {}, gh: absent.gh }, { issue: 1, pr: 9, signals: { ship: true, gates: true, reviewer: true } }, () => {});
    expect(resAbsent.merged).toBe(false);
    expect(resAbsent.blockedOn).toContain('security');
    expect(absent.calls.some((c) => c.startsWith('pr merge'))).toBe(false);
    // CI undefined/red (empty rollup) with every held verdict green → still fail-closed on ci.
    const ciRed = ghDouble([]);
    const resCi = await runMerge({ config: {}, gh: ciRed.gh }, { issue: 1, pr: 9, signals: heldVerdicts }, () => {});
    expect(resCi.merged).toBe(false);
    expect(resCi.blockedOn).toContain('ci');
    expect(ciRed.calls.some((c) => c.startsWith('pr merge'))).toBe(false);
  });

  it('AC-315.2: critical=true forces no-merge even with every signal green', async () => {
    const { calls, gh } = ghDouble(green);
    const res = await runMerge({ config: {}, gh }, { issue: 1, pr: 9, signals: heldVerdicts, critical: true }, () => {});
    expect(res.merged).toBe(false);
    expect(res.blockedOn).toContain('security:critical');
    expect(res.escalate).toBe(true);
    expect(calls.some((c) => c.startsWith('pr merge'))).toBe(false);
  });
});

describe('autopilot run ledger (#129, AC-6)', () => {
  it('records outcomes idempotently (last write per issue wins) and bumps iterations', () => {
    let run = freshRun('2026-07-21T00:00:00Z');
    run = applyOutcome(run, { issue: 1, outcome: 'merged', ref: 'PR#10' });
    run = applyOutcome(run, { issue: 2, outcome: 'escalated' });
    run = applyOutcome(run, { issue: 1, outcome: 'merged', ref: 'PR#10' }); // re-run same ticket
    expect(run.outcomes.filter((o) => o.issue === 1)).toHaveLength(1);
    expect(run.iterations).toBe(3);
  });

  it('tracks filed follow-ups without duplication', () => {
    let run = applyFiled(freshRun(), { issue: 50, kind: 'bug', from: 12 });
    run = applyFiled(run, { issue: 50, kind: 'bug', from: 12 });
    expect(run.filed).toHaveLength(1);
  });

  it('loop backstop trips at board size × 2', () => {
    const run = { ...freshRun(), iterations: 8 };
    expect(guardTripped(run, 4)).toBe(true);   // 8 >= 4*2
    expect(guardTripped({ ...freshRun(), iterations: 7 }, 4)).toBe(false);
  });

  it('renderReport summarises merged/escalated/filed', () => {
    let run = freshRun();
    run = applyOutcome(run, { issue: 1, outcome: 'merged', ref: 'PR#10' });
    run = applyOutcome(run, { issue: 2, outcome: 'escalated' });
    run = applyFiled(run, { issue: 3, kind: 'spike', from: 1 });
    const out = renderReport(run);
    expect(out).toMatch(/merged: #1/);
    expect(out).toMatch(/escalated: #2/);
    expect(out).toMatch(/filed: #3 \(spike\)/);
  });

  it('startRun + recordOutcome round-trip to disk and resume keeps the start time', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'forge-autopilot-'));
    const started = await startRun(cwd);
    expect(started.startedAt).toBeTruthy();
    await recordOutcome(cwd, { issue: 7, outcome: 'merged', ref: 'PR#7' });
    const resumed = await startRun(cwd); // must NOT reset
    expect(resumed.startedAt).toBe(started.startedAt);
    const onDisk = JSON.parse(await readFile(join(cwd, RUN_RELPATH), 'utf8'));
    expect(onDisk.outcomes).toHaveLength(1);
  });

  // #164 crash-safety: a process killed mid-write of run.json must not wedge the
  // next run. The guarded reader treats a truncated/corrupt file as a fresh run.
  async function writeRaw(cwd, text) {
    const p = join(cwd, RUN_RELPATH);
    await mkdir(dirname(p), { recursive: true });
    await writeFile(p, text, 'utf8');
    return p;
  }

  it('AC-B164.2: loadRun tolerates a corrupt/absent run.json — fresh-run fallback, never a throw', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'forge-autopilot-'));
    // absent → fresh
    expect(await loadRun(cwd)).toMatchObject({ version: 1, iterations: 0, outcomes: [] });
    // truncated mid-write (the R1 failure mode) → fresh, not a SyntaxError
    await writeRaw(cwd, '{ "version": 1, "startedAt": "2026-07-21T00:00:00Z", "outcom');
    const run = await loadRun(cwd);
    expect(run).toMatchObject({ version: 1, iterations: 0, outcomes: [] });
  });

  it('AC-185.3: loadRun PROPAGATES a real I/O error on run.json — never a silent fresh-run reset', async () => {
    // The #185 fix makes readJson re-throw non-ENOENT read errors, which makes
    // readRun's re-throw branch reachable: a transient read failure (EACCES/EIO/
    // EBUSY — AV lock on Windows) on an in-flight run.json must surface, NOT be
    // masked as a fresh run that discards the run's merged/escalated progress.
    vi.resetModules();
    vi.doMock('node:fs/promises', async (orig) => {
      const actual = await orig();
      const eacces = Object.assign(new Error('permission denied'), { code: 'EACCES' });
      return { ...actual, readFile: async () => { throw eacces; } };
    });
    try {
      const { loadRun: throwingLoad } = await import('../../plugin/scripts/autopilot/ledger.mjs');
      const cwd = await mkdtemp(join(tmpdir(), 'forge-autopilot-'));
      await expect(throwingLoad(cwd)).rejects.toMatchObject({ code: 'EACCES' });
    } finally {
      vi.doUnmock('node:fs/promises');
      vi.resetModules();
    }
  });

  // #204: the `report` CLI entrypoint calls loadRun(...).then(...). Now that loadRun
  // propagates a real I/O error (#185), the entrypoint must .catch it — a genuine read
  // failure on an existing run.json must exit cleanly with a one-line message, NOT a
  // raw Node unhandled-rejection stack trace.
  const LEDGER_CLI = fileURLToPath(new URL('../../plugin/scripts/autopilot/ledger.mjs', import.meta.url));

  it('AC-204.2: `report` exits non-zero with a clean message when run.json read fails — no unhandled-rejection trace', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'forge-autopilot-'));
    // Force a genuine (non-ENOENT, non-SyntaxError) read error: make run.json a
    // DIRECTORY, so readFile throws EISDIR — which loadRun propagates rather than
    // treating as absent/corrupt. Cross-platform (no EACCES/chmod juggling).
    await mkdir(join(cwd, RUN_RELPATH), { recursive: true });
    let err;
    try {
      execFileSync(process.execPath, [LEDGER_CLI, 'report'], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) { err = e; }
    expect(err, 'report should have exited non-zero').toBeTruthy();
    expect(err.status).not.toBe(0);
    const stderr = String(err.stderr ?? '');
    expect(stderr).toMatch(/ledger report failed:/);      // clean, controlled one-liner
    expect(stderr).not.toMatch(/UnhandledPromiseRejection/); // not a raw rejection
    expect(stderr).not.toMatch(/node:internal\/process\/promises/);
    expect(stderr).not.toMatch(/^\s+at .+:\d+:\d+/m);        // no stack frames
  });

  it('AC-B164.3: startRun recovers from a truncated run.json and starts a clean run', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'forge-autopilot-'));
    // simulate a crash that left half a JSON object on disk
    await writeRaw(cwd, '{ "version": 1, "startedAt": "2026-07-21');
    const started = await startRun(cwd); // must NOT throw — begins a fresh run
    expect(started.startedAt).toBeTruthy();
    // and the ledger is usable again from here (round-trips to disk)
    await recordOutcome(cwd, { issue: 9, outcome: 'merged', ref: 'PR#9' });
    const onDisk = JSON.parse(await readFile(join(cwd, RUN_RELPATH), 'utf8'));
    expect(onDisk.outcomes).toHaveLength(1);
  });
});

describe('autopilot permissions helper (#156, AC-3)', () => {
  it('the allowlist covers the outward commands that would otherwise prompt', () => {
    for (const cmd of ['Bash(gh pr merge:*)', 'Bash(git push:*)', 'Bash(gh issue close:*)', 'Bash(gh pr create:*)']) {
      expect(ALLOW, `allowlist missing ${cmd}`).toContain(cmd);
    }
  });
  it('permsBlock is the exact settings.local.json shape to merge', () => {
    const b = permsBlock();
    expect(b).toHaveProperty('permissions.allow');
    expect(Array.isArray(b.permissions.allow)).toBe(true);
    expect(b.permissions.allow).toEqual(ALLOW);
  });
});

describe('autopilot reactive filing (#130, AC-5)', () => {
  it('maps delivery kind → board type (spike→item, bug→bug, test→test)', () => {
    expect(toType('bug')).toBe('bug');
    expect(toType('spike')).toBe('item');
    expect(toType('test')).toBe('test');
    expect(toType('whatever')).toBe('item');
    expect(KIND_TO_TYPE.feature).toBe('item');
  });

  it('fileWork creates a linked ticket, annotates the source, defaults to backlog', async () => {
    const seen = [];
    const create = async (_ctx, spec) => { seen.push(spec); return { ok: true, number: 200 }; };
    const res = await fileWork({}, { title: 'race in queue', kind: 'bug', from: 12, parent: 125 }, create, () => {});
    expect(res).toMatchObject({ ok: true, number: 200, kind: 'bug' });
    expect(seen[0]).toMatchObject({ type: 'bug', status: 'backlog', parent: 125 });
    expect(seen[0].body).toMatch(/while delivering #12/);
  });
});
