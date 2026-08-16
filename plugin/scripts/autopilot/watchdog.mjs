#!/usr/bin/env node
/**
 * autopilot return-then-resume watchdog (#319, #464, #474, #522, epic #183).
 *
 * Four distinct stalls share the same root cause — a subagent RETURNS
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
 * 4. **Relay a held verdict, automatically (#474).** Shapes 2 and 3 above are
 *    both non-conforming reports that RESOLVE mechanically once classified —
 *    but six real instances (#429, #437, #446, #460, and this run's #469,
 *    #472) share something more specific: the report names what it's
 *    waiting on (a reviewer/security verdict), and the orchestrator is
 *    ALREADY HOLDING that exact verdict, received as a task notification
 *    from the nested review subagent while the delivery subagent was still
 *    running. Manual recovery in every one of those six cases was the same
 *    move — relay the held verdict(s) back via `SendMessage`, which resumes
 *    the SAME already-running subagent from its own transcript (context
 *    intact), not a fresh subagent placed onto a shared tree. That
 *    distinction matters against shape 3's fail-closed default: #469 and
 *    #472 both stalled with NO PR open yet — exactly the branch shape 3
 *    hard-escalates, because a *blind respawn* there risks clobbering an
 *    unobserved working tree. A `SendMessage` relay carries no such risk —
 *    it never touches the tree, never spawns anything new — so it is safe
 *    to attempt ahead of, and independent of, `resolveReturnedTicket`'s
 *    pr-based branch, PROVIDED the match is confident. `matchHeldVerdicts`
 *    (below) is that match: pure, narrow, and safe-by-default — any
 *    ambiguity defers straight through to shapes 2/3 unchanged, never
 *    weakening #522's escalate-on-no-PR invariant for the genuinely
 *    unmatched case. It is a separate function that runs BEFORE
 *    `resolveReturnedTicket`, not a branch inside it — `resolveReturnedTicket`
 *    itself is untouched by #474 (regression-pinned).
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
 * Narrow, word-boundary parse of which review role(s) a free-text report
 * names as outstanding — deliberately NOT a fuzzy/NLP match (AC.2's "never
 * guess" is the load-bearing rule for #474). Only text inside a clause
 * (split on `.!?;,`) that itself contains a wait/await keyword counts, so a
 * report that RESOLVES one role inline ("Reviewer passed clean.") and only
 * awaits the other in a separate clause ("waiting for the security
 * agent...") correctly yields just the awaited one (#469's shape) — not
 * both merely because both words appear somewhere in the report.
 *
 * Fix-wave hardening (#474, adversarial `forge:reviewer` + `forge:security`
 * both independently reproduced the same class of false relay against
 * ordinary, non-adversarial phrasing — see the plan doc's Fix wave
 * section, round 2):
 *   - **A negated OR already-concluded clause is never extracted from** —
 *     a grammatical negation ("Not waiting on the reviewer, just security."
 *     / "No need to wait…") OR a completion/mootness cue ("The wait…is
 *     over." / "done waiting" / "nothing left to wait for" / "used to be
 *     waiting" / "that's moot now" / "hardly…anymore" / a wait "waived") —
 *     anywhere in the same clause as the wait keyword makes the WHOLE
 *     clause untrustworthy, so it contributes no roles at all rather than
 *     risk reading a disclaimed or already-resolved role as still awaited.
 *     **Honest limit:** this is a curated cue-word list, not a semantic
 *     negation parser — it cannot be exhaustive against arbitrary free
 *     text (a #474 fix-wave round 2 finding: the round-1 list, covering
 *     only grammatical negation, missed "the wait is over"-style
 *     completion phrasing). The residual risk is bounded, not eliminated:
 *     (a) `outcome` is a delivery subagent's own cooperative narration, not
 *     adversarial human-crafted input; (b) a wrong relay's blast radius is
 *     small — it only resumes the SAME already-running subagent with a
 *     verdict message for it to reason about in its own context, and every
 *     downstream gate (adversarial review, the merge bar) independently
 *     re-verifies everything regardless. AC.2's "never guess" is honored
 *     as best-effort-with-a-documented-ceiling, not as a claim of
 *     completeness — matching this codebase's established precedent for
 *     free-text heuristics (see #465's own hedged-not-certain framing).
 *   - **`reviewer` requires the full word, never bare `review`** — "review"
 *     alone collides with too many unrelated, plausible phrases ("security
 *     review", "code review", "review the deployment logs") to be a safe
 *     standalone signal for the CODE-review role.
 *   - **`security` requires a co-occurring forge-review-vocabulary anchor**
 *     in the same clause (`agent`/`verdict`/`check`/`pass`/`notification`/
 *     `confirmation`/`clear(ance)`/`sign-off`/`review(er)`/`result`/`hold`)
 *     — bare "security" alone is too domain-ambiguous ("security group",
 *     "security patch") to be a safe standalone signal either.
 *
 * @param {string} text the report's free-text `outcome`.
 * @returns {Array<'reviewer'|'security'>} sorted, deduplicated awaited roles (possibly empty).
 */
