#!/usr/bin/env node
/**
 * autopilot return-then-resume watchdog (#319, #464, epic #183).
 *
 * Two distinct stalls share the same root cause — a subagent RETURNS instead
 * of resolving to a real terminal state, discarding the context that would
 * have let it finish, and nothing re-invokes it:
 *
 * 1. **`awaiting-merge` (#319).** A delivery subagent opens a PR, watches CI to
 *    green, and then returns reporting `awaiting-merge` — awaiting a
 *    re-invocation that never comes. The ticket parks at an open, green PR
 *    forever.
 * 2. **Stalled-before-PR (#464).** A delivery subagent spawns a
 *    `forge:reviewer`/`forge:security` subagent, then RETURNS before even
 *    reaching a PR (or with one still open awaiting review) — with a terminal
 *    report that is not the `{issue, outcome, pr, ciGreen, ...}` contract at
 *    all, just free text like "Waiting on the reviewer's re-confirmation."
 *    There is no `pr` to re-drive and no `outcome` to map. Before #464 this
 *    fell through the same `outcome !== STALL_OUTCOME` branch as an
 *    already-resolved report, silently recording `outcome: null` as if the
 *    ticket were done.
 *
 * This is the mechanical detector the loop runs the moment it reads a
 * subagent's terminal report. It is PURE — it maps a returned report to a
 * single action, so both invariants are testable in isolation from GitHub:
 *
 *   INVARIANT (#319): an `awaiting-merge` report is NEVER left as a silent
 *   terminal state. On a green PR it either MERGES (auto-merge authority →
 *   funnel the PR through the tested bar, `runMerge`) or is SURFACED (pr-only
 *   / can't-merge → escalate, recording awaiting-human/escalated visibly).
 *
 *   INVARIANT (#464): an `outcome` that is not one of the known resolved
 *   states (and not the `awaiting-merge` sentinel) is NEVER recorded as a
 *   terminal outcome — free text, a missing outcome, or anything else
 *   non-conforming resolves to `action: 'resume'`, `outcome:
 *   'stalled-before-pr'`, carrying `pr` through when one already exists so the
 *   loop knows whether it's resuming to open a first PR or resuming a subagent
 *   already mid-review. The actual resume/re-spawn mechanics are the loop's
 *   (orchestrator prose today; #474 is the follow-up to automate the relay) —
 *   this function only classifies, it never performs IO.
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
 * The #464 stall: a non-conforming terminal report — `outcome` missing, or not
 * one of `RESOLVED_OUTCOMES`/`STALL_OUTCOME` (typically free text like
 * "waiting on the reviewer's re-confirmation"). A real, recorded, actionable
 * state — never a silent `continue`/`outcome: null`.
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
 * @returns {{ action:'merge'|'escalate'|'resume'|'continue', pr?:(number|null), outcome:(string|null), reason:string }}
 *   `merge`    → funnel `pr` through `runMerge` (the tested bar re-checks CI).
 *   `escalate` → surface visibly; `outcome` is the state the loop records —
 *                `awaiting-human` for a green PR with no merge authority (pr-only),
 *                else `escalated` for a genuinely un-mergeable return.
 *   `resume`   → #464: a non-conforming report (not a resolved outcome, not
 *                `awaiting-merge`) — resume or re-spawn the subagent; `pr` is
 *                the already-open PR when one exists, else `null`. Never a
 *                silent park.
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
    // #464: not a resolved outcome and not the awaiting-merge sentinel — a non-conforming
    // terminal report (missing outcome, or free text such as "waiting on the reviewer's
    // re-confirmation"). NEVER record this as a terminal outcome; classify it as the
    // stalled-before-PR recovery instead.
    const prNumber = Number.isInteger(pr) ? pr : null;
    return {
      action: 'resume',
      outcome: NONCONFORMING_OUTCOME,
      pr: prNumber,
      reason:
        prNumber == null
          ? `non-conforming terminal report (outcome '${outcome ?? 'none'}' is not a resolved state) with no PR — ` +
            'the subagent stalled before reaching one; resume or re-spawn it to reach a PR, never record this as resolved'
          : `non-conforming terminal report (outcome '${outcome ?? 'none'}' is not a resolved state) with PR #${prNumber} already open — ` +
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
  // exit codes: 0 continue/merge, 3 escalate, 4 resume (#464 — distinct from escalate so callers
  // can tell "surface to a human" apart from "resume/re-spawn the subagent").
  process.exit(dec.action === 'escalate' ? 3 : dec.action === 'resume' ? 4 : 0);
}
