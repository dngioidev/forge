import { describe, it, expect, vi } from 'vitest';
import { mkdtemp, readFile, writeFile, mkdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { selectNext, actionFor, actionableQueue, normalize } from '../../plugin/scripts/autopilot/select.mjs';
import { evaluateMergeBar, autoMergeEnabled, ciGreen, runMerge, BAR_SIGNALS, classifyCiFailure, forceNewSha, failedDuringSetup } from '../../plugin/scripts/autopilot/merge.mjs';
import { applyOutcome, applyFiled, guardTripped, nextIteration, renderReport, freshRun, startRun, recordOutcome, loadRun, RUN_RELPATH } from '../../plugin/scripts/autopilot/ledger.mjs';
import { mergeAuthPreflight, isAutoMergeMode, MERGE_MODES } from '../../plugin/scripts/autopilot/preflight.mjs';
import { resolveReturnedTicket, STALL_OUTCOME } from '../../plugin/scripts/autopilot/watchdog.mjs';
import { toType, fileWork, KIND_TO_TYPE } from '../../plugin/scripts/autopilot/newwork.mjs';
import { isShaped, DEFAULT_AC_HEADINGS } from '../../plugin/scripts/autopilot/readiness.mjs';
import { ALLOW, permsBlock } from '../../plugin/scripts/autopilot/perms.mjs';
import {
  shouldPause, isFresh, configuredThresholdPct, loadUsage, evaluateSessionPause,
  DEFAULT_THRESHOLD_PCT, USAGE_RELPATH,
} from '../../plugin/scripts/autopilot/sessionpause.mjs';
import {
  shouldPauseForBudget, budgetCheckDue, evaluateRateBudget,
  DEFAULT_LOW_WATER, DEFAULT_CHECK_EVERY_N,
} from '../../plugin/scripts/autopilot/ratebudget.mjs';
import { writeJson } from '../../plugin/scripts/lib/jsonfile.mjs';
import { CONFIG_RELPATH } from '../../plugin/scripts/lib/config.mjs';
import { makeGh } from '../../plugin/scripts/lib/exec.mjs';
import { writeCiWatchState, CI_WATCH_RELPATH } from '../../plugin/scripts/monitors/ci-watch.mjs';
import { isFreshGreenTransition } from '../../plugin/scripts/autopilot/merge.mjs';

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

  describe('ciGreen fresh-transition shortcut (AC-407.2) — reduces the 3 idle CI pollers to 2', () => {
    const now = Date.parse('2026-08-08T12:00:00Z');

    it('isFreshGreenTransition: same pr + pass + within the window -> true', () => {
      const state = { pr: 9, state: 'pass', at: new Date(now - 5000).toISOString() };
      expect(isFreshGreenTransition(state, 9, { now, maxAgeMs: 20000 })).toBe(true);
    });

    it('isFreshGreenTransition: wrong pr, non-pass, stale, or unparsable timestamp all fall through', () => {
      const at = new Date(now - 5000).toISOString();
      expect(isFreshGreenTransition({ pr: 10, state: 'pass', at }, 9, { now, maxAgeMs: 20000 })).toBe(false); // wrong pr
      expect(isFreshGreenTransition({ pr: 9, state: 'pending', at }, 9, { now, maxAgeMs: 20000 })).toBe(false); // not pass
      expect(isFreshGreenTransition({ pr: 9, state: 'fail', at }, 9, { now, maxAgeMs: 20000 })).toBe(false); // not pass
      expect(isFreshGreenTransition({ pr: 9, state: 'pass', at: new Date(now - 999999).toISOString() }, 9, { now, maxAgeMs: 20000 })).toBe(false); // stale
      expect(isFreshGreenTransition({ pr: 9, state: 'pass', at: 'not-a-date' }, 9, { now })).toBe(false); // unparsable
      expect(isFreshGreenTransition(null, 9, { now })).toBe(false); // no state at all
    });

    it('ciGreen: a fresh known-green transition satisfies the check WITHOUT calling gh', async () => {
      let calls = 0;
      const gh = async () => { calls++; return { ok: true, json: { statusCheckRollup: [] } }; }; // would be NOT green if actually called
      const freshState = { pr: 9, state: 'pass', at: new Date(now - 3000).toISOString() };
      const res = await ciGreen(gh, 9, { freshState, now, maxAgeMs: 20000 });
      expect(res).toMatchObject({ ok: true, green: true, viaFreshTransition: true });
      expect(calls).toBe(0); // the redundant GraphQL re-fetch never fired
    });

    it('ciGreen: a stale/wrong-pr/missing freshState always falls through to the real re-fetch — the safety property stays intact', async () => {
      let calls = 0;
      const gh = async () => { calls++; return { ok: true, json: { statusCheckRollup: [{ conclusion: 'SUCCESS' }] } }; };
      await ciGreen(gh, 9, { freshState: null });
      await ciGreen(gh, 9, { freshState: { pr: 10, state: 'pass', at: new Date(now - 1000).toISOString() }, now });
      await ciGreen(gh, 9, { freshState: { pr: 9, state: 'pass', at: new Date(now - 999999).toISOString() }, now });
      expect(calls).toBe(3); // every one of these re-fetched — never skipped a red/stale/wrong-pr case
    });
  });

  it('#408: ciGreen surfaces the failing CheckRun\'s workflowName for classifyCiFailure to scope on (null when unknown, e.g. a StatusContext)', async () => {
    const gh = (json) => async () => ({ ok: true, json });
    const withWorkflow = await ciGreen(gh({ statusCheckRollup: [{ conclusion: 'FAILURE', name: 'actionlint', workflowName: 'verify' }] }));
    expect(withWorkflow.workflowName).toBe('verify');
    const withoutWorkflow = await ciGreen(gh({ statusCheckRollup: [{ state: 'ERROR', context: 'legacy-status' }] })); // StatusContext has no workflowName
    expect(withoutWorkflow.workflowName).toBe(null);
  });

  // SECURITY (3rd review pass, #408): a decoy WORKFLOW (not just a decoy job
  // within one workflow) must never let a real failure in a DIFFERENT
  // workflow ride through as "just an outage."
  describe('#408: ciGreen.classifiable — fail-closed when the bad-check set is ambiguous across workflows', () => {
    const gh = (json) => async () => ({ ok: true, json });

    it('classifiable=true when every bad check shares exactly one workflow', async () => {
      const ci = await ciGreen(gh({ statusCheckRollup: [
        { conclusion: 'FAILURE', name: 'actionlint', workflowName: 'verify' },
        { conclusion: 'FAILURE', name: 'gitleaks', workflowName: 'verify' },
        { conclusion: 'SUCCESS', name: 'license', workflowName: 'verify' }, // passing checks don't count
      ] }));
      expect(ci.classifiable).toBe(true);
      expect(ci.workflowName).toBe('verify');
    });

    it('classifiable=false when bad checks span MULTIPLE workflows — a decoy workflow must not mask a real one', async () => {
      const ci = await ciGreen(gh({ statusCheckRollup: [
        { conclusion: 'FAILURE', name: 'actionlint', workflowName: 'verify' },  // genuinely outaged
        { conclusion: 'FAILURE', name: 'scan', workflowName: 'secret-scan' },   // a REAL failure elsewhere
      ] }));
      expect(ci.classifiable).toBe(false);
      expect(ci.workflowName).toBe(null);
    });

    it('classifiable=false when ANY bad check has no resolvable workflow (e.g. a StatusContext)', async () => {
      const ci = await ciGreen(gh({ statusCheckRollup: [
        { conclusion: 'FAILURE', name: 'actionlint', workflowName: 'verify' },
        { state: 'ERROR', context: 'external-deploy-check' }, // no workflowName at all — can't verify
      ] }));
      expect(ci.classifiable).toBe(false);
    });
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

  it('AC-407.2: a fresh forge-ci monitor transition on disk lets runMerge skip its own "pr view" re-fetch', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'forge-merge-'));
    await writeCiWatchState(cwd, { pr: 9, state: 'pass' }); // "at" defaults to now
    const calls = [];
    const gh = async (args) => {
      calls.push(args.join(' '));
      if (args[0] === 'pr' && args[1] === 'view') throw new Error('should not re-fetch — a fresh transition was already on disk');
      return { ok: true };
    };
    const res = await runMerge({ config: {}, gh, cwd }, { issue: 1, pr: 9, signals: heldVerdicts }, () => {});
    expect(res).toMatchObject({ ok: true, merged: true, outcome: 'merged' });
    expect(calls.some((c) => c.startsWith('pr view'))).toBe(false);
    expect(calls).toContain('pr merge 9 --squash --delete-branch');
  });

  it('AC-407.2: a stale/absent ci-watch.json still runs the real pre-merge re-check (no ctx.cwd or no file = today\'s behavior)', async () => {
    const { calls, gh } = ghDouble(green);
    // no cwd on ctx at all — must behave exactly as before this ticket
    const res = await runMerge({ config: {}, gh }, { issue: 1, pr: 9, signals: heldVerdicts }, () => {});
    expect(res.merged).toBe(true);
    expect(calls).toContain('pr view 9 --json statusCheckRollup');
  });
});