function parseAwaitedRoles(text) {
  if (typeof text !== 'string' || !text.trim()) return [];
  const WAIT_RE = /\b(?:wait(?:ing)?|await(?:ing)?)\b/i;
  // Grammatical negation (round 1) + completion/mootness cues (round 2 fix-wave finding — see JSDoc
  // "Honest limit" above): either kind anywhere in the clause disqualifies the whole clause.
  const NEGATION_RE =
    /\b(?:not|n't|never|no\s+(?:need|longer)|isn't|aren't|doesn't|didn't|won't|done|over|unnecessary|moot|nothing\s+left|stopped|used\s+to|formerly|waived|concluded|hardly)\b/i;
  const BOTH_RE = /\bboth\b/i;
  const SECURITY_RE = /\bsecurity\b/i;
  const SECURITY_ANCHOR_RE = /\b(?:agent|verdict|check|pass|notification|confirmation|clear(?:ance)?|sign-?off|review(?:er)?|result|hold)\b/i;
  const REVIEWER_RE = /\breviewer\b/i; // bare "review" deliberately excluded — see JSDoc above
  const roles = new Set();
  for (const segment of text.split(/[.!?;,]/)) {
    if (!WAIT_RE.test(segment)) continue; // this clause isn't a "waiting on" clause at all
    if (NEGATION_RE.test(segment)) continue; // a disclaimed/negated clause is never a source of awaited roles
    if (BOTH_RE.test(segment)) {
      roles.add('reviewer');
      roles.add('security');
      continue;
    }
    if (SECURITY_RE.test(segment) && SECURITY_ANCHOR_RE.test(segment)) roles.add('security');
    if (REVIEWER_RE.test(segment)) roles.add('reviewer');
  }
  return [...roles].sort();
}

/**
 * #474: match a non-conforming terminal report's free text against review
 * verdicts the loop is ALREADY HOLDING (task notifications from nested
 * `forge:reviewer`/`forge:security` subagents that arrived at the main loop
 * while the delivery subagent was still running — see shape 4 in the
 * file-level comment). Runs BEFORE `resolveReturnedTicket`, not inside it —
 * `resolveReturnedTicket` is untouched by #474, and this function never
 * calls it. On a full, confident match, the caller relays the matched
 * verdict(s) via `SendMessage` (the IO side — never performed here) to
 * resume the SAME already-running subagent from its own transcript, which
 * is why this is safe to attempt independent of whether a PR exists yet
 * (unlike a blind respawn, #522's concern — see the file-level comment).
 *
 * PURE — no IO, no randomness; `heldVerdicts` is entirely caller-observed
 * state (never parsed out of the report's own text), same trust-boundary
 * discipline `resolveReturnedTicket`'s own JSDoc documents for its
 * `pr`/`ciGreen`/`mergeMode` params.
 *
 * @param {object} report
 * @param {number} [report.issue]   the ticket this report belongs to.
 * @param {string} [report.outcome] the subagent's returned (possibly non-conforming) outcome text.
 * @param {Array<{issue:number, role:('reviewer'|'security'), verdict:string, summary?:string}>} [heldVerdicts]
 *   verdicts the loop already holds this run, from task notifications — caller-assembled, not fetched here.
 * @returns {{ action:'relay'|'defer', verdicts:Array<object>, reason:string }}
 *   `relay` → the caller should `SendMessage` `verdicts` to the stalled subagent and await its next report;
 *             ONLY the roles the text actually names, never every held verdict for the issue.
 *   `defer` → no confident match (AC.2 — never guessed); the caller falls straight through to
 *             `resolveReturnedTicket`'s existing, unmodified respawn/escalate classification.
 */
