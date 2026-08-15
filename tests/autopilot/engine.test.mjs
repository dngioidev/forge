import { describe, it, expect, vi } from 'vitest';
import { mkdtemp, readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { selectNext, actionFor, actionableQueue, normalize } from '../../plugin/scripts/autopilot/select.mjs';
import { evaluateMergeBar, autoMergeEnabled, ciGreen, runMerge, BAR_SIGNALS, classifyCiFailure, forceNewSha, failedDuringSetup } from '../../plugin/scripts/autopilot/merge.mjs';
import { applyOutcome, applyFiled, guardTripped, nextIteration, renderReport, freshRun, startRun, recordOutcome, loadRun, RUN_RELPATH, DEFAULT_RUNAWAY_FACTOR, sanitizePositiveInt, sanitizeIterations } from '../../plugin/scripts/autopilot/ledger.mjs';
import { mergeAuthPreflight, isAutoMergeMode, MERGE_MODES } from '../../plugin/scripts/autopilot/preflight.mjs';
import { resolveReturnedTicket, STALL_OUTCOME, RESOLVED_OUTCOMES, NONCONFORMING_OUTCOME } from '../../plugin/scripts/autopilot/watchdog.mjs';
import { toType, fileWork, KIND_TO_TYPE } from '../../plugin/scripts/autopilot/newwork.mjs';
import { isShaped, DEFAULT_AC_HEADINGS } from '../../plugin/scripts/autopilot/readiness.mjs';
import { ALLOW, permsBlock } from '../../plugin/scripts/autopilot/perms.mjs';
import { ALLOWED_COMMAND_PREFIXES } from '../../plugin/scripts/lib/allowed-commands.mjs';
import {
  shouldPause, isFresh, configuredThresholdPct, loadUsage, evaluateSessionPause,
  DEFAULT_THRESHOLD_PCT, USAGE_RELPATH,
} from '../../plugin/scripts/autopilot/sessionpause.mjs';
import {
  shouldPauseForBudget, budgetCheckDue, evaluateRateBudget,
  DEFAULT_LOW_WATER, DEFAULT_CHECK_EVERY_N,
} from '../../plugin/scripts/autopilot/ratebudget.mjs';
import {
  evaluateEnvPreflight, formatBlockers, probeExecutable, probeNodeModules,
  probeBoardStatusKeys, probeStatuslinePath, parseStatuslineScriptPath, probeEnv,
  SELECT_STATUS_KEYS,
} from '../../plugin/scripts/autopilot/envpreflight.mjs';
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

describe('#499: selection consults pending decisions, not just board status', () => {
  it('AC-499.1, AC-499.2: a ticket at backlog with a pending decision is excluded regardless of status; resolved (absent from the set) it is selected again', () => {
    // The observed #438 case: board status drifted to backlog while the decision was still pending.
    const tickets = [t(438, 'backlog', 'p1')];
    expect(selectNext(tickets, { pendingIssues: new Set([438]) })).toBeNull();
    // once resolved, the caller's pendingIssues set no longer contains it — selectable again.
    expect(selectNext(tickets, { pendingIssues: new Set() }).ticket.number).toBe(438);
    expect(selectNext(tickets).ticket.number).toBe(438); // pendingIssues defaults to empty
  });

  it('AC-499.1: exclusion holds regardless of board status, not just backlog', () => {
    for (const status of ['inProgress', 'inReview', 'ready', 'backlog']) {
      expect(selectNext([t(1, status)], { pendingIssues: new Set([1]) })).toBeNull();
    }
  });

  it('AC-499.1: a pending decision only excludes ITS OWN ticket, not others in the pool', () => {
    const tickets = [t(1, 'ready', 'p0'), t(2, 'ready', 'p0')];
    const pick = selectNext(tickets, { pendingIssues: new Set([1]) });
    expect(pick.ticket.number).toBe(2);
  });

  it('AC-499.4: pendingIssues is threaded in, never mutated or read from elsewhere — same Set, repeatable, pure', () => {
    const pendingIssues = new Set([9]);
    const tickets = [t(9, 'backlog')];
    expect(selectNext(tickets, { pendingIssues })).toBeNull();
    expect(selectNext(tickets, { pendingIssues })).toBeNull(); // idempotent — no hidden state advances
    expect(pendingIssues).toEqual(new Set([9])); // untouched by the call
  });

  it('AC-499.3: an empty/omitted pendingIssues degrades safely — nothing is blocked and selection is unchanged', () => {
    const tickets = [t(1, 'ready', 'p0'), t(2, 'backlog', 'p1')];
    expect(selectNext(tickets, { pendingIssues: new Set() }).ticket.number).toBe(1);
    expect(selectNext(tickets).ticket.number).toBe(1);
    expect(actionableQueue(tickets, { pendingIssues: new Set() }).map((q) => q.ticket.number)).toEqual([1, 2]);
  });

  it('blocked status stays hard-excluded even with no pending decision (the blanket exclusion is deliberately retained, not dropped)', () => {
    expect(selectNext([t(1, 'blocked')], { pendingIssues: new Set() })).toBeNull();
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

describe('#491: readiness gate honors "Suggested"-qualified headings and dot-separated AC ids', () => {
  // AC-491.1: the two incidental spellings that defeated isShaped() before the
  // fix — a qualifier word ("Suggested") ahead of the heading term, and a
  // dot-separated id (AC.1) rather than dash-separated (AC-1).
  it('AC-491.1: a qualified heading and dot-separated ids are recognised', () => {
    expect(isShaped('## Suggested acceptance criteria\n\n- AC.1 do X\n- AC.2 do Y')).toBe(true);
    expect(isShaped('needs AC.12 to hold')).toBe(true);
    // dash-separated ids still work (unchanged behavior).
    expect(isShaped('needs AC-12 to hold')).toBe(true);
  });

  // AC-491.2: pinned against the real corpus from #491's evidence table. The
  // five false-negative bodies (verbatim/reconstructed from the ticket table —
  // #486/#487/#489/#490 have since been hand-edited on the live board to a
  // plain heading and are no longer live repros, so their table spelling is
  // reproduced here) must classify shaped; the three true positives stay
  // shaped; #452 is an explicit regression case.
  const falseNegatives = {
    // #438 — real, still-unedited body (ground truth repro named in the ticket).
    438: [
      '## Suggested acceptance criteria',
      '',
      "- AC.1 Decide the intended scope for the `node` allowlist entry: forge's own script tree only, anything inside the workspace, or anything on disk.",
      '- AC.2 If narrowed, the guard rejects paths escaping the workspace.',
    ].join('\n'),
    // #486/#487/#489/#490 — reconstructed per #491's evidence table: same
    // "Suggested acceptance criteria" heading + dotted ids convention as #438,
    // before those four tickets were hand-edited to a plain heading mid-run.
    486: '## Suggested acceptance criteria\n\n- AC.1 first\n- AC.3 third',
    487: '## Suggested acceptance criteria\n\n- AC.1 first\n- AC.2 second',
    489: '## Suggested acceptance criteria\n\n- AC.1 first\n- AC.2 second',
    490: '## Suggested acceptance criteria\n\n- AC.1 first\n- AC.2 second',
  };
  const truePositives = {
    436: '## Acceptance criteria (spike-shaped, mechanically checkable against the deliverable doc)\n\n- AC.3 ...\n- AC.6 ...',
    447: "## Acceptance criteria (this ticket's scope)\n\n- **AC.1** ...\n- **AC.2** ...",
    448: '## Acceptance criteria\n\n- **AC-448.1** ...\n- **AC-448.2** ...',
  };

  it('AC-491.2: the five false-negative bodies now classify as shaped', () => {
    for (const [issue, body] of Object.entries(falseNegatives)) {
      expect(isShaped(body), `#${issue} should be shaped`).toBe(true);
    }
  });

  it('AC-491.2: the three true-positive bodies stay shaped', () => {
    for (const [issue, body] of Object.entries(truePositives)) {
      expect(isShaped(body), `#${issue} should still be shaped`).toBe(true);
    }
  });

  it("AC-491.2: #452 is shaped on its own merits, not the AC-446 coincidence", () => {
    // #452's real body carries a "Suggested acceptance criteria (original...)"
    // heading and dotted ids, and separately cites `AC-446.6` from a different
    // ticket — which is what made the OLD id-only regex pass it by accident.
    // Strip that citation out: it must still classify shaped, via the heading.
    const withoutCoincidence = [
      '## Suggested acceptance criteria (original — see triage verdict below for the sharpened, superseding set)',
      '',
      '- AC.1 All four reproductions above are blocked.',
      '- AC.2 The safe-target cases stay unblocked.',
    ].join('\n');
    expect(isShaped(withoutCoincidence)).toBe(true);
    // and the real body (which does cite AC-446) still passes too.
    const realBody = [
      '## Suggested acceptance criteria (original — see triage verdict below for the sharpened, superseding set)',
      '',
      '- AC.1 All four reproductions above are blocked.',
      "- AC.2 The target-path NUL splice closed by #446 (`AC-446.6`) stays blocked.",
    ].join('\n');
    expect(isShaped(realBody)).toBe(true);
  });

  // AC-491.3: no false positives — this is the AC most at risk from an
  // over-eager widening, so it's tested hard, including near-miss words that
  // must keep failing after the heading regex grows a qualifier-word allowance.
  it('AC-491.3: a genuinely unshaped ticket (prose only) stays unshaped', () => {
    expect(isShaped('Just a one-line idea, no shape, no criteria of any kind.')).toBe(false);
    expect(isShaped('We should probably fix the flaky test at some point.')).toBe(false);
    expect(isShaped('')).toBe(false);
    expect(isShaped(undefined)).toBe(false);
  });

  it('AC-491.3: near-miss words keep failing even with the qualifier allowance', () => {
    // the pre-existing guard case: a longer word sharing the "Acceptance" prefix.
    expect(isShaped('## Acceptances of the plan were noted')).toBe(false);
    // a qualifier word ahead of a near-miss word — still no real heading term.
    expect(isShaped('## Draft Acceptances of the plan')).toBe(false);
    // "AC" as a bare word/acronym elsewhere, not an id (no digits).
    expect(isShaped('the AC unit in the office is broken')).toBe(false);
    // an unrelated numbered list is not an AC id.
    expect(isShaped('See step 1.2 in the runbook for details.')).toBe(false);
    // a heading that is not about acceptance criteria at all.
    expect(isShaped('## Suggested next steps\n\n- do X\n- do Y')).toBe(false);
    // a NEGATION word ahead of the heading term reads as denying it, not
    // qualifying it, and isn't on the curated QUALIFIER_WORDS list either way.
    expect(isShaped('## Not acceptance criteria, just prose mentioning it')).toBe(false);
    expect(isShaped('## No acceptance criteria yet, sorry')).toBe(false);
    expect(isShaped('## Without acceptance criteria this ticket is incomplete')).toBe(false);
  });

  // AC-491.3 fix-wave regression (adversarial review, round 1): an earlier
  // draft allowed ANY single word ahead of the bare heading term "Acceptance"
  // — wide enough to swallow ordinary two-word phrases where "Acceptance" is
  // used in an unrelated sense. None of these carry acceptance criteria; all
  // must stay unshaped. The fix requires BOTH a curated qualifier word AND a
  // literal trailing "criteria" — these fail on one or both counts.
  it('AC-491.3: an unrelated "<word> Acceptance <noun>" phrase is not mistaken for a qualified heading', () => {
    expect(isShaped('## User Acceptance Testing\n\nWe need to schedule UAT sessions with the client next week.')).toBe(false);
    expect(isShaped('## Draft Acceptance email to client\n\nPlease review the wording before sending.')).toBe(false);
    expect(isShaped('## Team Acceptance updates\n\nStatus sync only, nothing actionable yet.')).toBe(false);
    expect(isShaped('## Client Acceptance sign-off pending\n\nWaiting on legal.')).toBe(false);
    // a curated qualifier word immediately before "Acceptance" but with no
    // trailing "criteria" — the qualifier alone is not enough.
    expect(isShaped('## Suggested Acceptance Testing schedule\n\nProposed dates below.')).toBe(false);
  });

  // AC-491.5: assert the routing OUTCOME (actionFor/selectNext), not merely
  // the predicate — a shaped ticket must not be escalate-and-skipped for a
  // spelling reason under plain (non --shape) autopilot, the default mode.
  it('AC-491.5: a ticket shaped only via the qualified-heading/dotted-id spelling is never escalate-and-skipped', () => {
    const body = '## Suggested acceptance criteria\n\n- AC.1 do X\n- AC.2 do Y';
    const ready = isShaped(body);
    expect(ready).toBe(true);
    const ticket = { ...t(438, 'backlog', 'p1'), ready };
    // default mode (no --shape): must route to triage/deliver, never escalate.
    expect(selectNext([ticket], { shape: false }).action).not.toBe('escalate');
    expect(selectNext([ticket], { shape: false }).action).toBe('triage');
    // crazy mode: must not waste a shape spawn either.
    expect(selectNext([ticket], { shape: true }).action).not.toBe('shape');
  });

  // AC-491.4: the accepted conventions are documented where a ticket
  // author/shaper meets them, so nobody is guessing which spelling the gate
  // honours. Mechanical check, not a vibe check: the skill prose must
  // actually name the qualifier-heading and dotted-id conventions.
  it('AC-491.4: triage and shape skill prose document the accepted heading/id conventions', async () => {
    const pluginRoot = fileURLToPath(new URL('../../plugin/', import.meta.url));
    const triage = await readFile(join(pluginRoot, 'skills/triage/SKILL.md'), 'utf8');
    const shape = await readFile(join(pluginRoot, 'skills/shape/SKILL.md'), 'utf8');
    for (const doc of [triage, shape]) {
      expect(doc).toMatch(/isShaped/);
      expect(doc).toMatch(/Suggested acceptance criteria/);
      expect(doc).toMatch(/AC\.1/);
      expect(doc).toMatch(/#491/);
    }
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

    it('isFreshGreenTransition: same pr + pass + within the window + matching headRefOid -> true', () => {
      const state = { pr: 9, state: 'pass', sha: 'aaa111', at: new Date(now - 5000).toISOString() };
      expect(isFreshGreenTransition(state, 9, { now, maxAgeMs: 20000, headRefOid: 'aaa111' })).toBe(true);
    });

    it('isFreshGreenTransition: wrong pr, non-pass, stale, or unparsable timestamp all fall through', () => {
      const at = new Date(now - 5000).toISOString();
      const opts = { now, maxAgeMs: 20000, headRefOid: 'aaa111' };
      expect(isFreshGreenTransition({ pr: 10, state: 'pass', sha: 'aaa111', at }, 9, opts)).toBe(false); // wrong pr
      expect(isFreshGreenTransition({ pr: 9, state: 'pending', sha: 'aaa111', at }, 9, opts)).toBe(false); // not pass
      expect(isFreshGreenTransition({ pr: 9, state: 'fail', sha: 'aaa111', at }, 9, opts)).toBe(false); // not pass
      expect(isFreshGreenTransition({ pr: 9, state: 'pass', sha: 'aaa111', at: new Date(now - 999999).toISOString() }, 9, opts)).toBe(false); // stale
      expect(isFreshGreenTransition({ pr: 9, state: 'pass', sha: 'aaa111', at: 'not-a-date' }, 9, { now, headRefOid: 'aaa111' })).toBe(false); // unparsable
      expect(isFreshGreenTransition(null, 9, { now, headRefOid: 'aaa111' })).toBe(false); // no state at all
    });

    // #411 — the fresh-transition shortcut must bind to the PR's CURRENT head
    // commit, not just replay a same-pr/pass/timestamp match. Without this, a
    // push landing inside the freshness window (after the monitor's last
    // "pass" poll, before its next one) could let a stale green for the OLD
    // commit satisfy the check for the NEW one.
    describe('#411 — the shortcut is bound to the current commit, not just pr/state/age', () => {
      it('isFreshGreenTransition: a stale sha (HEAD moved since the cached pass) is rejected even though pr/state/age all match', () => {
        const state = { pr: 9, state: 'pass', sha: 'aaa111', at: new Date(now - 5000).toISOString() };
        expect(isFreshGreenTransition(state, 9, { now, maxAgeMs: 20000, headRefOid: 'bbb222' })).toBe(false);
      });

      it('isFreshGreenTransition: no headRefOid supplied at all fails closed (never silently skips the sha check)', () => {
        const state = { pr: 9, state: 'pass', sha: 'aaa111', at: new Date(now - 5000).toISOString() };
        expect(isFreshGreenTransition(state, 9, { now, maxAgeMs: 20000 })).toBe(false);
      });

      it('isFreshGreenTransition: a cached reading with no sha of its own is rejected even against a real current head', () => {
        const state = { pr: 9, state: 'pass', at: new Date(now - 5000).toISOString() }; // pre-#411 shape, no sha
        expect(isFreshGreenTransition(state, 9, { now, maxAgeMs: 20000, headRefOid: 'aaa111' })).toBe(false);
      });

      it('ciGreen: a stale-SHA transition is rejected — falls through to the real gh re-fetch even though pr/state/age all matched', async () => {
        let calls = 0;
        const gh = async () => { calls++; return { ok: true, json: { statusCheckRollup: [{ conclusion: 'SUCCESS' }] } }; };
        const freshState = { pr: 9, state: 'pass', sha: 'aaa111', at: new Date(now - 3000).toISOString() };
        const res = await ciGreen(gh, 9, { freshState, now, maxAgeMs: 20000, headRefOid: 'bbb222' }); // HEAD moved since the cached pass
        expect(res.green).toBe(true); // still green — but via the real re-fetch, not the shortcut
        expect(res.viaFreshTransition).toBeUndefined();
        expect(calls).toBe(1); // the re-fetch DID fire — a stale sha never short-circuits the check
      });
    });

    it('ciGreen: a fresh, SHA-bound known-green transition satisfies the check WITHOUT calling gh', async () => {
      let calls = 0;
      const gh = async () => { calls++; return { ok: true, json: { statusCheckRollup: [] } }; }; // would be NOT green if actually called
      const freshState = { pr: 9, state: 'pass', sha: 'aaa111', at: new Date(now - 3000).toISOString() };
      const res = await ciGreen(gh, 9, { freshState, now, maxAgeMs: 20000, headRefOid: 'aaa111' });
      expect(res).toMatchObject({ ok: true, green: true, viaFreshTransition: true });
      expect(calls).toBe(0); // the redundant GraphQL re-fetch never fired
    });

    it('ciGreen: a stale/wrong-pr/missing freshState always falls through to the real re-fetch — the safety property stays intact', async () => {
      let calls = 0;
      const gh = async () => { calls++; return { ok: true, json: { statusCheckRollup: [{ conclusion: 'SUCCESS' }] } }; };
      await ciGreen(gh, 9, { freshState: null, headRefOid: 'aaa111' });
      await ciGreen(gh, 9, { freshState: { pr: 10, state: 'pass', sha: 'aaa111', at: new Date(now - 1000).toISOString() }, now, headRefOid: 'aaa111' });
      await ciGreen(gh, 9, { freshState: { pr: 9, state: 'pass', sha: 'aaa111', at: new Date(now - 999999).toISOString() }, now, headRefOid: 'aaa111' });
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

  it('AC-407.2/#411: a fresh, SHA-bound forge-ci monitor transition on disk lets runMerge skip its own "pr view" re-fetch', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'forge-merge-'));
    await writeCiWatchState(cwd, { pr: 9, state: 'pass', sha: 'aaa111' }); // "at" defaults to now
    const calls = [];
    const gh = async (args) => {
      calls.push(args.join(' '));
      if (args[0] === 'pr' && args[1] === 'view') throw new Error('should not re-fetch — a fresh, SHA-bound transition was already on disk');
      return { ok: true };
    };
    // #411: the local head-sha lookup (`git rev-parse HEAD`) is injected — HEAD matches the cached reading's sha.
    const execFn = async (cmd, args) => {
      expect(cmd).toBe('git');
      expect(args).toEqual(['-C', cwd, 'rev-parse', 'HEAD']);
      return { ok: true, stdout: 'aaa111\n', stderr: '' };
    };
    const res = await runMerge({ config: {}, gh, cwd }, { issue: 1, pr: 9, signals: heldVerdicts }, () => {}, { execFn });
    expect(res).toMatchObject({ ok: true, merged: true, outcome: 'merged' });
    expect(calls.some((c) => c.startsWith('pr view'))).toBe(false);
    // #411: the live merge is pinned to the exact sha ciGreen just confirmed —
    // the AUTHORITATIVE bind (GitHub validates this server-side at merge time).
    expect(calls).toContain('pr merge 9 --squash --delete-branch --match-head-commit aaa111');
  });

  it('AC-407.2: a stale/absent ci-watch.json still runs the real pre-merge re-check (no ctx.cwd or no file = today\'s behavior)', async () => {
    const { calls, gh } = ghDouble(green);
    // no cwd on ctx at all — must behave exactly as before this ticket
    const res = await runMerge({ config: {}, gh }, { issue: 1, pr: 9, signals: heldVerdicts }, () => {});
    expect(res.merged).toBe(true);
    expect(calls).toContain('pr view 9 --json statusCheckRollup,headRefName,headRefOid');
  });

  it('#411: the real re-fetch path ALSO pins the live merge — --match-head-commit uses the freshly-fetched headRefOid', async () => {
    const calls = [];
    const gh = async (args) => {
      calls.push(args.join(' '));
      if (args[0] === 'pr' && args[1] === 'view') return { ok: true, json: { statusCheckRollup: green, headRefOid: 'live-sha' } };
      return { ok: true };
    };
    // no cwd → no shortcut candidate at all — this exercises the plain re-fetch path picking up headRefOid.
    const res = await runMerge({ config: {}, gh }, { issue: 1, pr: 9, signals: heldVerdicts }, () => {});
    expect(res.merged).toBe(true);
    expect(calls).toContain('pr merge 9 --squash --delete-branch --match-head-commit live-sha');
  });

  it('#411: a gh response that omits headRefOid degrades to the pre-#411 unpinned merge call — never blocks an otherwise-green merge', async () => {
    const { calls, gh } = ghDouble(green); // ghDouble's mocked pr-view response has no headRefOid field
    const res = await runMerge({ config: {}, gh }, { issue: 1, pr: 9, signals: heldVerdicts }, () => {});
    expect(res.merged).toBe(true);
    expect(calls).toContain('pr merge 9 --squash --delete-branch'); // no --match-head-commit appended
  });

  it('#411: a stale-SHA transition (HEAD moved since the cached "pass") is rejected — the merge still succeeds, but via the real re-check', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'forge-merge-'));
    await writeCiWatchState(cwd, { pr: 9, state: 'pass', sha: 'old-sha' }); // cached BEFORE a push moved HEAD
    const calls = [];
    const gh = async (args) => {
      calls.push(args.join(' '));
      if (args[0] === 'pr' && args[1] === 'view') return { ok: true, json: { statusCheckRollup: green } };
      return { ok: true };
    };
    const execFn = async () => ({ ok: true, stdout: 'new-sha\n', stderr: '' }); // HEAD has since moved past the cached reading
    const res = await runMerge({ config: {}, gh, cwd }, { issue: 1, pr: 9, signals: heldVerdicts }, () => {}, { execFn });
    expect(res).toMatchObject({ ok: true, merged: true, outcome: 'merged' }); // still merges — CI IS green, just confirmed for real
    expect(calls.some((c) => c.startsWith('pr view'))).toBe(true); // the stale cached "pass" did NOT short-circuit the check
  });

  it('#411: a failed local `git rev-parse HEAD` (execFn error) fails closed to the real re-check, never crashes', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'forge-merge-'));
    await writeCiWatchState(cwd, { pr: 9, state: 'pass', sha: 'aaa111' });
    const { gh, calls } = ghDouble(green);
    const execFn = async () => ({ ok: false, stdout: '', stderr: 'not a git repo' });
    const res = await runMerge({ config: {}, gh, cwd }, { issue: 1, pr: 9, signals: heldVerdicts }, () => {}, { execFn });
    expect(res).toMatchObject({ ok: true, merged: true, outcome: 'merged' });
    expect(calls.some((c) => c.startsWith('pr view'))).toBe(true);
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
    for (const outcome of RESOLVED_OUTCOMES) {
      const dec = resolveReturnedTicket({ outcome, pr: 42, ciGreen: true, mergeMode: 'auto-merge' });
      expect(dec.action, outcome).toBe('continue');
      expect(dec.outcome, outcome).toBe(outcome); // record the outcome the subagent already reported
    }
    // #464: an absent/unknown outcome is NOT a resolved state — it is the second stall shape
    // (§ AC-464 below), never a silent `continue`/`outcome: null`. This assertion used to expect
    // `continue` here; that was the exact gap #464 fixes, so the expectation flips.
    const noReport = resolveReturnedTicket({});
    expect(noReport.action).toBe('respawn');
    expect(noReport.outcome).toBe(NONCONFORMING_OUTCOME);
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

describe('autopilot watchdog — stalled-before-PR: the second return-then-resume shape (#464, epic #183)', () => {
  // The 2026-08-11/13 run: a delivery subagent spawns a reviewer/security subagent, then RETURNS
  // before opening a PR (or with one still awaiting review), with a terminal report that is not the
  // {issue, outcome, pr, ciGreen, ...} contract at all — free text like "Waiting on the reviewer's
  // re-confirmation." resolveReturnedTicket has no `awaiting-merge` outcome to match, so before this
  // fix it fell through as `action: continue, outcome: null` — recorded as if resolved. That must
  // become a distinct, actionable, non-silent state instead (AC.1/AC.2).

  it('AC-464.1: a missing outcome with no PR classifies as stalled-before-pr, never continue/outcome:null', () => {
    const dec = resolveReturnedTicket({ outcome: undefined, pr: null });
    expect(dec.action).toBe('respawn');
    expect(dec.action).not.toBe('continue');
    expect(dec.outcome).toBe('stalled-before-pr');
    expect(dec.outcome).not.toBeNull();
    expect(dec.pr).toBeNull();
    expect(dec.reason).toMatch(/non-conforming|stalled/i);
  });

  it('AC-464.1: an unrecognised free-text outcome (not one of the known resolved states) is likewise classified, never recorded as a terminal outcome', () => {
    for (const outcome of ["Waiting on the reviewer's re-confirmation", "I'm waiting on both re-review verdicts for the final tip.", 'garbled', '']) {
      const dec = resolveReturnedTicket({ outcome, pr: null });
      expect(dec.action, outcome).toBe('respawn');
      expect(dec.outcome, outcome).toBe(NONCONFORMING_OUTCOME);
      expect(dec.outcome, outcome).not.toBe(outcome); // the free text itself is never recorded as the outcome
    }
  });

  it('AC-464.2: stalled-before-pr (action:respawn) is a distinct action from awaiting-merge (action:merge/escalate) — different recoveries', () => {
    const stalled = resolveReturnedTicket({ outcome: undefined, pr: null });
    const awaitingMerge = resolveReturnedTicket({ outcome: STALL_OUTCOME, pr: 42, ciGreen: true, mergeMode: 'auto-merge' });
    expect(stalled.action).toBe('respawn');
    expect(awaitingMerge.action).toBe('merge');
    expect(stalled.action).not.toBe(awaitingMerge.action);
    // also distinct from select.mjs's own unrelated 'resume' selection action (#464 review finding)
    expect(stalled.action).not.toBe('resume');
  });

  it('AC-464.2: pr is carried through when the stalled subagent already had one open (vs null when it never reached a PR)', () => {
    const noPr = resolveReturnedTicket({ outcome: undefined, pr: null });
    expect(noPr.pr).toBeNull();
    const withPr = resolveReturnedTicket({ outcome: undefined, pr: 4321 });
    expect(withPr.pr).toBe(4321);
    expect(withPr.action).toBe('respawn');
    expect(withPr.outcome).toBe(NONCONFORMING_OUTCOME);
  });

  it('AC-464.3: resolveReturnedTicket stays pure — same input always yields the same output, no IO', () => {
    const input = { outcome: 'Waiting on the reviewer', pr: 99 };
    const a = resolveReturnedTicket(input);
    const b = resolveReturnedTicket({ ...input });
    expect(a).toEqual(b);
  });

  // AC.4: pin the four observed instances from the 2026-08-11/13 run verbatim.
  describe('AC-464.4: the four observed instances', () => {
    it('#429: branch pushed at 4631286, no PR, awaiting reviewer re-confirmation', () => {
      const dec = resolveReturnedTicket({ outcome: "Waiting on the reviewer's re-confirmation.", pr: null });
      expect(dec.action).toBe('respawn');
      expect(dec.outcome).toBe('stalled-before-pr');
      expect(dec.pr).toBeNull();
    });

    it('#437: branch pushed, PR open, awaiting reviewer (compounded by a session-limit kill)', () => {
      const dec = resolveReturnedTicket({ outcome: 'Killed mid-flight awaiting reviewer re-confirmation', pr: 437 });
      expect(dec.action).toBe('respawn');
      expect(dec.outcome).toBe('stalled-before-pr');
      expect(dec.pr).toBe(437); // a PR already exists — resume should not re-open a duplicate one
    });

    it('#446: branch pushed at 1e41745, no PR, awaiting an escalation answer', () => {
      const dec = resolveReturnedTicket({ outcome: 'Awaiting the escalation answer before proceeding.', pr: null });
      expect(dec.action).toBe('respawn');
      expect(dec.outcome).toBe('stalled-before-pr');
      expect(dec.pr).toBeNull();
    });

    it('#460: branch pushed at a0df69d, no PR, awaiting BOTH re-review verdicts the orchestrator already holds', () => {
      // The distinguishing wrinkle: the orchestrator was already holding both verdicts when the
      // subagent returned to wait for them — this ticket only needs the watchdog to surface the
      // stall as actionable, not to relay the held verdicts automatically (that is #474, out of
      // scope here).
      const dec = resolveReturnedTicket({ outcome: "I'm waiting on both re-review verdicts for the final tip.", pr: null });
      expect(dec.action).toBe('respawn');
      expect(dec.outcome).toBe('stalled-before-pr');
      expect(dec.pr).toBeNull();
      expect(dec.action).not.toBe('continue'); // never silently parked despite the orchestrator holding the answer
    });
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

  // #488: the factor is now an explicit 3rd arg in these formula-shape tests (was the
  // default) so the general board-size×factor arithmetic stays pinned regardless of what
  // DEFAULT_RUNAWAY_FACTOR is calibrated to; the default itself is pinned separately below.
  it('loop backstop trips at board size × factor', () => {
    const run = { ...freshRun(), iterations: 8 };
    expect(guardTripped(run, 4, 2)).toBe(true);   // 8 >= 4*2
    expect(guardTripped({ ...freshRun(), iterations: 7 }, 4, 2)).toBe(false);
  });

  // #317: the backstop had no runtime caller — nextIteration is that caller. It is the
  // per-iteration guard the loop MUST call first each iteration; it delegates to
  // guardTripped and turns a trip into a halt+escalate decision (not silent continue).
  it('AC-317.1: nextIteration invokes the backstop and returns continue under the cap', () => {
    const dec = nextIteration({ ...freshRun(), iterations: 3 }, 4, 2); // cap = 4×2 = 8
    expect(dec.stop).toBe(false);
    expect(dec.escalate).toBe(false);
    expect(dec.cap).toBe(8);
    expect(dec.iterations).toBe(3);
    expect(dec.reason).toBeNull();
    // it delegates to guardTripped — same verdict, under and at the cap boundary.
    expect(dec.stop).toBe(guardTripped({ ...freshRun(), iterations: 3 }, 4, 2));
    expect(nextIteration({ ...freshRun(), iterations: 7 }, 4, 2).stop).toBe(false); // 7 < 8
    // honours a custom factor and the boardSize floor (max(1,·)).
    expect(nextIteration({ ...freshRun(), iterations: 3 }, 1, 3).stop).toBe(true); // 3 >= 1×3
    expect(nextIteration({ ...freshRun(), iterations: 1 }, 0, 2).cap).toBe(2);        // floor: max(1,0)×2
  });

  // #488 AC.1: omitting factor now uses DEFAULT_RUNAWAY_FACTOR (4), not the old default of
  // 2 — the old default was calibrated for pre-#468 economics (~1 iteration/ticket) and,
  // post-#468 (2-3 iterations/ticket), sat AT the real cost instead of above it.
  it('AC-488.1: nextIteration defaults to DEFAULT_RUNAWAY_FACTOR when no factor is given', () => {
    expect(DEFAULT_RUNAWAY_FACTOR).toBeGreaterThan(3); // strictly above the worst known per-ticket cost
    expect(nextIteration({ ...freshRun(), iterations: 1 }, 0).cap).toBe(DEFAULT_RUNAWAY_FACTOR); // floor: max(1,0)×factor
    expect(guardTripped({ ...freshRun(), iterations: 4 * DEFAULT_RUNAWAY_FACTOR - 1 }, 4)).toBe(false);
    expect(guardTripped({ ...freshRun(), iterations: 4 * DEFAULT_RUNAWAY_FACTOR }, 4)).toBe(true);
  });

  it('AC-317.2: a runaway loop is HALTED by the per-iteration guard at board size × factor', () => {
    const boardSize = 3; // cap = 3×2 = 6 (factor pinned explicitly — see #488 note above)
    let run = freshRun('2026-07-26T00:00:00Z');
    let iterationsRun = 0;
    let halted = null;
    // Simulate the orchestrator: guard FIRST each iteration, then do (pathological) work
    // that never converges — file a ticket and record an outcome every iteration, forever.
    // Without the wired guard this loops until the 1000 safety cap; with it, it halts at 6.
    for (let i = 0; i < 1000; i++) {
      const dec = nextIteration(run, boardSize, 2);
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

  // #488 AC.2/AC.3/AC.4/AC.5 — the runaway backstop recalibration.
  describe('#488: the runaway backstop accounts for the #468 per-ticket iteration cost', () => {
    it('AC-488.2: a healthy full-board clear at the real #468 per-ticket cost does not trip', () => {
      // The exact reported false positive: an 18-ticket board, 2 iterations/ticket
      // (triage→record, deliver→record) — a PERFECT clear used to land exactly on the cap.
      const boardSize = 18;
      const run = { ...freshRun('2026-08-11T18:44:15.973Z'), boardSizeAtStart: boardSize, iterations: boardSize * 2 };
      const dec = nextIteration(run, boardSize);
      expect(dec.stop).toBe(false);
      // even the worst-case #468 cost (3, an unshaped ticket under --shape) must clear too.
      const shapeRun = { ...freshRun(), boardSizeAtStart: boardSize, iterations: boardSize * 3 };
      expect(nextIteration(shapeRun, boardSize).stop).toBe(false);
    });

    it('AC-488.3a: a run that files a new ticket every iteration without closing any is still halted', () => {
      const boardSize = 3;
      let run = { ...freshRun('2026-08-14T00:00:00Z'), boardSizeAtStart: boardSize };
      let halted = null;
      for (let i = 0; i < 1000; i++) {
        const dec = nextIteration(run, boardSize);
        if (dec.stop) { halted = dec; break; }
        run = applyFiled(run, { issue: 900 + i, kind: 'bug', from: 1 });
        run = { ...run, iterations: run.iterations + 1 }; // an iteration spent, nothing ever resolved
      }
      expect(halted).not.toBeNull();
      expect(halted.escalate).toBe(true);
      expect(halted.reason).toMatch(/no progress is being made/);
    });

    it("AC-488.3b: #487's re-selection loop (same ticket reselected, no board-state change) is still halted", () => {
      const boardSize = 5;
      let run = { ...freshRun('2026-08-14T00:00:00Z'), boardSizeAtStart: boardSize };
      let halted = null;
      for (let i = 0; i < 1000; i++) {
        const dec = nextIteration(run, boardSize);
        if (dec.stop) { halted = dec; break; }
        // the SAME issue re-recorded every iteration — last-write-wins means run.outcomes
        // never grows past length 1, no matter how many iterations run (#487's shape).
        run = applyOutcome(run, { issue: 487, outcome: 'escalated', stage: 'deliver' });
      }
      expect(halted).not.toBeNull();
      expect(halted.escalate).toBe(true);
      expect(halted.reason).toMatch(/no progress is being made/);
    });

    it('AC-488.4: the cap does not shrink as the live board count falls once anchored at run start', () => {
      // 34 iterations in, only 2 tickets remain live — the pre-#488 bug would recompute the
      // cap off the live count (2×factor) and trip; the anchor keeps it at the run-start size.
      const run = { ...freshRun('2026-08-11T18:44:15.973Z'), boardSizeAtStart: 18, iterations: 34 };
      const dec = nextIteration(run, 2); // caller still passes the live (shrunk) board size
      expect(dec.cap).toBe(18 * DEFAULT_RUNAWAY_FACTOR); // anchor wins over the live boardSize argument
      expect(dec.stop).toBe(false);
    });

    it('AC-488.5: reason text distinguishes no-progress from long-but-healthy at trip time', () => {
      // no-progress shape: 20 iterations, only 1 distinct issue ever resolved (#487's shape).
      const noProgressRun = {
        ...freshRun(), boardSizeAtStart: 5, iterations: 20,
        outcomes: [{ issue: 487, outcome: 'escalated', ref: null, stage: 'deliver', at: '2026-08-14T00:00:00Z' }],
      };
      const noProgressDec = nextIteration(noProgressRun, 5);
      expect(noProgressDec.stop).toBe(true);
      expect(noProgressDec.reason).toMatch(/no progress is being made/);
      expect(noProgressDec.reason).not.toMatch(/simply been long/);

      // long-but-healthy shape: most of the board resolved by trip time, still hit the cap.
      const outcomes = Array.from({ length: 16 }, (_, i) => (
        { issue: 2000 + i, outcome: 'merged', ref: `PR#${i}`, stage: 'deliver', at: '2026-08-14T00:00:00Z' }
      ));
      const longRun = { ...freshRun(), boardSizeAtStart: 5, iterations: 20, outcomes };
      const longDec = nextIteration(longRun, 5);
      expect(longDec.stop).toBe(true);
      expect(longDec.reason).toMatch(/simply been long/);
      expect(longDec.reason).not.toMatch(/no progress is being made/);
    });

    it('AC-488.4b: startRun persists boardSizeAtStart once and never recomputes it on resume', async () => {
      const cwd = await mkdtemp(join(tmpdir(), 'forge-autopilot-'));
      const started = await startRun(cwd, { boardSize: 18 });
      expect(started.boardSizeAtStart).toBe(18);
      await recordOutcome(cwd, { issue: 1, outcome: 'merged', ref: 'PR#1' });
      // board shrinks live — resume must NOT recompute the anchor down to the new size.
      const resumed = await startRun(cwd, { boardSize: 5 });
      expect(resumed.boardSizeAtStart).toBe(18);
    });

    it('AC-488.4c: an existing (pre-#488) ledger with no boardSizeAtStart field resumes and backfills gracefully', async () => {
      const cwd = await mkdtemp(join(tmpdir(), 'forge-autopilot-'));
      // simulate a real pre-#488 ledger on disk (mirrors the repo's own live run.json shape).
      await writeJson(join(cwd, RUN_RELPATH), {
        version: 1, startedAt: '2026-08-11T18:44:15.973Z', iterations: 36, outcomes: [], filed: [],
        mergeMode: 'auto-merge', mergeReason: null,
      });
      const resumed = await startRun(cwd, { boardSize: 12 });
      expect(resumed.boardSizeAtStart).toBe(12); // backfilled from the live size at first post-#488 resume
      expect(resumed.iterations).toBe(36); // existing progress untouched
      const resumedAgain = await startRun(cwd, { boardSize: 2 }); // a later resume must not re-anchor
      expect(resumedAgain.boardSizeAtStart).toBe(12);
    });

    it('AC-488.4d: an un-upgraded startRun call (no boardSize opt) leaves the anchor unset — nextIteration falls back to the live boardSize argument', async () => {
      const cwd = await mkdtemp(join(tmpdir(), 'forge-autopilot-'));
      const started = await startRun(cwd);
      expect(started.boardSizeAtStart).toBeNull();
      expect(nextIteration(started, 4).cap).toBe(4 * DEFAULT_RUNAWAY_FACTOR);
    });

    // Adversarial security review finding (critical, fix-wave): run.json is disk state —
    // a corrupted/hand-edited boardSizeAtStart or iterations must never silently DISABLE
    // the backstop by making the cap comparison NaN/Infinity-always-false. Fail CLOSED
    // (trip early) on corrupt numeric state, never fail OPEN (never trip).
    describe('#488 security fix-wave: disk-sourced numeric state cannot silently disable the guard', () => {
      it('sanitizePositiveInt rejects Infinity, NaN, negatives, zero, and non-numbers — only a finite positive number (or its floor) passes', () => {
        expect(sanitizePositiveInt(18)).toBe(18);
        expect(sanitizePositiveInt(2.9)).toBe(2); // floored
        expect(sanitizePositiveInt(Infinity)).toBeNull();
        expect(sanitizePositiveInt(-Infinity)).toBeNull();
        expect(sanitizePositiveInt(NaN)).toBeNull();
        expect(sanitizePositiveInt(0)).toBeNull();
        expect(sanitizePositiveInt(-5)).toBeNull();
        expect(sanitizePositiveInt('18')).toBeNull(); // wrong type, not coerced
        expect(sanitizePositiveInt(undefined)).toBeNull();
        expect(sanitizePositiveInt(null)).toBeNull();
        expect(sanitizePositiveInt(undefined, 1)).toBe(1); // fallback honoured
      });

      // 2nd security pass (fix-wave re-review): a value in the open interval (0, 1) is
      // finite and > 0 but floors to 0 — checking `value > 0` before flooring let a
      // corrupted 0.5 silently pass as "0", contradicting "never a garbage value".
      it('AC-488.SEC6: sanitizePositiveInt rejects a sub-1 fraction that would floor to 0, returning the fallback instead', () => {
        expect(sanitizePositiveInt(0.5)).toBeNull();
        expect(sanitizePositiveInt(0.999)).toBeNull();
        expect(sanitizePositiveInt(0.5, 1)).toBe(1); // fallback honoured, never silently 0
        // never leaks a 0 anchor into the guard: a run with a decimal-corrupted anchor
        // must not spuriously trip on the very first iteration.
        const run = { ...freshRun(), boardSizeAtStart: 0.5, iterations: 0 };
        expect(nextIteration(run, 5).cap).toBe(5 * DEFAULT_RUNAWAY_FACTOR); // falls back to the live boardSize, not 0
      });

      it('sanitizeIterations fails CLOSED (Infinity, i.e. "trip now") on a corrupted run.iterations, never open', () => {
        expect(sanitizeIterations({ iterations: 12 })).toBe(12);
        expect(sanitizeIterations({ iterations: Infinity })).toBe(Infinity);
        expect(sanitizeIterations({ iterations: NaN })).toBe(Infinity);
        expect(sanitizeIterations({ iterations: -1 })).toBe(Infinity);
        expect(sanitizeIterations({ iterations: '36' })).toBe(Infinity); // wrong type
        expect(sanitizeIterations({})).toBe(Infinity);
      });

      it('AC-488.SEC1: a boardSizeAtStart corrupted to Infinity (valid JSON: 1e999) does NOT permanently disable the backstop', () => {
        // The exact critical finding: JSON.parse('1e999') === Infinity, and the old
        // Math.max(1, x) floor did not neutralize it — cap became Infinity, so the guard
        // could never trip again for the rest of the run.
        const run = { ...freshRun(), boardSizeAtStart: JSON.parse('1e999'), iterations: 1_000_000 };
        expect(run.boardSizeAtStart).toBe(Infinity);
        const dec = nextIteration(run, 5); // live boardSize also supplied, must not be trusted as the rescue path either — it IS used as fallback, but the corrupted anchor must not win by being "present"
        expect(Number.isFinite(dec.cap)).toBe(true); // never Infinity/NaN
        expect(dec.stop).toBe(true); // a million iterations against a sane fallback cap trips
      });

      it('AC-488.SEC2: a non-numeric boardSizeAtStart (coerces to NaN) does NOT permanently disable the backstop', () => {
        const run = { ...freshRun(), boardSizeAtStart: 'not-a-number', iterations: 1_000_000 };
        const dec = nextIteration(run, 5);
        expect(Number.isFinite(dec.cap)).toBe(true);
        expect(dec.stop).toBe(true);
      });

      it('AC-488.SEC3: a corrupted run.iterations (Infinity/NaN) trips the guard immediately (fail closed), never silently continues', () => {
        const infRun = { ...freshRun(), boardSizeAtStart: 18, iterations: Infinity };
        expect(nextIteration(infRun, 18).stop).toBe(true);
        const nanRun = { ...freshRun(), boardSizeAtStart: 18, iterations: NaN };
        expect(nextIteration(nanRun, 18).stop).toBe(true);
      });

      it('AC-488.SEC4: startRun never persists a corrupted boardSize opt as the anchor', async () => {
        const cwd = await mkdtemp(join(tmpdir(), 'forge-autopilot-'));
        const started = await startRun(cwd, { boardSize: Infinity });
        expect(started.boardSizeAtStart).toBeNull(); // rejected at write time, not stored as garbage
        const startedNaN = await startRun(cwd, { boardSize: NaN });
        expect(startedNaN.boardSizeAtStart).toBeNull(); // still null — a bad value never sneaks in via a later call either
      });

      it('AC-488.SEC5: even a genuinely-both-corrupted anchor AND live boardSize falls back to the safe minimal cap (1×factor), not Infinity/NaN', () => {
        const run = { ...freshRun(), boardSizeAtStart: NaN, iterations: 100 };
        const dec = nextIteration(run, Infinity); // both inputs garbage
        expect(dec.cap).toBe(1 * DEFAULT_RUNAWAY_FACTOR); // the smallest, most conservative anchor — never Infinity/NaN
        expect(dec.stop).toBe(true); // 100 iterations comfortably exceeds the minimal fallback cap
      });
    });
  });

  it('AC-414.4: renderReport is silent about the outbox by default (no behavior change)', () => {
    const run = applyOutcome(freshRun(), { issue: 1, outcome: 'merged', ref: 'PR#10' });
    expect(renderReport(run)).not.toContain('outbox');
    expect(renderReport(run, { outboxPending: 0 })).not.toContain('outbox');
  });

  it('AC-414.4: renderReport surfaces a pending outbox count as a trailing, additive line', () => {
    const run = applyOutcome(freshRun(), { issue: 1, outcome: 'merged', ref: 'PR#10' });
    const out = renderReport(run, { outboxPending: 3 });
    expect(out).toMatch(/merged: #1/); // existing content untouched
    expect(out).toMatch(/outbox: 3 item\(s\) still queued/);
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

  // AC-466.6: a successful `forge:shape` (crazy mode) must be a recordable outcome —
  // today `applyOutcome(run, {outcome:'ready'})` throws because 'ready' isn't in
  // OUTCOMES, which is why a real run.json shows 18 iterations and zero shape entries.
  describe('AC-466.6: the ledger can record a shape (ready outcome + stage field)', () => {
    it("applyOutcome accepts outcome:'ready' and round-trips — throws today", () => {
      let run = freshRun('2026-08-13T00:00:00Z');
      run = applyOutcome(run, { issue: 140, outcome: 'ready', stage: 'shape' });
      const entry = run.outcomes.find((o) => o.issue === 140);
      expect(entry).toMatchObject({ issue: 140, outcome: 'ready', stage: 'shape' });
    });

    it('outcome entries carry the producing stage; omitting it defaults to null (back-compat)', () => {
      let run = freshRun();
      run = applyOutcome(run, { issue: 1, outcome: 'merged', ref: 'PR#10', stage: 'deliver' });
      run = applyOutcome(run, { issue: 2, outcome: 'escalated' }); // no stage passed — existing call shape
      expect(run.outcomes.find((o) => o.issue === 1).stage).toBe('deliver');
      expect(run.outcomes.find((o) => o.issue === 2).stage).toBe(null);
    });

    it("renderReport emits a 'ready:' line, formatted the same as every other OUTCOMES line", () => {
      let run = freshRun();
      run = applyOutcome(run, { issue: 140, outcome: 'ready', stage: 'shape' });
      run = applyOutcome(run, { issue: 1, outcome: 'merged', ref: 'PR#10', stage: 'deliver' });
      const out = renderReport(run);
      expect(out).toMatch(/ready: #140/);
      expect(out).toMatch(/merged: #1 \(PR#10\)/);
    });

    it("recordOutcome/loadRun round-trip a 'ready' outcome through disk", async () => {
      const cwd = await mkdtemp(join(tmpdir(), 'forge-autopilot-'));
      await startRun(cwd);
      await recordOutcome(cwd, { issue: 140, outcome: 'ready', stage: 'shape' });
      const onDisk = JSON.parse(await readFile(join(cwd, RUN_RELPATH), 'utf8'));
      expect(onDisk.outcomes).toMatchObject([{ issue: 140, outcome: 'ready', stage: 'shape' }]);
    });
  });

  // #464 fix-wave (adversarial review finding 1): watchdog.mjs's NONCONFORMING_OUTCOME
  // ('stalled-before-pr') must be genuinely recordable, mirroring AC-466.6's 'ready' precedent
  // exactly — otherwise an orchestrator that records the watchdog's respawn decision hits
  // applyOutcome throwing 'unknown outcome', contradicting the "never silent, always
  // actionable" invariant this ticket is meant to deliver.
  describe("#464: the ledger can record a stalled-before-pr outcome", () => {
    it("applyOutcome accepts outcome:'stalled-before-pr' and round-trips — threw before the fix-wave addition to OUTCOMES", () => {
      let run = freshRun('2026-08-13T00:00:00Z');
      run = applyOutcome(run, { issue: 429, outcome: 'stalled-before-pr', stage: 'deliver' });
      const entry = run.outcomes.find((o) => o.issue === 429);
      expect(entry).toMatchObject({ issue: 429, outcome: 'stalled-before-pr', stage: 'deliver' });
    });

    it("renderReport emits a 'stalled-before-pr:' line, formatted the same as every other OUTCOMES line", () => {
      let run = freshRun();
      run = applyOutcome(run, { issue: 429, outcome: 'stalled-before-pr', stage: 'deliver' });
      run = applyOutcome(run, { issue: 1, outcome: 'merged', ref: 'PR#10', stage: 'deliver' });
      const out = renderReport(run);
      expect(out).toMatch(/stalled-before-pr: #429/);
      expect(out).toMatch(/merged: #1 \(PR#10\)/);
    });

    it("a later resolved outcome for the same issue supersedes a recorded stalled-before-pr entry (last-write-wins)", () => {
      let run = freshRun();
      run = applyOutcome(run, { issue: 429, outcome: 'stalled-before-pr', stage: 'deliver' });
      run = applyOutcome(run, { issue: 429, outcome: 'merged', ref: 'PR#429', stage: 'deliver' }); // respawned, then resolved
      const entries = run.outcomes.filter((o) => o.issue === 429);
      expect(entries).toHaveLength(1);
      expect(entries[0].outcome).toBe('merged');
    });

    it("recordOutcome/loadRun round-trip a 'stalled-before-pr' outcome through disk", async () => {
      const cwd = await mkdtemp(join(tmpdir(), 'forge-autopilot-'));
      await startRun(cwd);
      await recordOutcome(cwd, { issue: 429, outcome: 'stalled-before-pr', stage: 'deliver' });
      const onDisk = JSON.parse(await readFile(join(cwd, RUN_RELPATH), 'utf8'));
      expect(onDisk.outcomes).toMatchObject([{ issue: 429, outcome: 'stalled-before-pr', stage: 'deliver' }]);
    });
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

  it('AC-414.4: `report` CLI reads outbox.json and appends the pending line', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'forge-autopilot-'));
    await startRun(cwd);
    await recordOutcome(cwd, { issue: 1, outcome: 'merged', ref: 'PR#1' });
    const { enqueue } = await import('../../plugin/scripts/lib/outbox.mjs');
    await enqueue(cwd, { op: 'comment', args: { issue: 1, phase: 'note', body: 'x' } });
    await enqueue(cwd, { op: 'comment', args: { issue: 2, phase: 'note', body: 'y' } });
    const out = execFileSync(process.execPath, [LEDGER_CLI, 'report'], { cwd, encoding: 'utf8' });
    expect(out).toMatch(/outbox: 2 item\(s\) still queued/);
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

describe('#432 — AC.1/AC.2 re-verification against the live ALLOW (already delivered by #429)', () => {
  it('AC-432.1: ALLOW covers every command #432 asked for — pnpm verify, gh pr diff, gh pr list, git fetch, and the read-only git inspection commands', () => {
    for (const cmd of [
      'Bash(pnpm verify:*)',
      'Bash(gh pr diff:*)',
      'Bash(gh pr list:*)',
      'Bash(git fetch:*)',
      'Bash(git status:*)',
      'Bash(git diff:*)',
      'Bash(git log:*)',
      'Bash(git rev-parse:*)',
    ]) {
      expect(ALLOW, `allowlist missing ${cmd}`).toContain(cmd);
    }
  });

  it('AC-432.2: ALLOW is a pure map over the single-sourced ALLOWED_COMMAND_PREFIXES — no independently-maintained copy', () => {
    expect(ALLOW).toHaveLength(ALLOWED_COMMAND_PREFIXES.length);
    expect(ALLOW).toEqual(ALLOWED_COMMAND_PREFIXES.map((p) => `Bash(${p}:*)`));
    // every ALLOW entry traces back to a real prefix, and nothing extra snuck in
    for (const entry of ALLOW) {
      const prefix = entry.slice('Bash('.length, -':*)'.length);
      expect(ALLOWED_COMMAND_PREFIXES, `${entry} has no source prefix`).toContain(prefix);
    }
  });

  it('AC-432.4: perms.mjs prints the allowlist block and never writes a file (spawned as a real subprocess in a fresh cwd)', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'forge-perms-'));
    const PERMS_CLI = fileURLToPath(new URL('../../plugin/scripts/autopilot/perms.mjs', import.meta.url));
    const out = execFileSync(process.execPath, [PERMS_CLI], { cwd, encoding: 'utf8' });
    expect(out).toContain('"permissions"');
    expect(out).toContain('Bash(pnpm verify:*)');
    // no settings file, no stray file at all — this command is read-only by design
    expect(await readdir(cwd)).toEqual([]);
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
    expect(calls).toEqual(['pr view 9 --json statusCheckRollup,headRefName,headRefOid']); // no run list / run view calls fired
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
    expect(calls).toEqual(['pr view 9 --json statusCheckRollup,headRefName,headRefOid']); // zero classification calls fired
  });

  it('review fix (#408, LOW): maxOutageAttempts is clamped server-side regardless of caller input', async () => {
    const { gh } = outageGhDouble();
    // A caller passing an absurd maxOutageAttempts still gets a bounded, sane cap.
    const res = await runMerge(
      { config: {}, gh, cwd: '/fake/cwd' },
      { issue: 408, pr: 9, signals: heldVerdicts, outageAttempt: 999999, maxOutageAttempts: 999999 },
      () => {},
      { execRun: async () => { throw new Error('must NOT attempt recovery — outageAttempt is already past the clamped ceiling'); }, journalAppend: async () => {} },
    );
    expect(res.merged).toBe(false);
    expect(res.outageExhausted).toBe(true);
    expect(res.reason).toContain('recovery exhausted after 10 attempt(s)'); // clamped to MAX_OUTAGE_ATTEMPTS_CEILING
  });

  it('SECURITY (4th review pass, #408): critical:true forces escalation regardless — never lets an outage-recovery force-push preempt it', async () => {
    const { gh, calls } = outageGhDouble();
    const res = await runMerge(
      { config: {}, gh, cwd: '/fake/cwd' },
      { issue: 408, pr: 9, signals: heldVerdicts, critical: true },
      () => {},
      { execRun: async () => { throw new Error('must NOT attempt any git action when critical:true'); }, journalAppend: async () => { throw new Error('must not even classify when critical:true'); } },
    );
    expect(res.merged).toBe(false);
    expect(res.escalate).toBe(true);
    expect(res.blockedOn).toContain('security:critical');
    expect(res.outage).toBeUndefined(); // outage classification never even ran
    expect(calls.some((c) => c.startsWith('pr merge'))).toBe(false);
  });

  it('review fix (#408, LOW): an empty-string workflowName is treated as unresolved, not classifiable — stays in lockstep with classifyCiFailure\'s truthiness guard', async () => {
    const gh = async (args) => {
      if (args[0] === 'pr' && args[1] === 'view') {
        return { ok: true, json: { headRefName: 'feat/x', statusCheckRollup: [{ conclusion: 'FAILURE', name: 'actionlint', workflowName: '' }] } };
      }
      return { ok: true };
    };
    const ci = await ciGreen(gh, 9);
    expect(ci.classifiable).toBe(false);
    expect(ci.workflowName).toBe(null);
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

// #504 — the third RUN START gate: nothing verified the MACHINE before the merge-auth
// and rate-budget preflights. Every test here drives the pure core and the IO wrapper
// from injected doubles (AC-504.6) — no bare `run`/`makeGh(run)` call anywhere below.
describe('autopilot env preflight (#504) — evaluateEnvPreflight (AC-504.1, pure)', () => {
  it('AC-504.1: all probes ok -> verdict go, no blockers, no warnings', () => {
    const d = evaluateEnvPreflight([
      { id: 'gh', status: 'ok', detail: 'gh resolvable' },
      { id: 'node', status: 'ok', detail: 'node resolvable' },
    ]);
    expect(d).toEqual({ verdict: 'go', blockers: [], warnings: [] });
  });

  it('AC-504.1: any fail -> verdict no-go, blocker carries stable id + detail + concrete fix', () => {
    const d = evaluateEnvPreflight([
      { id: 'gh', status: 'ok', detail: 'gh resolvable' },
      { id: 'node-modules', status: 'fail', detail: 'node_modules not found in the checkout', fix: 'run pnpm install' },
    ]);
    expect(d.verdict).toBe('no-go');
    expect(d.blockers).toEqual([{ id: 'node-modules', detail: 'node_modules not found in the checkout', fix: 'run pnpm install' }]);
  });

  it('AC-504.1: multiple failures all surface as separate blockers, each with its own id/detail/fix', () => {
    const d = evaluateEnvPreflight([
      { id: 'gh', status: 'fail', detail: 'gh is not resolvable on PATH', fix: 'install gh' },
      { id: 'pnpm', status: 'fail', detail: 'pnpm is not resolvable on PATH', fix: 'install pnpm' },
    ]);
    expect(d.verdict).toBe('no-go');
    expect(d.blockers.map((b) => b.id)).toEqual(['gh', 'pnpm']);
    expect(d.blockers.every((b) => typeof b.fix === 'string' && b.fix.length > 0)).toBe(true);
  });

  it('AC-504.1: a warn-status probe never flips the verdict — degrade, don\'t block (AC-504.4 boundary)', () => {
    const d = evaluateEnvPreflight([
      { id: 'board-status-keys', status: 'warn', detail: 'could not fetch live board fields (network down)', fix: 'retry' },
    ]);
    expect(d.verdict).toBe('go');
    expect(d.blockers).toEqual([]);
    expect(d.warnings).toEqual([{ id: 'board-status-keys', detail: 'could not fetch live board fields (network down)', fix: 'retry' }]);
  });

  it('AC-504.1: no IO — a plain array literal is a complete, sufficient input (no filesystem, no shell)', () => {
    expect(evaluateEnvPreflight([]).verdict).toBe('go');
    expect(evaluateEnvPreflight(null).verdict).toBe('go'); // defensive: never throws on a malformed/missing input
    expect(evaluateEnvPreflight(undefined).verdict).toBe('go');
  });
});

describe('autopilot env preflight (#504) — formatBlockers (AC-504.3)', () => {
  it('AC-504.3: no-go renders a NUMBERED blocker list with the fix inline, one line per blocker', () => {
    const lines = formatBlockers([
      { id: 'gh', detail: 'gh is not resolvable on PATH', fix: 'install the GitHub CLI' },
      { id: 'node-modules', detail: 'node_modules not found in the checkout', fix: 'run pnpm install' },
    ]);
    expect(lines).toEqual([
      '1. [gh] gh is not resolvable on PATH — fix: install the GitHub CLI',
      '2. [node-modules] node_modules not found in the checkout — fix: run pnpm install',
    ]);
  });

  it('AC-504.3: go (no blockers) formats to an empty list — no behaviour to signal', () => {
    expect(formatBlockers([])).toEqual([]);
    expect(formatBlockers(undefined)).toEqual([]);
  });
});

describe('autopilot env preflight (#504) — probeExecutable: gh/node/pnpm resolvable (AC-504.2a)', () => {
  it('AC-504.2a: exec resolves the tool -> status ok, first line of version output in the detail', async () => {
    const exec = async (cmd, args) => {
      expect(cmd).toBe('gh');
      expect(args).toEqual(['--version']);
      return { ok: true, code: 0, stdout: 'gh version 2.60.0\n(built from source)', stderr: '' };
    };
    const p = await probeExecutable('gh', 'gh', exec, 'install gh');
    expect(p).toMatchObject({ id: 'gh', status: 'ok' });
    expect(p.detail).toContain('gh version 2.60.0');
  });

  it('AC-504.2a: exec reports the tool missing (ok:false, e.g. ENOENT) -> status fail with the given fix', async () => {
    const exec = async () => ({ ok: false, code: -1, stdout: '', stderr: 'spawn pnpm ENOENT' });
    const p = await probeExecutable('pnpm', 'pnpm', exec, 'install pnpm (https://pnpm.io/installation)');
    expect(p).toEqual({ id: 'pnpm', status: 'fail', detail: 'pnpm is not resolvable on PATH', fix: 'install pnpm (https://pnpm.io/installation)' });
  });
});

describe('autopilot env preflight (#504) — probeNodeModules (AC-504.2b)', () => {
  it('AC-504.2b: node_modules present -> ok', async () => {
    const p = await probeNodeModules({ cwd: '/repo', stat: async () => ({}) });
    expect(p).toEqual({ id: 'node-modules', status: 'ok', detail: 'node_modules present' });
  });

  it('AC-504.2b: node_modules absent (ENOENT) -> fail, concrete fix', async () => {
    const stat = async () => { const e = new Error('no such file'); e.code = 'ENOENT'; throw e; };
    const p = await probeNodeModules({ cwd: '/repo', stat });
    expect(p).toEqual({ id: 'node-modules', status: 'fail', detail: 'node_modules not found in the checkout', fix: 'run pnpm install' });
  });

  it('AC-504.4: an unrelated stat error (not ENOENT) is NOT treated as "missing" — it propagates for the caller to degrade', async () => {
    const stat = async () => { const e = new Error('permission denied'); e.code = 'EACCES'; throw e; };
    await expect(probeNodeModules({ cwd: '/repo', stat })).rejects.toThrow('permission denied');
  });
});

describe('autopilot env preflight (#504) — probeBoardStatusKeys (AC-504.2c)', () => {
  const cfgOk = {
    ok: true,
    config: { board: { projectId: 'PVT_x', fields: { status: { id: 'FIELD_STATUS' } } } },
  };
  const liveFieldsAllKeys = {
    ok: true,
    fields: {
      status: {
        id: 'FIELD_STATUS',
        options: [
          { id: 'a', name: 'In Progress' }, { id: 'b', name: 'In Review' }, { id: 'c', name: 'Ready' },
          { id: 'd', name: 'Backlog' }, { id: 'e', name: 'Blocked' }, { id: 'f', name: 'Done' },
          { id: 'g', name: "Won't Do" },
        ],
      },
    },
  };

  it('AC-504.2c: SELECT_STATUS_KEYS covers exactly what select.mjs consumes (TIER ∪ SKIP)', () => {
    expect(new Set(SELECT_STATUS_KEYS)).toEqual(new Set(['inProgress', 'inReview', 'ready', 'backlog', 'blocked', 'done', 'wontDo']));
  });

  it('AC-504.2c: live board options normalize onto every key select.mjs consumes -> ok', async () => {
    const p = await probeBoardStatusKeys({
      cwd: '/repo', gh: async () => ({ ok: true }),
      loadConfigFn: async () => cfgOk,
      getFields: async () => liveFieldsAllKeys,
    });
    expect(p).toEqual({ id: 'board-status-keys', status: 'ok', detail: 'board Status option keys match select.mjs' });
  });

  it('AC-504.2c: a renamed Status option (drift) -> fail, missing keys named in the detail + fix (closes the doctor.mjs gap)', async () => {
    const drifted = {
      ok: true,
      fields: {
        status: {
          id: 'FIELD_STATUS',
          options: liveFieldsAllKeys.fields.status.options.filter((o) => o.name !== 'In Progress').concat({ id: 'z', name: 'Doing' }),
        },
      },
    };
    const p = await probeBoardStatusKeys({
      cwd: '/repo', gh: async () => ({ ok: true }),
      loadConfigFn: async () => cfgOk,
      getFields: async () => drifted,
    });
    expect(p.status).toBe('fail');
    expect(p.id).toBe('board-status-keys');
    expect(p.detail).toContain('inProgress');
    expect(p.fix).toContain('inProgress');
  });

  it('AC-504.2c/AC-504.4: config invalid/missing -> warn, never a blocker (doctor.mjs already gates config validity)', async () => {
    const p = await probeBoardStatusKeys({
      cwd: '/repo', gh: async () => ({ ok: true }),
      loadConfigFn: async () => ({ ok: false, errors: ['.claude/forge.json not found'] }),
      getFields: async () => liveFieldsAllKeys,
    });
    expect(p.status).toBe('warn');
  });

  it('AC-504.2c/AC-504.4: the live board fetch itself fails (network/auth) -> warn, not fail — the check could not complete', async () => {
    const p = await probeBoardStatusKeys({
      cwd: '/repo', gh: async () => ({ ok: false }),
      loadConfigFn: async () => cfgOk,
      getFields: async () => ({ ok: false, error: 'gh not authenticated' }),
    });
    expect(p.status).toBe('warn');
    expect(p.detail).toMatch(/gh not authenticated/);
  });
});

describe('autopilot env preflight (#504) — statusline plugin path on disk (AC-504.2d)', () => {
  it('parseStatuslineScriptPath: two quoted argv tokens (node exe, script) -> the SECOND token (init.mjs\'s own format)', () => {
    expect(parseStatuslineScriptPath('"C:\\node.exe" "C:\\plugins\\forge\\scripts\\statusline.mjs"')).toBe('C:\\plugins\\forge\\scripts\\statusline.mjs');
  });

  it('parseStatuslineScriptPath: a single quoted token -> that token; no quotes -> null', () => {
    expect(parseStatuslineScriptPath('"/usr/local/bin/statusline.mjs"')).toBe('/usr/local/bin/statusline.mjs');
    expect(parseStatuslineScriptPath('node statusline.mjs')).toBeNull();
    expect(parseStatuslineScriptPath(undefined)).toBeNull();
  });

  it('AC-504.2d: no statusline wired at all -> ok, nothing to verify (doctor.mjs covers "wired" separately)', async () => {
    const p = await probeStatuslinePath({ cwd: '/repo', stat: async () => ({}), readJsonFn: async () => null });
    expect(p).toEqual({ id: 'statusline-path', status: 'ok', detail: 'no statusline wired — nothing to verify (doctor.mjs already advises on this separately)' });
  });

  it('AC-504.2d: wired AND the path resolves on disk -> ok', async () => {
    const readJsonFn = async (p) => (p.includes('settings.local.json') ? { statusLine: { command: '"node" "/plugins/forge/scripts/statusline.mjs"' } } : null);
    const p = await probeStatuslinePath({ cwd: '/repo', stat: async () => ({}), readJsonFn });
    expect(p).toEqual({ id: 'statusline-path', status: 'ok', detail: 'statusline plugin path resolves on disk' });
  });

  it('AC-504.2d: wired but the path does NOT exist on disk -> fail (closes the gap: doctor.mjs only checks the key is present)', async () => {
    const readJsonFn = async (p) => (p.includes('settings.local.json') ? { statusLine: { command: '"node" "/stale/cache/statusline.mjs"' } } : null);
    const stat = async () => { const e = new Error('no such file'); e.code = 'ENOENT'; throw e; };
    const p = await probeStatuslinePath({ cwd: '/repo', stat, readJsonFn });
    expect(p).toEqual({
      id: 'statusline-path', status: 'fail',
      detail: 'statusline plugin path does not exist: /stale/cache/statusline.mjs',
      fix: 're-run /forge:init --statusline (or forge:statusline) to re-wire the path',
    });
  });

  it('AC-504.4: an unrelated stat error on a wired path is NOT treated as "missing" — it propagates for the caller to degrade', async () => {
    const readJsonFn = async (p) => (p.includes('settings.local.json') ? { statusLine: { command: '"node" "/x/statusline.mjs"' } } : null);
    const stat = async () => { const e = new Error('busy'); e.code = 'EBUSY'; throw e; };
    await expect(probeStatuslinePath({ cwd: '/repo', stat, readJsonFn })).rejects.toThrow('busy');
  });
});

describe('autopilot env preflight (#504) — probeEnv IO wrapper (AC-504.4, AC-504.6)', () => {
  const okCtx = () => ({
    cwd: '/repo',
    gh: async () => ({ ok: true }),
    exec: async () => ({ ok: true, code: 0, stdout: 'v1.0.0', stderr: '' }),
    stat: async () => ({}),
    readJsonFn: async () => null, // no statusline wired
    // Fully inject the board-status-keys probe's dependencies too (AC-504.6):
    // no real .claude/forge.json read, no real GraphQL call.
    loadConfigFn: async () => ({ ok: true, config: { board: { projectId: 'PVT_x', fields: { status: { id: 'F' } } } } }),
    getFields: async () => ({ ok: true, fields: { status: { id: 'F', options: [
      { id: 'a', name: 'In Progress' }, { id: 'b', name: 'In Review' }, { id: 'c', name: 'Ready' },
      { id: 'd', name: 'Backlog' }, { id: 'e', name: 'Blocked' }, { id: 'f', name: 'Done' },
      { id: 'g', name: "Won't Do" },
    ] } } }),
  });

  it('AC-504.6: six probes run, all injected — verdict go when everything resolves clean', async () => {
    const d = await probeEnv(okCtx());
    expect(d.verdict).toBe('go');
    expect(d.blockers).toEqual([]);
    expect(d.probes).toHaveLength(6);
    expect(d.probes.map((p) => p.id).sort()).toEqual(
      ['board-status-keys', 'gh', 'node', 'node-modules', 'pnpm', 'statusline-path'].sort(),
    );
  });

  it('AC-504.3/AC-504.6: a genuine problem (node_modules missing) -> no-go, numbered blocker formats cleanly', async () => {
    const ctx = {
      ...okCtx(),
      stat: async (p) => {
        if (String(p).includes('node_modules')) { const e = new Error('nope'); e.code = 'ENOENT'; throw e; }
        return {};
      },
    };
    const d = await probeEnv(ctx);
    expect(d.verdict).toBe('no-go');
    expect(d.blockers).toEqual([{ id: 'node-modules', detail: 'node_modules not found in the checkout', fix: 'run pnpm install' }]);
    expect(formatBlockers(d.blockers)).toEqual(['1. [node-modules] node_modules not found in the checkout — fix: run pnpm install']);
  });

  it('AC-504.4: a probe that CANNOT complete (throws) degrades to a warning, not a blocker — verdict stays go', async () => {
    const ctx = {
      ...okCtx(),
      exec: async (cmd) => { if (cmd === 'gh') throw new Error('unexpected crash inside the gh probe'); return { ok: true, code: 0, stdout: 'v1', stderr: '' }; },
    };
    const d = await probeEnv(ctx);
    expect(d.verdict).toBe('go'); // a broken probe must never block a healthy run
    expect(d.blockers).toEqual([]);
    expect(d.warnings.some((w) => w.id === 'gh' && /could not complete/.test(w.detail))).toBe(true);
  });

  it('AC-504.4: a crashed probe (warning) never MASKS a real blocker found by a different probe', async () => {
    const ctx = {
      ...okCtx(),
      exec: async (cmd) => { if (cmd === 'node') throw new Error('boom'); return { ok: true, code: 0, stdout: 'v1', stderr: '' }; },
      stat: async (p) => {
        if (String(p).includes('node_modules')) { const e = new Error('nope'); e.code = 'ENOENT'; throw e; }
        return {};
      },
    };
    const d = await probeEnv(ctx);
    expect(d.verdict).toBe('no-go');
    expect(d.blockers.map((b) => b.id)).toEqual(['node-modules']);
    expect(d.warnings.map((w) => w.id)).toEqual(['node']);
  });
});
