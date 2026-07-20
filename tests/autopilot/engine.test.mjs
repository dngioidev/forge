import { describe, it, expect } from 'vitest';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { selectNext, actionFor, actionableQueue } from '../../plugin/scripts/autopilot/select.mjs';
import { evaluateMergeBar, autoMergeEnabled, ciGreen, runMerge, BAR_SIGNALS } from '../../plugin/scripts/autopilot/merge.mjs';
import { applyOutcome, applyFiled, guardTripped, renderReport, freshRun, startRun, recordOutcome, RUN_RELPATH } from '../../plugin/scripts/autopilot/ledger.mjs';
import { toType, fileWork, KIND_TO_TYPE } from '../../plugin/scripts/autopilot/newwork.mjs';

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
