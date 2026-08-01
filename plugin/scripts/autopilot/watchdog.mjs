#!/usr/bin/env node
/**
 * autopilot return-then-resume watchdog (#319, epic #183).
 *
 * The headline autopilot stall: a delivery subagent opens a PR, watches CI to
 * green, and then RETURNS reporting `awaiting-merge` — awaiting a re-invocation
 * that never comes. Its context is discarded on return and nothing re-drives it,
 * so the ticket parks at an open, green PR forever. There was no detection today:
 * the loop read the report and moved on, silently leaving the ticket un-merged —
 * and a subagent that never moved the board status may never be re-selected.
 *
 * This is the mechanical detector the loop runs the moment it reads a delivery
 * subagent's terminal report. It is PURE — it maps a returned report to a single
 * action, so the invariant is testable in isolation from GitHub:
 *
 *   INVARIANT: an `awaiting-merge` report is NEVER left as a silent terminal
 *   state. On a green PR it either MERGES (auto-merge authority → funnel the PR
 *   through the tested bar, `runMerge`) or is SURFACED (pr-only / can't-merge →
 *   escalate, recording awaiting-human/escalated visibly) — never silently parked
 *   as if resolved.
 *
 * Every other outcome (merged/escalated/awaiting-human/skipped) is already a
 * resolved, recordable state, so the watchdog passes it through as `continue`.
 * The merge action funnels to `merge.mjs` `runMerge`, which RE-checks CI itself
 * (fail-closed), so the watchdog's `ciGreen` is a gate on even attempting it, not
 * a substitute for the bar.
 */
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isAutoMergeMode } from './preflight.mjs';

/** The one returned outcome that is NOT a resolved terminal state — the stall this guards. */
export const STALL_OUTCOME = 'awaiting-merge';

/**
 * Resolve a delivery subagent's terminal report into a loop action.
 *
 * @param {object} report
 * @param {string} report.outcome          the subagent's returned outcome.
 * @param {number|null} [report.pr]         the open PR number, when one exists.
 * @param {boolean} [report.ciGreen]        did the subagent observe CI green in-run?
 * @param {string|null} [report.mergeMode]  the run's effective merge mode
 *   (`auto-merge`|`pr-only`) as recorded by the preflight in run.json.
 * @returns {{ action:'merge'|'escalate'|'continue', pr?:number, outcome:(string|null), reason:string }}
 *   `merge`    → funnel `pr` through `runMerge` (the tested bar re-checks CI).
 *   `escalate` → surface visibly; `outcome` is the state the loop records —
 *                `awaiting-human` for a green PR with no merge authority (pr-only),
 *                else `escalated` for a genuinely un-mergeable return.
 *   `continue` → already resolved; record the reported `outcome` and move on.
 */
export function resolveReturnedTicket({ outcome, pr = null, ciGreen = false, mergeMode = null } = {}) {
  if (outcome !== STALL_OUTCOME) {
    return {
      action: 'continue',
      outcome: outcome ?? null,
      reason: `outcome '${outcome ?? 'none'}' is already a resolved state — record it and continue`,
    };
  }
  // From here: an awaiting-merge report — the return-then-resume stall. Never leave it silent.
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
  process.exit(dec.action === 'escalate' ? 3 : 0);
}
