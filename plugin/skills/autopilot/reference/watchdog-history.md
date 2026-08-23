# Return-then-resume watchdog — field evidence & archaeology (#319, #464, #474, #522)

Reference for `plugin/skills/autopilot/SKILL.md` § Return-then-resume watchdog (#561 —
relocated, not deleted). SKILL.md keeps the operative decision procedure — what each of
the five report shapes (`relay`/`merge`/`escalate`/`respawn`/`escalate again`/`continue`)
means and what the loop does about it; this file holds the deeper "why" (the repeated
field failures that motivated the mechanism, and the verbatim non-conforming returns that
calibrated its classification) that a run doesn't need loaded to react correctly, only to
understand why the backstop exists or to recalibrate it.

## Why briefing alone doesn't close the stall

The forbidden pattern (§ Orchestration — a subagent must never open its PR and return
awaiting an external/background completion notification) is a *briefing* rule. The
watchdog is its mechanical backstop, because briefing alone was tried first and did not
hold: the 2026-08-11/13 run had the warning in bold, with a running stall count, in every
delivery brief, and it still stalled four times. The 2026-08-16 run delivering #517
repeated it — 3 of 4 attempts — with an even sharper brief (a named "RULE ZERO" section
quoting the prior failures verbatim). The pattern was consistent across both runs: the
agent reaches for the only "wait" shape it knows (returning, or narrating a backgrounded
step) instead of finishing in-run. Its own return discards the context that would have
received the answer — which is exactly why a mechanical, return-time classifier (not a
better-worded brief) was the fix.

## #474 relay — field evidence

`matchHeldVerdicts(report, heldVerdicts)` runs FIRST on every non-conforming report,
relaying a verdict the orchestrator already holds (via `SendMessage`, to the SAME
already-running subagent, resumed from its own transcript) whenever the report's free
text names a role it's awaiting and the loop already holds that role's verdict. Six real
instances confirm this recovery works: #464's own #429/#437/#446/#460, plus two fresh
in the run that motivated #474 itself:

- **#469** — "Reviewer passed clean. Now waiting for the security agent's completion
  notification before proceeding to ship." Reviewer resolves inline; only security is
  named and held → relay just security.
- **#472** — "I'll wait for the notification when both agents finish; no further action
  needed from me right now." No role named individually, but "both" implies
  reviewer+security, and both are held → relay both.

Both of those stalled with **no PR open yet** — exactly the branch `resolveReturnedTicket`
hard-escalates on purpose (#522) — but a `SendMessage` relay carries none of #522's
blind-respawn risk, since it never touches the working tree or spawns anything new, so it
is safe to attempt independent of whether a PR exists.

## `respawn` / `escalate` (again) — the verbatim non-conforming returns that calibrated the split

The `respawn` (stalled-before-PR, recoverable, #464) and `escalate`-again (malformed/
absent report, unrecoverable, no PR, #522) shapes were calibrated against real
non-conforming returns, not hypothetical ones:

- **Recoverable (a PR was already open), so `respawn`:** *"Waiting on the reviewer's
  re-confirmation"* / *"I'm waiting on both re-review verdicts for the final tip"*
  (#437 and siblings).
- **Unrecoverable (no PR at all), so `escalate` again:** *"I'll wait for the resumed
  implementer agent to report the final results"* / *"Full test suite is running in the
  background… I'll proceed once it completes"* /
  *"Still waiting on the full verify suite to finish"*
  — the three verbatim returns observed delivering #517 on 2026-08-16. Unlike the
  recoverable shape there is nothing here to resume INTO, and the
  shared working tree's state (uncommitted? mid-edit? nothing at all?) is not observable
  from `resolveReturnedTicket`'s inputs — a bare respawn risks a fresh subagent silently
  discarding or clobbering whatever is sitting there. That run's own secondary finding
  makes the risk concrete: uncommitted security-critical fixes were nearly discarded as
  "abandoned" before a human manually ran `git status`/`git log` to recover them — exactly
  the check `escalate` (again) now forces before anything touches the tree.

## Design rationale — why the splits are keyed the way they are

The relay/defer split (#474) is keyed on the free-text-to-held-verdict match; the
respawn/escalate split (#464/#522) beneath it is keyed on `pr`, the one piece of state
the caller can actually observe (AC.3) — both `matchHeldVerdicts` and
`resolveReturnedTicket` stay pure, with all of this state passed in, never fetched inside
either. That purity is what makes both hermetically testable against a mocked report/
held-verdicts pair, with no real subagent, no real GitHub call.

## How this relates to #505's agent-liveness monitor

#474 automates the #460 shape's recovery — relaying a verdict the orchestrator already
holds via `SendMessage` — for exactly the cases `matchHeldVerdicts` can confidently
match; an unmatched stall still falls through to ordinary re-selection/respawn/escalate as
before. Proactively *detecting* a stall before the subagent even returns is a separate
layer (#505's agent-liveness monitor, § Monitor notifications `forge-agents`) — this
watchdog only classifies/relays a return that already happened.