describe('autopilot merge-auth preflight (#316, AC-316.1/AC-316.2) — no silent wedge at first merge', () => {
  // AC-316.1: at run start the effective merge mode is decided explicitly.
  it('AC-316.1: an explicit in-session grant (config-enabled) → mode auto-merge, proceed', () => {
    const d = mergeAuthPreflight({ authorized: true, config: {} });
    expect(d.mode).toBe('auto-merge');
    expect(isAutoMergeMode(d.mode)).toBe(true);
    expect(d.reason).toMatch(/authorization held/i);
    expect(MERGE_MODES).toEqual(['auto-merge', 'pr-only']);
  });

  it('AC-316.1: NO grant → mode pr-only (degrade to awaiting-human), not a mid-run stall', () => {
    const d = mergeAuthPreflight({ authorized: false, config: {} });
    expect(d.mode).toBe('pr-only');
    expect(isAutoMergeMode(d.mode)).toBe(false);
    // the human-readable reason names why: allowlist/config are not sufficient.
    expect(d.reason).toMatch(/no in-session merge authorization/i);
    expect(d.reason).toMatch(/PR-only/i);
    // absent/omitted authorized is treated as no grant (fail-closed).
    expect(mergeAuthPreflight().mode).toBe('pr-only');
    expect(mergeAuthPreflight({}).mode).toBe('pr-only');
    // a non-`true` truthy value is NOT a grant — only an explicit boolean true counts.
    expect(mergeAuthPreflight({ authorized: 'yes' }).mode).toBe('pr-only');
    expect(mergeAuthPreflight({ authorized: 1 }).mode).toBe('pr-only');
  });

  it('AC-316.1: a live grant but features.autopilotAutoMerge:false still → pr-only (config wins)', () => {
    const d = mergeAuthPreflight({ authorized: true, config: { features: { autopilotAutoMerge: false } } });
    expect(d.mode).toBe('pr-only');
    expect(d.reason).toMatch(/autopilotAutoMerge=false/);
  });

  it('AC-316.1: startRun records the decision (mergeMode + reason) into run.json — auditable & resume-safe', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'forge-autopilot-'));
    const started = await startRun(cwd, { authorized: false, config: {} });
    expect(started.mergeMode).toBe('pr-only');
    expect(started.mergeReason).toBeTruthy();
    const onDisk = JSON.parse(await readFile(join(cwd, RUN_RELPATH), 'utf8'));
    expect(onDisk.mergeMode).toBe('pr-only');
    // resume re-runs the (non-file-backed) preflight: grant now held → refreshes to auto-merge,
    // but keeps the original start time.
    const resumed = await startRun(cwd, { authorized: true, config: {} });
    expect(resumed.startedAt).toBe(started.startedAt);
    expect(resumed.mergeMode).toBe('auto-merge');
    expect(JSON.parse(await readFile(join(cwd, RUN_RELPATH), 'utf8')).mergeMode).toBe('auto-merge');
    // startRun with no auth opt is unchanged (back-compat): no decision imposed on resume.
    const plain = await startRun(cwd);
    expect(plain.startedAt).toBe(started.startedAt);
    expect(plain.mergeMode).toBe('auto-merge'); // preserved from the last recorded decision
  });

  // AC-316.2: the mode actually GATES the merge — pr-only parks, auto-merge proceeds.
  const ghDouble = (rollup = [{ conclusion: 'SUCCESS' }]) => {
    const calls = [];
    const gh = async (args) => {
      calls.push(args.join(' '));
      if (args[0] === 'pr' && args[1] === 'view') return { ok: true, json: { statusCheckRollup: rollup } };
      return { ok: true };
    };
    return { calls, gh };
  };
  const heldVerdicts = { ship: true, gates: true, reviewer: true, security: true };

  it('AC-316.2: mode pr-only PARKS awaiting-human and never attempts a merge (even with a green bar)', async () => {
    const { calls, gh } = ghDouble();
    const res = await runMerge({ config: {}, gh }, { issue: 5, pr: 42, signals: heldVerdicts, mode: 'pr-only' }, () => {});
    expect(res).toMatchObject({ ok: true, merged: false, parked: true, outcome: 'awaiting-human' });
    // parked before any CI/merge gh call — no stall at the merge.
    expect(calls.some((c) => c.startsWith('pr merge'))).toBe(false);
    expect(calls.some((c) => c.startsWith('pr view'))).toBe(false);
  });

  it('AC-316.2: mode auto-merge proceeds to the tested bar and squash-merges on green', async () => {
    const { calls, gh } = ghDouble();
    const res = await runMerge({ config: {}, gh }, { issue: 5, pr: 42, signals: heldVerdicts, mode: 'auto-merge' }, () => {});
    expect(res).toMatchObject({ ok: true, merged: true, outcome: 'merged' });
    expect(calls).toContain('pr merge 42 --squash --delete-branch');
  });

  it('AC-316.2: mode omitted preserves prior behavior — enabled config still merges, disabled still parks', async () => {
    const enabled = ghDouble();
    const okRes = await runMerge({ config: {}, gh: enabled.gh }, { issue: 5, pr: 42, signals: heldVerdicts }, () => {});
    expect(okRes.merged).toBe(true);
    const disabled = ghDouble();
    const parked = await runMerge({ config: { features: { autopilotAutoMerge: false } }, gh: disabled.gh }, { issue: 5, pr: 42, signals: heldVerdicts }, () => {});
    expect(parked).toMatchObject({ merged: false, parked: true, outcome: 'awaiting-human' });
    expect(disabled.calls.some((c) => c.startsWith('pr merge'))).toBe(false);
  });
});

