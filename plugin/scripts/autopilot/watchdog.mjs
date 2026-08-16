#!/usr/bin/env node
/**
 * autopilot return-then-resume watchdog (#319, #464, #522, epic #183).
 *
 * Three distinct stalls share the same root cause — a subagent RETURNS
 * instead of resolving to a real terminal state, discarding the context that
 * would have let it finish, and nothing re-invokes it:
 *
 * 1. **`awaiting-merge` (#319).** A delivery subagent opens a PR, watches CI to
 *    green, and then returns reporting `awaiting-merge` — awaiting a
 *    re-invocation that never comes. The ticket parks at an open, green PR
 *    forever.
 * 2. **Stalled-before-PR, recoverable (#464).** A delivery subagent spawns a
 *    `forge:reviewer`/`forge:security` subagent, then RETURNS with a PR
 *    already open and still awaiting review — with a terminal report that is
 *    not the `{issue, outcome, pr, ciGreen, ...}` contract at all, just free
 *    text like "Waiting on the reviewer's re-confirmation." There is no
 *    `outcome` to map, but there IS an open PR: the resume protocol (a fresh
 *    delivery subagent picking the ticket back up, or the merge bar if the
 *    loop's own observed state already shows it green and authorized) can
 *    recover it without anyone inspecting the working tree first.
 * 3. **Malformed/absent report, unrecoverable (#522).** The same
 *    non-conforming return, but with **no PR at all** — e.g. "I'll wait for
 *    the resumed implementer agent to report the final results." /
 *    "Full test suite is running in the background... I'll proceed once it
 *    completes." / "Still waiting on the full verify suite to finish."
 *    (the three verbatim returns observed delivering #517, 2026-08-16, three
 *    of four attempts). Unlike shape 2, there is nothing here to resume INTO —
 *    the subagent may have died with the shared working tree mid-edit,
 *    uncommitted, on top of nothing recoverable via `gh`. Blindly respawning
 *    a fresh subagent onto that tree is how the run's own secondary finding
 *    happened (uncommitted security-critical fixes nearly discarded as
 *    "abandoned"). This shape fails closed by escalating instead — visible,
 *    recorded, and gated on a human/orchestrator actually looking at
 *    `git status`/`git log` before anything touches the tree again — never a
 *    silent auto-retry.
 *
 * Before #464, shapes 2 and 3 both fell through the same
 * `outcome !== STALL_OUTCOME` branch as an already-resolved report, silently
 * recording `outcome: null` as if the ticket were done. #464 gave both a
 * shared `respawn`/`stalled-before-pr` classification, keyed only on whether
 * `outcome` matched a resolved state — but that treated "PR open, awaiting
 * review" and "no PR, unknown working-tree state" identically, and the latter
 * is exactly the shape that stalled #517 three times running despite #464
 * already being live. #522 splits them on `pr`, the one piece of caller-
 * observed state that actually distinguishes them (AC.3) — never IO inside
 * this function, the caller passes it in.
 *
 * This is the mechanical detector the loop runs the moment it reads a
 * subagent's terminal report. It is PURE — it maps a returned report to a
 * single action, so all three invariants are testable in isolation from
 * GitHub:
 *
 *   INVARIANT (#319): an `awaiting-merge` report is NEVER left as a silent
 *   terminal state. On a green PR it either MERGES (auto-merge authority →
 *   funnel the PR through the tested bar, `runMerge`) or is SURFACED (pr-only
 *   / can't-merge → escalate, recording awaiting-human/escalated visibly).
 *
 *   INVARIANT (#464/#522): an `outcome` that is not one of the known resolved
 *   states (and not the `awaiting-merge` sentinel) is NEVER recorded as if it
 *   were one, and NEVER falls through unclassified (AC.1). When a real PR
 *   already exists (`Number.isInteger(pr)`), it is the recoverable shape —
 *   `action: 'respawn'`, `outcome: 'stalled-before-pr'` (or, when the caller's
 *   own observed `ciGreen`/`mergeMode` already show it mergeable, `action:
 *   'merge'` straight away — AC.3's "hand to the merge bar" path; `runMerge`
 *   re-verifies everything itself, so this is safe even though the outcome
 *   text was garbage). With no PR, it is the unrecoverable shape (AC.3) —
 *   `action: 'escalate'`, `outcome: 'escalated'` (AC.2: surfaced, fail-closed,
 *   never a silent terminal success). `pr` is carried through on the
 *   recoverable path so the loop knows it's resuming a subagent already
 *   mid-review, not opening a first PR. The actual resume/re-spawn mechanics
 *   remain the loop's (orchestrator prose today; #474 is the follow-up to
 *   automate the relay) — this function only classifies, it never performs
 *   IO. Named `respawn`, not `resume`, to avoid colliding with `select.mjs`'s
 *   unrelated `resume` action (re-picking an in-flight ticket at the next
 *   selection).
 *
 * Every genuinely resolved outcome (merged/escalated/awaiting-human/skipped/
 * ready) is already recordable, so the watchdog passes it through as
 * `continue`. The merge action funnels to `merge.mjs` `runMerge`, which
 * RE-checks CI itself (fail-closed), so the watchdog's `ciGreen` is a gate on
 * even attempting it, not a substitute for the bar.
 */
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isAutoMergeMode } from './preflight.mjs';