export function matchHeldVerdicts({ issue, outcome } = {}, heldVerdicts = []) {
  // A report that already conforms to a resolved outcome or the awaiting-merge sentinel is
  // resolveReturnedTicket's job alone — never even inspect heldVerdicts for it (#474 must not
  // second-guess an already-classifiable report).
  if (outcome === STALL_OUTCOME || RESOLVED_OUTCOMES.includes(outcome)) {
    return {
      action: 'defer',
      verdicts: [],
      reason: `outcome '${outcome}' is already a resolved/awaiting-merge state — resolveReturnedTicket handles it, no match attempted`,
    };
  }

  const awaitedRoles = parseAwaitedRoles(outcome);
  if (awaitedRoles.length === 0) {
    return {
      action: 'defer',
      verdicts: [],
      reason: 'no recognisable awaited role (security/reviewer) named in the report text — cannot match, falling through to the resume/escalate path',
    };
  }

  const issueVerdicts = (Array.isArray(heldVerdicts) ? heldVerdicts : []).filter((v) => v && v.issue === issue);
  const matched = [];
  const missing = [];
  for (const role of awaitedRoles) {
    const held = issueVerdicts.find((v) => v && v.role === role);
    if (held) matched.push(held);
    else missing.push(role);
  }

  if (missing.length > 0) {
    return {
      action: 'defer',
      verdicts: [],
      reason: issueVerdicts.length === 0
        ? `no held verdicts for issue #${issue} — the report names ${awaitedRoles.join('/')} as outstanding, none held; falling through to the resume/escalate path`
        : `missing held verdict(s) for: ${missing.join(', ')} — the report names ${awaitedRoles.join('/')} but only ${matched.map((v) => v.role).join(', ') || 'none'} of that is held; never a partial relay`,
    };
  }

  return {
    action: 'relay',
    verdicts: matched,
    reason: `report names ${awaitedRoles.join('/')} as outstanding and the loop already holds ${matched.length > 1 ? 'all of those verdicts' : 'that verdict'} for issue #${issue} — relay via SendMessage and resume the same subagent rather than surfacing the stall`,
  };
}

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
  const issueRaw = val('--issue');
  const issue = issueRaw != null ? Number(issueRaw) : null;
  const outcome = val('--outcome');
  const heldRaw = val('--held');
  // #474: when the caller passes --held (a JSON array of {issue, role, verdict, summary?}), try the
  // relay match FIRST — same ordering as the orchestrator's own composition (§ Return-then-resume
  // watchdog): a match short-circuits before resolveReturnedTicket is even consulted.
  if (heldRaw != null) {
    let heldVerdicts;
    try {
      heldVerdicts = JSON.parse(heldRaw);
    } catch {
      console.error(`watchdog: --held is not valid JSON: ${heldRaw}`);
      process.exit(1);
    }
    const match = matchHeldVerdicts({ issue, outcome }, heldVerdicts);
    if (match.action === 'relay') {
      console.log(`watchdog: relay (issue #${issue}, ${match.verdicts.length} verdict(s)) — ${match.reason}`);
      process.exit(5); // #474 — distinct from continue(0)/escalate(3)/respawn(4)
    }
    // action === 'defer': fall through to resolveReturnedTicket below, unchanged.
  }
  const prRaw = val('--pr');
  const dec = resolveReturnedTicket({
    outcome,
    pr: prRaw != null ? Number(prRaw) : null,
    ciGreen: argv.includes('--ci-green'),
    mergeMode: val('--mode') ?? null,
  });
  console.log(`watchdog: ${dec.action}${dec.pr ? ` (PR #${dec.pr})` : ''} → record ${dec.outcome ?? '—'} — ${dec.reason}`);
  // exit codes: 0 continue/merge, 3 escalate, 4 respawn (#464 — distinct from escalate so callers
  // can tell "surface to a human" apart from "resume/re-spawn the subagent").
  process.exit(dec.action === 'escalate' ? 3 : dec.action === 'respawn' ? 4 : 0);
}