describe('autopilot return-then-resume watchdog (#319, AC-319.1/AC-319.2) — awaiting-merge is never silently parked', () => {
  const heldVerdicts = { ship: true, gates: true, reviewer: true, security: true };

  // AC-319.1: a returned awaiting-merge on a green PR resolves to merge/escalate — never a silent park.
  it('AC-319.1: awaiting-merge on a green PR with auto-merge authority → merge (funnel to runMerge), not a silent park', () => {
    const dec = resolveReturnedTicket({ outcome: 'awaiting-merge', pr: 42, ciGreen: true, mergeMode: 'auto-merge' });
    expect(dec.action).toBe('merge');
    expect(dec.pr).toBe(42);
    expect(dec.outcome).toBe('merged');
    expect(dec.action).not.toBe('continue'); // the stall guard: never silently parked
    expect(STALL_OUTCOME).toBe('awaiting-merge');
  });

  it('AC-319.1: awaiting-merge on a green PR without merge authority (pr-only) → escalate, recorded awaiting-human (surfaced, not parked)', () => {
    for (const mergeMode of ['pr-only', null, undefined]) {
      const dec = resolveReturnedTicket({ outcome: 'awaiting-merge', pr: 42, ciGreen: true, mergeMode });
      expect(dec.action, `mode=${mergeMode}`).toBe('escalate');
      expect(dec.outcome, `mode=${mergeMode}`).toBe('awaiting-human'); // surfaced visibly, not a silent park
      expect(dec.action).not.toBe('continue');
      expect(dec.reason).toMatch(/not silently parking/i);
    }
  });

  it('AC-319.1: awaiting-merge that is NOT actually mergeable (no PR, or PR not green) → escalate, never silent', () => {
    // returned awaiting-merge but no PR at all — cannot verify or merge.
    const noPr = resolveReturnedTicket({ outcome: 'awaiting-merge', pr: null, ciGreen: true, mergeMode: 'auto-merge' });
    expect(noPr.action).toBe('escalate');
    expect(noPr.outcome).toBe('escalated');
    expect(noPr.reason).toMatch(/no PR/i);
    // returned awaiting-merge before CI concluded — the subagent skipped the in-run --watch.
    const notGreen = resolveReturnedTicket({ outcome: 'awaiting-merge', pr: 42, ciGreen: false, mergeMode: 'auto-merge' });
    expect(notGreen.action).toBe('escalate');
    expect(notGreen.outcome).toBe('escalated');
    expect(notGreen.reason).toMatch(/before PR #42 CI was green/i);
  });

  it('AC-319.1: every OTHER (already-resolved) outcome passes through as continue — the watchdog only fires on the stall', () => {
    for (const outcome of ['merged', 'escalated', 'awaiting-human', 'skipped']) {
      const dec = resolveReturnedTicket({ outcome, pr: 42, ciGreen: true, mergeMode: 'auto-merge' });
      expect(dec.action, outcome).toBe('continue');
      expect(dec.outcome, outcome).toBe(outcome); // record the outcome the subagent already reported
    }
    // an absent/unknown outcome is likewise not the stall — pass through.
    expect(resolveReturnedTicket({}).action).toBe('continue');
  });

  it("AC-319.1: the watchdog's merge action actually drives runMerge to a squash-merge on a green bar", async () => {
    // Prove the resolved `merge` action funnels to the tested bar and merges (end-to-end with the returned report).
    const calls = [];
    const gh = async (args) => {
      calls.push(args.join(' '));
      if (args[0] === 'pr' && args[1] === 'view') return { ok: true, json: { statusCheckRollup: [{ conclusion: 'SUCCESS' }] } };
      return { ok: true };
    };
    const dec = resolveReturnedTicket({ outcome: 'awaiting-merge', pr: 9, ciGreen: true, mergeMode: 'auto-merge' });
    expect(dec.action).toBe('merge');
    const res = await runMerge({ config: {}, gh }, { issue: 1, pr: dec.pr, signals: heldVerdicts, mode: 'auto-merge' }, () => {});
    expect(res).toMatchObject({ ok: true, merged: true, outcome: 'merged' });
    expect(calls).toContain('pr merge 9 --squash --delete-branch');
  });

  // AC-319.2: a ticket returned at a green PR is PICKED BACK UP by selection (resume path), not skipped.
  it('AC-319.2: a returned-at-green-PR ticket (board still inReview/inProgress) re-enters selection as resume', () => {
    // The board status for an open PR is a resume-tier status; selection must re-pick it, not skip it.
    for (const status of ['inReview', 'inProgress']) {
      const pick = selectNext([t(319, status)]);
      expect(pick, `status=${status} must be selectable`).not.toBeNull();
      expect(pick.ticket.number).toBe(319);
      expect(pick.action).toBe('resume'); // reuses the existing resume path — re-driven, never silently parked
    }
    // even if the subagent never moved the board off ready/backlog, it is still picked back up (re-delivered),
    // i.e. the returned ticket is NEVER dropped from selection.
    expect(selectNext([t(319, 'ready')]).action).toBe('deliver');
    expect(selectNext([t(319, 'backlog')]).action).toBe('triage');
  });

  it('AC-319.2: the returned green-PR ticket sits ahead of fresh work — resume beats ready/backlog so it is re-driven first', () => {
    const tickets = [t(400, 'ready', 'p0'), t(319, 'inReview', 'p2'), t(500, 'backlog', 'p0')];
    // despite its low priority, the resumed green-PR ticket wins the tier and is picked back up first.
    const pick = selectNext(tickets);
    expect(pick.ticket.number).toBe(319);
    expect(pick.action).toBe('resume');
    expect(actionableQueue(tickets).map((q) => q.ticket.number)).toEqual([319, 400, 500]);
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

  // #317: the backstop had no runtime caller — nextIteration is that caller. It is the
  // per-iteration guard the loop MUST call first each iteration; it delegates to
  // guardTripped and turns a trip into a halt+escalate decision (not silent continue).
  it('AC-317.1: nextIteration invokes the backstop and returns continue under the cap', () => {
    const dec = nextIteration({ ...freshRun(), iterations: 3 }, 4); // cap = 4×2 = 8
    expect(dec.stop).toBe(false);
    expect(dec.escalate).toBe(false);
    expect(dec.cap).toBe(8);
    expect(dec.iterations).toBe(3);
    expect(dec.reason).toBeNull();
    // it delegates to guardTripped — same verdict, under and at the cap boundary.
    expect(dec.stop).toBe(guardTripped({ ...freshRun(), iterations: 3 }, 4));
    expect(nextIteration({ ...freshRun(), iterations: 7 }, 4).stop).toBe(false); // 7 < 8
    // honours a custom factor and the boardSize floor (max(1,·)).
    expect(nextIteration({ ...freshRun(), iterations: 3 }, 1, 3).stop).toBe(true); // 3 >= 1×3
    expect(nextIteration({ ...freshRun(), iterations: 1 }, 0).cap).toBe(2);        // floor: max(1,0)×2
  });

  it('AC-317.2: a runaway loop is HALTED by the per-iteration guard at board size × factor', () => {
    const boardSize = 3; // cap = 3×2 = 6
    let run = freshRun('2026-07-26T00:00:00Z');
    let iterationsRun = 0;
    let halted = null;
    // Simulate the orchestrator: guard FIRST each iteration, then do (pathological) work
    // that never converges — file a ticket and record an outcome every iteration, forever.
    // Without the wired guard this loops until the 1000 safety cap; with it, it halts at 6.
    for (let i = 0; i < 1000; i++) {
      const dec = nextIteration(run, boardSize);
      if (dec.stop) { halted = dec; break; }
      iterationsRun++;
      run = applyFiled(run, { issue: 500 + i, kind: 'bug', from: 1 });
      run = applyOutcome(run, { issue: 500 + i, outcome: 'skipped' }); // bumps run.iterations
    }
    expect(halted).not.toBeNull();              // the guard stopped the loop (not the 1000 safety cap)
    expect(halted.escalate).toBe(true);         // a trip is a halt+escalate, never a silent continue
    expect(halted.reason).toMatch(/runaway backstop tripped/);
    expect(halted.reason).toMatch(/cap of 6/);
    expect(iterationsRun).toBe(6);              // exactly board size × 2 iterations ran, then halt
    expect(run.iterations).toBe(6);
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

describe('autopilot session-window self-pause (#378, AC.6) — statusline-poll mechanism', () => {
  it('shouldPause: exactly-at-threshold pauses (inclusive boundary)', () => {
    expect(shouldPause({ usedPercentage: 90, thresholdPct: 90 })).toBe(true);
  });

  it('shouldPause: above threshold pauses', () => {
    expect(shouldPause({ usedPercentage: 95, thresholdPct: 90 })).toBe(true);
  });

  it('shouldPause: below threshold never pauses', () => {
    expect(shouldPause({ usedPercentage: 89.9, thresholdPct: 90 })).toBe(false);
  });

  it('shouldPause: defaults thresholdPct to 90 when the caller omits it', () => {
    expect(DEFAULT_THRESHOLD_PCT).toBe(90);
    expect(shouldPause({ usedPercentage: 90 })).toBe(true);
    expect(shouldPause({ usedPercentage: 89 })).toBe(false);
  });

  it('shouldPause: missing/malformed usedPercentage never pauses (fail-open)', () => {
    expect(shouldPause({})).toBe(false);
    expect(shouldPause({ usedPercentage: undefined })).toBe(false);
    expect(shouldPause({ usedPercentage: null })).toBe(false);
    expect(shouldPause({ usedPercentage: NaN })).toBe(false);
    expect(shouldPause({ usedPercentage: 'high' })).toBe(false);
    expect(shouldPause()).toBe(false);
  });

  it('isFresh: within maxAgeMs is fresh; older is stale; missing/unparsable is stale', () => {
    const now = Date.parse('2026-08-05T12:00:00Z');
    expect(isFresh({ timestamp: '2026-08-05T11:50:00Z', now, maxAgeMs: 20 * 60 * 1000 })).toBe(true);
    expect(isFresh({ timestamp: '2026-08-05T11:30:00Z', now, maxAgeMs: 20 * 60 * 1000 })).toBe(false);
    expect(isFresh({ timestamp: undefined, now })).toBe(false);
    expect(isFresh({ timestamp: 'not-a-date', now })).toBe(false);
  });

  it('configuredThresholdPct: unset/malformed config -> null (opt-in not taken, AC.4)', () => {
    expect(configuredThresholdPct(undefined)).toBeNull();
    expect(configuredThresholdPct({})).toBeNull();
    expect(configuredThresholdPct({ autopilot: {} })).toBeNull();
    expect(configuredThresholdPct({ autopilot: { sessionPauseThresholdPct: 0 } })).toBeNull();
    expect(configuredThresholdPct({ autopilot: { sessionPauseThresholdPct: 101 } })).toBeNull();
    expect(configuredThresholdPct({ autopilot: { sessionPauseThresholdPct: 'high' } })).toBeNull();
  });

  it('configuredThresholdPct: a valid number opts in at that value', () => {
    expect(configuredThresholdPct({ autopilot: { sessionPauseThresholdPct: 85 } })).toBe(85);
  });

  it('loadUsage: tolerates a missing or corrupt usage.json — never throws', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'forge-sessionpause-'));
    expect(await loadUsage(cwd)).toBeNull();
    await mkdir(dirname(join(cwd, USAGE_RELPATH)), { recursive: true });
    await writeFile(join(cwd, USAGE_RELPATH), '{not json', 'utf8');
    await expect(loadUsage(cwd)).resolves.toBeNull();
  });

  describe('evaluateSessionPause — the orchestrator-facing decision (AC.1/AC.4)', () => {
    it('AC.2/AC.4: config unset -> never pauses, regardless of usage data (today\'s behavior unchanged)', async () => {
      const cwd = await mkdtemp(join(tmpdir(), 'forge-sessionpause-'));
      await writeJson(join(cwd, USAGE_RELPATH), { timestamp: new Date().toISOString(), five_hour: { used_percentage: 99 } });
      const dec = await evaluateSessionPause(cwd);
      expect(dec.pause).toBe(false);
      expect(dec.reason).toMatch(/not configured/);
    });

    it('opted in + fresh usage at/above threshold -> pauses', async () => {
      const cwd = await mkdtemp(join(tmpdir(), 'forge-sessionpause-'));
      await writeJson(join(cwd, CONFIG_RELPATH), { autopilot: { sessionPauseThresholdPct: 90 } });
      await writeJson(join(cwd, USAGE_RELPATH), { timestamp: new Date().toISOString(), five_hour: { used_percentage: 92 } });
      const dec = await evaluateSessionPause(cwd);
      expect(dec.pause).toBe(true);
      expect(dec.thresholdPct).toBe(90);
      expect(dec.usedPercentage).toBe(92);
      expect(dec.reason).toMatch(/Resume protocol/);
    });

    it('opted in + fresh usage below threshold -> does not pause', async () => {
      const cwd = await mkdtemp(join(tmpdir(), 'forge-sessionpause-'));
      await writeJson(join(cwd, CONFIG_RELPATH), { autopilot: { sessionPauseThresholdPct: 90 } });
      await writeJson(join(cwd, USAGE_RELPATH), { timestamp: new Date().toISOString(), five_hour: { used_percentage: 50 } });
      expect((await evaluateSessionPause(cwd)).pause).toBe(false);
    });

    it('opted in but no usage.json yet (never ran under Pro/Max) -> does not pause', async () => {
      const cwd = await mkdtemp(join(tmpdir(), 'forge-sessionpause-'));
      await writeJson(join(cwd, CONFIG_RELPATH), { autopilot: { sessionPauseThresholdPct: 90 } });
      const dec = await evaluateSessionPause(cwd);
      expect(dec.pause).toBe(false);
      expect(dec.reason).toMatch(/no usage\.json yet/);
    });

    it('opted in but usage.json is stale (old session) -> does not pause', async () => {
      const cwd = await mkdtemp(join(tmpdir(), 'forge-sessionpause-'));
      await writeJson(join(cwd, CONFIG_RELPATH), { autopilot: { sessionPauseThresholdPct: 90 } });
      const old = new Date(Date.now() - 60 * 60 * 1000).toISOString(); // 1h old
      await writeJson(join(cwd, USAGE_RELPATH), { timestamp: old, five_hour: { used_percentage: 99 } });
      const dec = await evaluateSessionPause(cwd, { maxAgeMs: 20 * 60 * 1000 });
      expect(dec.pause).toBe(false);
      expect(dec.reason).toMatch(/stale/);
    });
  });
});

// #407 AC.1/AC.4 — rateBudget() (#360 AC.4) was fully implemented and exported
// but had zero callers. This wires it into the run-start preflight + a periodic
// per-N-iterations recheck. Mirrors #360's own exec.test.mjs style: hermetic,
// injected gh, no real API, no real sleep.
describe('autopilot rate-budget preflight (AC-407.1/AC-407.4) — the dead rateBudget() finally wired in', () => {
  it('shouldPauseForBudget pauses ONLY on a COMPLETED low reading', () => {
    expect(shouldPauseForBudget({ ok: true, low: true, remaining: 50, limit: 5000 })).toBe(true);
    expect(shouldPauseForBudget({ ok: true, low: false, remaining: 4000, limit: 5000 })).toBe(false);
    expect(shouldPauseForBudget({ ok: false, error: 'boom' })).toBe(false); // a failed check never pauses
    expect(shouldPauseForBudget(null)).toBe(false);
    expect(shouldPauseForBudget(undefined)).toBe(false);
  });

  it('budgetCheckDue: fires only every Nth iteration — never on iteration 0 (the run-start check owns that)', () => {
    expect(DEFAULT_CHECK_EVERY_N).toBe(10);
    expect(budgetCheckDue(0)).toBe(false);
    expect(budgetCheckDue(1)).toBe(false);
    expect(budgetCheckDue(9)).toBe(false);
    expect(budgetCheckDue(10)).toBe(true);
    expect(budgetCheckDue(20)).toBe(true);
    expect(budgetCheckDue(11)).toBe(false);
    expect(budgetCheckDue(5, 5)).toBe(true); // a custom cadence
  });

  it('AC-407.4: evaluateRateBudget PAUSES the run on a mocked low-budget rate_limit response — no real API, no real sleep', async () => {
    let calls = 0;
    const gh = makeGh(async (cmd, args) => {
      calls++;
      expect(args).toEqual(['api', 'rate_limit']);
      return { ok: true, code: 0, stdout: JSON.stringify({ resources: { graphql: { limit: 5000, remaining: 120, reset: 100 } } }), stderr: '' };
    });
    const decision = await evaluateRateBudget(gh, { lowWater: 200 });
    expect(decision).toMatchObject({ pause: true, ok: true });
    expect(decision.budget).toMatchObject({ remaining: 120, limit: 5000, low: true });
    expect(decision.reason).toMatch(/GraphQL budget low/);
    expect(decision.reason).toContain('remaining 120/5000');
    expect(calls).toBe(1); // one check, synchronous — no polling/sleeping involved
  });

  it('AC-407.1: a comfortable budget does not pause the run', async () => {
    const gh = makeGh(async () => ({ ok: true, code: 0, stdout: JSON.stringify({ resources: { graphql: { limit: 5000, remaining: 4000, reset: 0 } } }), stderr: '' }));
    const decision = await evaluateRateBudget(gh, { lowWater: DEFAULT_LOW_WATER });
    expect(decision).toMatchObject({ pause: false, ok: true });
    expect(decision.reason).toMatch(/budget OK/);
  });

  it('spec §3.1: a FAILED budget check degrades to reactive per-call retry — it never hard-blocks the run', async () => {
    const gh = makeGh(async () => ({ ok: false, code: 1, stdout: '', stderr: 'network down' }));
    const decision = await evaluateRateBudget(gh);
    expect(decision).toMatchObject({ pause: false, ok: false });
    expect(decision.reason).toMatch(/degrading to reactive per-call retry, not pausing/);
  });

  it('DEFAULT_LOW_WATER matches rateBudget\'s own default (200)', () => {
    expect(DEFAULT_LOW_WATER).toBe(200);
  });
});

// #408 — detect + auto-recover from GitHub Actions platform outages (distinct from #360's rate limiting).
describe('classifyCiFailure (AC-408.1/AC-408.2, #408) — is a red CI result GitHub, or the change?', () => {
  it('no branch known -> not an outage, no gh calls', async () => {
    const calls = [];
    const gh = async (args) => { calls.push(args); return { ok: true, json: [] }; };
    expect(await classifyCiFailure(gh, { branch: null })).toEqual({ outage: false, reason: null });
    expect(calls).toEqual([]);
  });

  it('no runs found for the branch -> not an outage', async () => {
    const gh = async () => ({ ok: true, json: [] });
    expect(await classifyCiFailure(gh, { branch: 'feat/x' })).toEqual({ outage: false, reason: null });
  });

  it('review fix (#408): scopes `gh run list` to the failing check\'s own workflow when known — a repo can run several workflows on one push', async () => {
    const seenArgs = [];
    const gh = async (args) => { seenArgs.push(args); return { ok: true, json: [] }; };
    await classifyCiFailure(gh, { branch: 'feat/x', workflowName: 'verify' });
    expect(seenArgs[0]).toEqual(['run', 'list', '--branch', 'feat/x', '--limit', '1', '--json', 'databaseId,status,createdAt', '--workflow', 'verify']);
    seenArgs.length = 0;
    await classifyCiFailure(gh, { branch: 'feat/x' }); // no workflowName known (e.g. a StatusContext, not a CheckRun) -> unscoped, unchanged
    expect(seenArgs[0]).toEqual(['run', 'list', '--branch', 'feat/x', '--limit', '1', '--json', 'databaseId,status,createdAt']);
  });

  it('review fix (#408): a merely slow but healthy in_progress run past the threshold is NOT misclassified as stuck-queued', async () => {
    const createdAt = new Date(Date.now() - 20 * 60 * 1000).toISOString(); // 20m ago, well past a 10m threshold
    const gh = async () => ({ ok: true, json: [{ databaseId: 1, status: 'in_progress', createdAt }] });
    expect((await classifyCiFailure(gh, { branch: 'feat/x', stuckQueuedMs: 10 * 60 * 1000 })).outage).toBe(false);
  });

  it('a run stuck queued past the threshold -> outage', async () => {
    const createdAt = new Date(Date.now() - 20 * 60 * 1000).toISOString(); // 20m ago
    const gh = async (args) => {
      if (args[0] === 'run' && args[1] === 'list') return { ok: true, json: [{ databaseId: 1, status: 'queued', createdAt }] };
      throw new Error('should not fetch logs for a queued run');
    };
    const cls = await classifyCiFailure(gh, { branch: 'feat/x', stuckQueuedMs: 10 * 60 * 1000 });
    expect(cls.outage).toBe(true);
    expect(cls.reason).toMatch(/stuck queued for \d+m/);
  });

  it('a run still queued but under the threshold -> not (yet) an outage', async () => {
    const createdAt = new Date(Date.now() - 1000).toISOString();
    const gh = async () => ({ ok: true, json: [{ databaseId: 1, status: 'queued', createdAt }] });
    expect((await classifyCiFailure(gh, { branch: 'feat/x' })).outage).toBe(false);
  });

  it('a completed run whose failed-log text carries the outage signature, corroborated by a setup-phase job failure -> outage', async () => {
    const gh = async (args) => {
      if (args[0] === 'run' && args[1] === 'list') return { ok: true, json: [{ databaseId: 42, status: 'completed', createdAt: new Date().toISOString() }] };
      if (args[0] === 'run' && args[1] === 'view' && args.includes('jobs')) {
        return { ok: true, json: { jobs: [{ name: 'actionlint', conclusion: 'failure', steps: [{ name: 'Set up job', conclusion: 'failure' }, { name: 'Complete job', conclusion: 'failure' }] }] } };
      }
      if (args[0] === 'run' && args[1] === 'view') {
        expect(args).toContain('42');
        expect(args).toContain('--log-failed');
        return { ok: false, stdout: '', stderr: 'Failed to resolve action download info. Error: Service Unavailable' };
      }
      throw new Error(`unexpected gh call: ${args.join(' ')}`);
    };
    const cls = await classifyCiFailure(gh, { branch: 'feat/x' });
    expect(cls.outage).toBe(true);
    expect(cls.reason).toMatch(/Service Unavailable/);
  });

  it('a completed run with an ordinary test-failure log -> NOT an outage (never masks a real regression)', async () => {
    const gh = async (args) => {
      if (args[0] === 'run' && args[1] === 'list') return { ok: true, json: [{ databaseId: 42, status: 'completed', createdAt: new Date().toISOString() }] };
      return { ok: false, stdout: '', stderr: 'AssertionError: expected 1 to equal 2\n  at test.mjs:10' };
    };
    expect((await classifyCiFailure(gh, { branch: 'feat/x' })).outage).toBe(false);
  });

  it('SECURITY (#408 review): a REAL failing user step whose message happens to echo the outage phrases is NOT classified as an outage', async () => {
    // The job ran a repo-defined step ("Run tests") that genuinely failed — its
    // assertion text happens to contain the exact outage phrases (a hostile PR
    // could craft this deliberately). Job-structure corroboration must win: the
    // job got PAST setup and a real step ran, so this must never be "outage".
    let fetchedLog = false;
    const gh = async (args) => {
      if (args[0] === 'run' && args[1] === 'list') return { ok: true, json: [{ databaseId: 42, status: 'completed', createdAt: new Date().toISOString() }] };
      if (args[0] === 'run' && args[1] === 'view' && args.includes('jobs')) {
        return {
          ok: true,
          json: { jobs: [{ name: 'unit-tests', conclusion: 'failure', steps: [
            { name: 'Set up job', conclusion: 'success' },
            { name: 'Checkout', conclusion: 'success' },
            { name: 'Run tests', conclusion: 'failure' },
            { name: 'Complete job', conclusion: 'failure' },
          ] } ] },
        };
      }
      if (args[0] === 'run' && args[1] === 'view' && args.includes('--log-failed')) {
        fetchedLog = true;
        return { ok: false, stdout: '', stderr: 'AssertionError: Failed to resolve action download info. Error: Service Unavailable (planted by a hostile test)' };
      }
      throw new Error(`unexpected gh call: ${args.join(' ')}`);
    };
    const cls = await classifyCiFailure(gh, { branch: 'feat/x' });
    expect(cls.outage).toBe(false);
    expect(fetchedLog).toBe(false); // never even reads the spoofable log text once structure says "real step ran"
  });

  it('SECURITY (2nd review pass, #408): a genuine setup-phase decoy job cannot launder a co-occurring REAL job failure into "outage" end-to-end', async () => {
    // Two jobs failed in the same run: 'flaky-action' genuinely failed during
    // setup (a real, non-malicious infra hiccup on ITS OWN job) while
    // 'unit-tests' ran a real step and genuinely failed for a real reason.
    // The run-wide --log-failed text (fetched only if failedDuringSetup allows
    // it) would otherwise let the setup-phase job "vouch" for the whole run.
    let fetchedLog = false;
    const gh = async (args) => {
      if (args[0] === 'run' && args[1] === 'list') return { ok: true, json: [{ databaseId: 42, status: 'completed', createdAt: new Date().toISOString() }] };
      if (args[0] === 'run' && args[1] === 'view' && args.includes('jobs')) {
        return {
          ok: true,
          json: { jobs: [
            { name: 'flaky-action', conclusion: 'failure', steps: [{ name: 'Set up job', conclusion: 'failure' }, { name: 'Complete job', conclusion: 'failure' }] },
            { name: 'unit-tests', conclusion: 'failure', steps: [
              { name: 'Set up job', conclusion: 'success' },
              { name: 'Run tests', conclusion: 'failure' },
              { name: 'Complete job', conclusion: 'failure' },
            ] },
          ] },
        };
      }
      if (args[0] === 'run' && args[1] === 'view' && args.includes('--log-failed')) {
        fetchedLog = true;
        return { ok: false, stdout: '', stderr: 'flaky-action: Failed to resolve action download info. Error: Service Unavailable\nunit-tests: AssertionError: expected 1 to equal 2' };
      }
      throw new Error(`unexpected gh call: ${args.join(' ')}`);
    };
    const cls = await classifyCiFailure(gh, { branch: 'feat/x' });
    expect(cls.outage).toBe(false); // the real unit-tests failure must win — never masked by the co-occurring decoy
    expect(fetchedLog).toBe(false); // structure alone rules this out before the spoofable log text is ever read
  });

  it('degrades to "not an outage" on a malformed run-list response, never throws', async () => {
    const gh = async () => ({ ok: true, json: null });
    await expect(classifyCiFailure(gh, { branch: 'feat/x' })).resolves.toEqual({ outage: false, reason: null });
  });

  it('degrades to "not an outage" when the jobs lookup itself fails', async () => {
    const gh = async (args) => {
      if (args[0] === 'run' && args[1] === 'list') return { ok: true, json: [{ databaseId: 42, status: 'completed', createdAt: new Date().toISOString() }] };
      return { ok: false, stderr: 'boom' };
    };
    expect((await classifyCiFailure(gh, { branch: 'feat/x' })).outage).toBe(false);
  });
});

describe('failedDuringSetup (#408 security follow-up) — structural corroboration, not spoofable via step log text', () => {
  const jobsRes = (jobs) => ({ ok: true, json: { jobs } });

  it('true when the injected "Set up job" step itself failed', () => {
    expect(failedDuringSetup(jobsRes([{ conclusion: 'failure', steps: [{ name: 'Set up job', conclusion: 'failure' }, { name: 'Complete job', conclusion: 'failure' }] }]))).toBe(true);
  });

  it('true when no repo-defined step between the bookends ever ran (all skipped/cancelled/unset)', () => {
    expect(failedDuringSetup(jobsRes([{ conclusion: 'failure', steps: [
      { name: 'Set up job', conclusion: 'success' },
      { name: 'Checkout', conclusion: 'skipped' },
      { name: 'Build', conclusion: null },
      { name: 'Complete job', conclusion: 'failure' },
    ] }]))).toBe(true);
  });

  it('false once ANY repo-defined step actually ran and failed — a real failure, never masked', () => {
    expect(failedDuringSetup(jobsRes([{ conclusion: 'failure', steps: [
      { name: 'Set up job', conclusion: 'success' },
      { name: 'Run tests', conclusion: 'failure' },
      { name: 'Complete job', conclusion: 'failure' },
    ] }]))).toBe(false);
  });

  it('false when no job actually failed (conclusion success/skipped)', () => {
    expect(failedDuringSetup(jobsRes([{ conclusion: 'success', steps: [] }]))).toBe(false);
    expect(failedDuringSetup(jobsRes([]))).toBe(false);
  });

  it('true when there is no step breakdown at all (the job never even got that far)', () => {
    expect(failedDuringSetup(jobsRes([{ conclusion: 'failure', steps: [] }]))).toBe(true);
  });

  it('degrades to false on a malformed/failed jobs response, never throws', () => {
    expect(failedDuringSetup({ ok: false })).toBe(false);
    expect(failedDuringSetup({ ok: true, json: null })).toBe(false);
    expect(failedDuringSetup(null)).toBe(false);
  });

  // SECURITY (2nd review pass, #408): the decoy-job bypass. classifyCiFailure's
  // --log-failed fetch is RUN-WIDE (every failing job's log), not scoped to one
  // job — checking only the FIRST failing job here would let a genuine
  // setup-phase decoy job "corroborate" an outage while a SECOND, real job's
  // genuine failure (whose text could echo the outage phrases) rides along in
  // the same aggregated log and still gets classified as an outage.
  it('SECURITY: false when ANY failing job among several ran a real step, even if ANOTHER job genuinely failed during setup (no decoy bypass)', () => {
    const setupFailure = { conclusion: 'failure', name: 'decoy', steps: [{ name: 'Set up job', conclusion: 'failure' }, { name: 'Complete job', conclusion: 'failure' }] };
    const realFailure = { conclusion: 'failure', name: 'unit-tests', steps: [
      { name: 'Set up job', conclusion: 'success' },
      { name: 'Run tests', conclusion: 'failure' },
      { name: 'Complete job', conclusion: 'failure' },
    ] };
    // Decoy listed FIRST — a `.find()`-based check would corroborate on it alone.
    expect(failedDuringSetup(jobsRes([setupFailure, realFailure]))).toBe(false);
    // Order must not matter either.
    expect(failedDuringSetup(jobsRes([realFailure, setupFailure]))).toBe(false);
  });

  it('true only when EVERY failing job in a multi-job run failed during setup', () => {
    const a = { conclusion: 'failure', steps: [{ name: 'Set up job', conclusion: 'failure' }] };
    const b = { conclusion: 'failure', steps: [] }; // no breakdown — also counts as setup-phase
    const passing = { conclusion: 'success', steps: [{ name: 'Set up job', conclusion: 'success' }, { name: 'Run tests', conclusion: 'success' }] };
    expect(failedDuringSetup(jobsRes([a, b, passing]))).toBe(true); // the passing job is irrelevant — only failing jobs are evaluated
  });
});

describe('forceNewSha (AC-408.2, #408) — the empirically-proven recovery: fresh SHA via rebase + repush', () => {
  it('fetches, rebases onto the base, and force-with-lease pushes, in order', async () => {
    const calls = [];
    const execRun = async (cmd, args) => { calls.push([cmd, ...args].join(' ')); return { ok: true, code: 0, stdout: '', stderr: '' }; };
    const res = await forceNewSha(execRun);
    expect(res).toEqual({ ok: true });
    expect(calls).toEqual(['git fetch origin main', 'git rebase origin/main', 'git push --force-with-lease']);
  });

  it('stops and surfaces the error at the first failing step (fetch/rebase/push)', async () => {
    const failFetch = await forceNewSha(async () => ({ ok: false, stderr: 'network down' }));
    expect(failFetch).toMatchObject({ ok: false, error: 'network down' });

    let step = 0;
    const failRebase = await forceNewSha(async () => (++step === 1 ? { ok: true } : { ok: false, stderr: 'CONFLICT' }));
    expect(failRebase).toMatchObject({ ok: false, error: 'CONFLICT' });
    expect(failRebase.error).toMatch(/CONFLICT/);

    step = 0;
    const failPush = await forceNewSha(async () => (++step <= 2 ? { ok: true } : { ok: false, stderr: 'stale ref' }));
    expect(failPush).toMatchObject({ ok: false, error: 'stale ref' });
  });
});

describe('runMerge — platform-outage recovery is bounded and honest (AC-408.2/AC-408.3/AC-408.4, #408)', () => {
  const heldVerdicts = { ship: true, gates: true, reviewer: true, security: true };
  const outageLog = { ok: false, stdout: '', stderr: 'Failed to resolve action download info. Error: Service Unavailable' };
  const setupFailureJobs = { ok: true, json: { jobs: [{ conclusion: 'failure', steps: [{ name: 'Set up job', conclusion: 'failure' }, { name: 'Complete job', conclusion: 'failure' }] }] } };

  // A gh double where the PR's rollup shows one real bad check (not empty — the
  // classification path only triggers on genuine bad checks, not "too early"),
  // and the job-structure lookup shows the failure happened during setup (the
  // structural corroboration `classifyCiFailure` requires — #408 security fix).
  const outageGhDouble = () => {
    const calls = [];
    const gh = async (args) => {
      calls.push(args.join(' '));
      if (args[0] === 'pr' && args[1] === 'view') {
        // workflowName present + a single distinct workflow across all bad
        // checks is what makes ci.classifiable true (#408, 3rd review pass).
        return { ok: true, json: { headRefName: 'feat/408-x', statusCheckRollup: [{ name: 'ci', conclusion: 'FAILURE', workflowName: 'verify' }] } };
      }
      if (args[0] === 'run' && args[1] === 'list') return { ok: true, json: [{ databaseId: 9, status: 'completed', createdAt: new Date().toISOString() }] };
      if (args[0] === 'run' && args[1] === 'view' && args.includes('jobs')) return setupFailureJobs;
      if (args[0] === 'run' && args[1] === 'view') return outageLog;
      return { ok: true };
    };
    return { calls, gh };
  };

  it('AC-408.2: an outage attempts recovery (fresh SHA) instead of routing straight to the fix-wave/escalation path', async () => {
    const { gh, calls } = outageGhDouble();
    const execCalls = [];
    const execRun = async (cmd, args) => { execCalls.push([cmd, ...args].join(' ')); return { ok: true, code: 0, stdout: '', stderr: '' }; };
    const journalCalls = [];
    const res = await runMerge(
      { config: {}, gh, cwd: '/fake/cwd' },
      { issue: 408, pr: 9, signals: heldVerdicts, outageAttempt: 0 },
      () => {},
      { execRun, journalAppend: async (...a) => { journalCalls.push(a); } },
    );
    expect(res).toMatchObject({ ok: true, merged: false, retried: true, outage: true, outageAttempt: 1, outcome: 'retry' });
    expect(execCalls).toEqual(['git fetch origin main', 'git rebase origin/main', 'git push --force-with-lease']);
    expect(calls.some((c) => c.startsWith('pr merge'))).toBe(false); // never merges mid-recovery
    // AC-408.4: the outage is journaled, distinguishable from a real gate failure.
    expect(journalCalls).toHaveLength(1);
    const [cwd, kind, data] = journalCalls[0];
    expect(cwd).toBe('/fake/cwd');
    expect(kind).toBe('gate-fail');
    expect(data).toMatchObject({ outage: true, phase: 'recovered', pr: 9 });
  });

  it('review fix (#408): a FAILED recovery attempt (rebase conflict / rejected push) still carries outage context, not just a raw git error', async () => {
    const { gh } = outageGhDouble();
    const journalCalls = [];
    const res = await runMerge(
      { config: {}, gh, cwd: '/fake/cwd' },
      { issue: 408, pr: 9, signals: heldVerdicts, outageAttempt: 0 },
      () => {},
      { execRun: async () => ({ ok: false, code: 1, stdout: '', stderr: 'CONFLICT (content): Merge conflict in file.mjs' }), journalAppend: async (...a) => { journalCalls.push(a); } },
    );
    expect(res.ok).toBe(false);
    expect(res.error).toContain('CONFLICT');
    expect(res.outage).toBe(true);
    expect(res.outageAttempt).toBe(1);
    expect(res.reason).toMatch(/platform-outage recovery attempt 1\/2 failed/);
    expect(journalCalls[0][2]).toMatchObject({ outage: true, phase: 'recovery-failed' });
  });

  it('AC-408.2: bounded — exhausts after maxOutageAttempts and falls through to a real blocked-on-ci result', async () => {
    const { gh, calls } = outageGhDouble();
    const journalCalls = [];
    const res = await runMerge(
      { config: {}, gh, cwd: '/fake/cwd' },
      { issue: 408, pr: 9, signals: heldVerdicts, outageAttempt: 2, maxOutageAttempts: 2 },
      () => {},
      { execRun: async () => { throw new Error('must NOT attempt recovery once exhausted'); }, journalAppend: async (...a) => { journalCalls.push(a); } },
    );
    expect(res.merged).toBe(false);
    expect(res.outageExhausted).toBe(true);
    expect(res.blockedOn).toContain('ci');
    expect(calls.some((c) => c.startsWith('pr merge'))).toBe(false);
    // AC-408.3: the honest reason distinguishes GitHub's outage from the change itself.
    expect(res.reason).toMatch(/GitHub Actions platform outage, not your change/);
    expect(journalCalls[0][2]).toMatchObject({ outage: true, phase: 'exhausted' });
  });

  it('AC-408.3: a real gate failure (not an outage signature) is never masked — routes to the ordinary bar-red path', async () => {
    const calls = [];
    const gh = async (args) => {
      calls.push(args.join(' '));
      if (args[0] === 'pr' && args[1] === 'view') {
        return { ok: true, json: { headRefName: 'feat/408-x', statusCheckRollup: [{ name: 'unit-tests', conclusion: 'FAILURE' }] } };
      }
      if (args[0] === 'run' && args[1] === 'list') return { ok: true, json: [{ databaseId: 9, status: 'completed', createdAt: new Date().toISOString() }] };
      if (args[0] === 'run' && args[1] === 'view') return { ok: false, stdout: '', stderr: 'AssertionError: 1 !== 2' };
      return { ok: true };
    };
    const res = await runMerge({ config: {}, gh }, { issue: 1, pr: 9, signals: heldVerdicts }, () => {}, { execRun: async () => { throw new Error('must not run recovery on a real failure'); } });
    expect(res.merged).toBe(false);
    expect(res.outage).toBeUndefined();
    expect(res.blockedOn).toContain('ci');
    expect(calls.some((c) => c.startsWith('pr merge'))).toBe(false);
  });

  it('never attempts outage classification on an empty rollup ("no checks reported yet") — cheap, common case stays untouched', async () => {
    const calls = [];
    const gh = async (args) => {
      calls.push(args.join(' '));
      if (args[0] === 'pr' && args[1] === 'view') return { ok: true, json: { headRefName: 'feat/x', statusCheckRollup: [] } };
      return { ok: true };
    };
    const res = await runMerge({ config: {}, gh }, { issue: 1, pr: 9, signals: heldVerdicts }, () => {});
    expect(res.blockedOn).toContain('ci');
    expect(calls).toEqual(['pr view 9 --json statusCheckRollup,headRefName']); // no run list / run view calls fired
  });

  it('SECURITY (3rd review pass, #408): a decoy workflow never masks a genuine failure in a DIFFERENT workflow — end to end', async () => {
    const calls = [];
    const gh = async (args) => {
      calls.push(args.join(' '));
      if (args[0] === 'pr' && args[1] === 'view') {
        return {
          ok: true,
          json: {
            headRefName: 'feat/408-x',
            statusCheckRollup: [
              { conclusion: 'FAILURE', name: 'actionlint', workflowName: 'verify' },   // a genuine GH outage on THIS workflow
              { conclusion: 'FAILURE', name: 'scan', workflowName: 'secret-scan' },    // a REAL failure on a DIFFERENT workflow
            ],
          },
        };
      }
      return { ok: true }; // run list/view must never even be called — classification is skipped entirely
    };
    const res = await runMerge(
      { config: {}, gh, cwd: '/fake/cwd' },
      { issue: 1, pr: 9, signals: heldVerdicts },
      () => {},
      { execRun: async () => { throw new Error('must NOT attempt recovery — the bad set spans multiple workflows'); } },
    );
    expect(res.merged).toBe(false);
    expect(res.outage).toBeUndefined(); // never even classified — ci.classifiable was false
    expect(res.blockedOn).toContain('ci');
    expect(calls).toEqual(['pr view 9 --json statusCheckRollup,headRefName']); // zero classification calls fired
  });

  it('review fix (#408, LOW): maxOutageAttempts is clamped server-side regardless of caller input', async () => {
    const { gh } = outageGhDouble();
    // A caller passing an absurd maxOutageAttempts still gets a bounded, sane cap.
    const res = await runMerge(
      { config: {}, gh, cwd: '/fake/cwd' },
      { issue: 408, pr: 9, signals: heldVerdicts, outageAttempt: 999999, maxOutageAttempts: 999999 },
      () => {},
      { execRun: async () => { throw new Error('must NOT attempt recovery — outageAttempt is already past the clamped ceiling'); } },
    );
    expect(res.merged).toBe(false);
    expect(res.outageExhausted).toBe(true);
    expect(res.reason).toContain('recovery exhausted after 10 attempt(s)'); // clamped to MAX_OUTAGE_ATTEMPTS_CEILING
  });

  it('does not require ctx.cwd — recovery still runs (just skips journaling) when no cwd is present', async () => {
    const { gh } = outageGhDouble();
    const res = await runMerge(
      { config: {}, gh /* no cwd */ },
      { issue: 408, pr: 9, signals: heldVerdicts },
      () => {},
      { execRun: async () => ({ ok: true, code: 0, stdout: '', stderr: '' }) },
    );
    expect(res).toMatchObject({ ok: true, retried: true, outage: true });
  });
});