/** The one returned outcome that is NOT a resolved terminal state — the #319 stall this guards. */
export const STALL_OUTCOME = 'awaiting-merge';

/**
 * Outcomes a `deliver`/`resume`/`shape`/`triage` subagent can legitimately
 * report as an already-resolved terminal state — safe to record and continue.
 * Mirrors `ledger.mjs`'s `OUTCOMES` (the ledger-recordable vocabulary), which
 * already includes shape's `ready` alongside delivery's own outcomes.
 */
export const RESOLVED_OUTCOMES = ['merged', 'escalated', 'awaiting-human', 'skipped', 'ready'];

/**
 * The #464/#522 stall: a non-conforming terminal report — `outcome` missing,
 * or not one of `RESOLVED_OUTCOMES`/`STALL_OUTCOME` (typically free text like
 * "waiting on the reviewer's re-confirmation"). Recorded ONLY on the
 * recoverable path (a real PR already exists — #464); the unrecoverable
 * no-PR path (#522) escalates instead (`outcome: 'escalated'`), never this
 * value. A real, recordable, actionable state (`ledger.mjs`'s `OUTCOMES`
 * carries it) — never a silent `continue`/`outcome: null`.
 */
export const NONCONFORMING_OUTCOME = 'stalled-before-pr';

/**
 * Resolve a delivery subagent's terminal report into a loop action.
 *
 * @param {object} report
 * @param {string} report.outcome          the subagent's returned outcome.
 * @param {number|null} [report.pr]         the open PR number, when one exists.
 * @param {boolean} [report.ciGreen]        did the subagent observe CI green in-run?
 * @param {string|null} [report.mergeMode]  the run's effective merge mode
 *   (`auto-merge`|`pr-only`) as recorded by the preflight in run.json.
 *
 *   `pr`/`ciGreen`/`mergeMode` MUST be sourced from the orchestrator's own
 *   independently-observed state (run.json's recorded `mergeMode`, a real
 *   `gh pr view`/CI-monitor transition for `ciGreen`) — never parsed out of
 *   the subagent's free-text report body, even for a malformed report where
 *   the report itself has no structured fields to draw them from. This
 *   function trusts its caller completely and performs no verification of
 *   its own; the only reason a malformed report can't forge its way to a
 *   `merge` action is that `runMerge` independently re-checks CI and
 *   requires its own separately-held `signals` before actually merging (see
 *   the file-level comment) — that safety net lives entirely outside this
 *   function, so callers must not weaken it by trusting subagent-supplied
 *   values here.
 * @returns {{ action:'merge'|'escalate'|'respawn'|'continue', pr?:(number|null), outcome:(string|null), reason:string }}
 *   `merge`    → funnel `pr` through `runMerge` (the tested bar re-checks CI).
 *   `escalate` → surface visibly; `outcome` is the state the loop records —
 *                `awaiting-human` for a green PR with no merge authority (pr-only),
 *                `escalated` for a genuinely un-mergeable `awaiting-merge` return,
 *                and `escalated` for a non-conforming report with NO PR at all
 *                (#522 — unrecoverable; working-tree state can't be observed from
 *                here, so this surfaces for human/orchestrator inspection rather
 *                than risking a blind respawn onto possibly-uncommitted work).
 *   `respawn`  → #464/#522: a non-conforming report (not a resolved outcome, not
 *                `awaiting-merge`) with a PR ALREADY OPEN — the recoverable shape;
 *                resume or re-spawn the subagent to finish it; `pr` is the
 *                already-open PR. Never a silent park. (Named `respawn`, not
 *                `resume`, to stay distinct from `select.mjs`'s own `resume`
 *                selection action.)
 *   `continue` → already resolved; record the reported `outcome` and move on.
 */
export function resolveReturnedTicket({ outcome, pr = null, ciGreen = false, mergeMode = null } = {}) {
  if (outcome !== STALL_OUTCOME) {
    if (RESOLVED_OUTCOMES.includes(outcome)) {
      return {
        action: 'continue',
        outcome,
        reason: `outcome '${outcome}' is already a resolved state — record it and continue`,
      };
    }
    // #464/#522: not a resolved outcome and not the awaiting-merge sentinel — a
    // non-conforming terminal report (missing outcome, or free text such as "waiting
    // on the reviewer's re-confirmation" / "still waiting on the full verify suite").
    // NEVER record this as though it were resolved (AC.1). Split on the one piece of
    // caller-observed state that distinguishes recoverable from unrecoverable (AC.3):
    // whether a real PR already exists.
    const prNumber = Number.isInteger(pr) ? pr : null;
    const describedOutcome = outcome ? `'${outcome}'` : 'none'; // catches undefined, null, AND '' (#464 review)
    if (prNumber == null) {
      // #522: unrecoverable — no PR to hand to the resume protocol or the merge bar,
      // and the shared working tree's state (uncommitted? mid-edit? nothing at all?)
      // is not observable from here. Escalating (not respawning) forces a human/
      // orchestrator to inspect it before any subagent touches the tree again —
      // exactly the git-status/git-log check the run's own manual recoveries needed.
      return {
        action: 'escalate',
        outcome: 'escalated',
        pr: null,
        reason:
          `non-conforming terminal report (outcome ${describedOutcome} is not a resolved state) with no PR — ` +
          'the subagent stalled before reaching one and its working-tree state cannot be observed from here; ' +
          'surfacing for human/orchestrator recovery (inspect git status/log before respawning) rather than a blind auto-retry',
      };
    }
    // A real PR already exists (AC.3: recoverable). If the caller's own observed
    // state already shows it green and authorized, treat it like a well-formed
    // awaiting-merge report and hand it straight to the merge bar — runMerge
    // re-verifies everything itself, so this is safe even though the outcome text
    // was garbage; there is no reason to wait on a resume just to re-report what the
    // loop already knows.
    if (ciGreen === true && isAutoMergeMode(mergeMode)) {
      return {
        action: 'merge',
        pr: prNumber,
        outcome: 'merged',
        reason:
          `non-conforming terminal report (outcome ${describedOutcome} is not a resolved state) but PR #${prNumber} ` +
          'is already observed green with auto-merge authority — re-driving through the merge bar (runMerge) rather than trusting the malformed text',
      };
    }
    return {
      action: 'respawn',
      outcome: NONCONFORMING_OUTCOME,
      pr: prNumber,
      reason:
        `non-conforming terminal report (outcome ${describedOutcome} is not a resolved state) with PR #${prNumber} already open — ` +
        'the subagent stalled awaiting a verdict; resume it (the orchestrator may already hold the answer) rather than recording this as resolved',
    };
  }
  // From here: an awaiting-merge report — the #319 return-then-resume stall. Never leave it silent.
  if (!Number.isInteger(pr)) {
    return {
      action: 'escalate',
      outcome: 'escalated',
      reason: 'awaiting-merge returned with no PR — cannot verify or merge; surfacing rather than silently parking',
    };
  }
  if (ciGreen !== true) {
    return {
      action: 'escalate',
      outcome: 'escalated',
      reason:
        `awaiting-merge returned before PR #${pr} CI was green — the subagent did not watch CI to conclusion in-run; ` +
        'surfacing rather than silently parking',
    };
  }
  if (isAutoMergeMode(mergeMode)) {
    return {
      action: 'merge',
      pr,
      outcome: 'merged',
      reason: `awaiting-merge on green PR #${pr} with auto-merge authority — re-driving through the merge bar (runMerge)`,
    };
  }
  // Green PR but no merge authority (pr-only / no in-session grant): surface as awaiting-human, visibly.
  return {
    action: 'escalate',
    outcome: 'awaiting-human',
    reason:
      `awaiting-merge on green PR #${pr} but merge mode is '${mergeMode ?? 'unset'}' (no auto-merge authority) — ` +
      'recording awaiting-human visibly, not silently parking',
  };
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  const argv = process.argv.slice(2);
  const val = (flag) => (argv.includes(flag) ? argv[argv.indexOf(flag) + 1] : undefined);
  const prRaw = val('--pr');
  const dec = resolveReturnedTicket({
    outcome: val('--outcome'),
    pr: prRaw != null ? Number(prRaw) : null,
    ciGreen: argv.includes('--ci-green'),
    mergeMode: val('--mode') ?? null,
  });
  console.log(`watchdog: ${dec.action}${dec.pr ? ` (PR #${dec.pr})` : ''} → record ${dec.outcome ?? '—'} — ${dec.reason}`);
  // exit codes: 0 continue/merge, 3 escalate, 4 respawn (#464 — distinct from escalate so callers
  // can tell "surface to a human" apart from "resume/re-spawn the subagent").
  process.exit(dec.action === 'escalate' ? 3 : dec.action === 'respawn' ? 4 : 0);
}
