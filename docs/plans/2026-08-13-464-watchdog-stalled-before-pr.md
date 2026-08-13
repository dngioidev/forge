# Plan: #464 - watchdog misses the stalled-before-PR return shape

**Ticket:** #464 (board #8, child of epic #183) - **Kind:** bug
**Base:** main - **Branch:** fix/464-watchdog-stalled-before-pr - **Verify:** `pnpm verify`

`watchdog.mjs` `resolveReturnedTicket({outcome, pr, ciGreen, mergeMode})` catches
the `awaiting-merge` stall (a subagent that opened a green PR then returned
awaiting a re-invocation). It does not catch the shape that happened four times
in the 2026-08-11/13 autopilot run: a delivery subagent spawns a
`forge:reviewer`/`forge:security` subagent, then **returns before opening a
PR** (or with a PR still awaiting review), with a terminal report that is not
the `{issue, outcome, pr, ciGreen, ...}` contract at all — free text like
"Waiting on the reviewer's re-confirmation." `resolveReturnedTicket` currently
falls through any `outcome` other than `'awaiting-merge'` as `action: continue`
— for a genuinely resolved outcome (`merged`/`escalated`/`awaiting-human`/
`skipped`/`ready`) that is correct, but for a non-conforming report (missing or
unrecognised `outcome`) it silently records `outcome: null` as though resolved,
which is the exact gap: the ticket parks on a pushed branch (with or without a
PR) until a human notices.

## Design

Bounded to the classify-and-document slice (triage's scope call, 2026-08-13);
#474 (automatic `SendMessage`-relay recovery) and #475 (spike: synchronous
adversarial passes) are explicitly out of scope here.

- `watchdog.mjs` gains an explicit `RESOLVED_OUTCOMES` allow-list —
  `['merged', 'escalated', 'awaiting-human', 'skipped', 'ready']` (the same
  vocabulary `ledger.mjs`'s `OUTCOMES` already records, plus shape's `ready`,
  which SKILL.md documents as a harmless watchdog pass-through). Only an
  `outcome` in this list — or the existing `STALL_OUTCOME` sentinel
  (`'awaiting-merge'`) — is a report the watchdog has ever seen before.
- Anything else (`outcome` missing, `null`, or an unrecognised value —
  including free text truncated into the field, or simply absent because the
  return wasn't structured at all) is now classified as a **second, distinct**
  stall: `NONCONFORMING_OUTCOME = 'stalled-before-pr'`. `resolveReturnedTicket`
  returns `{ action: 'respawn', outcome: 'stalled-before-pr', pr, reason }` —
  never `action: 'continue'` and never a recorded `outcome: null` — so the
  orchestrator has a real, actionable, non-silent state to branch on (AC.1).
  `pr` is carried through (parsed the same way the `awaiting-merge` branch
  already does — `Number.isInteger(pr) ? pr : null`) so the loop knows whether
  it's resuming to open a first PR or resuming a subagent that already has one
  open and is mid-review (AC.2's two fixture shapes: #429/#446/#460 have no
  PR yet, #437 has one open). Either way the recovery is the same shape —
  resume or re-spawn the subagent, never funnel to the merge bar — which is
  what makes it a genuinely different action from `awaiting-merge`'s
  `merge`/`escalate` outcomes.
- Pure, no IO (AC.3): same signature shape as today, only the classification
  logic changes; the CLI entry point gains a `4` exit code for `action:
  'respawn'` so callers can distinguish it from `escalate` (`3`) and the
  already-resolved `continue`/`merge` paths (`0`).
- SKILL.md's § Return-then-resume watchdog documents the second shape
  alongside the first (AC.5): what triggers it, why briefing alone didn't
  prevent it (agent reaches for the only "wait" shape it knows), and the
  recovery (resume/re-spawn, not merge).

Not touched: `#474`'s automatic `SendMessage`-relay recovery (this ticket only
classifies and surfaces the state — actually driving the resume/re-spawn stays
orchestrator prose + a human/loop decision, same as the existing `escalate`
action does today) and `#475`'s synchronous-adversarial-passes question (a
delivery-contract product decision, not this ticket's or the engine's to make).

## Fix wave: adversarial `forge:reviewer` found two majors, both fixed

`forge:security` passed clean (zero findings). `forge:reviewer` returned
`verdict: fail` with two major findings, both addressed here (plus two minor
findings, also fixed):

1. **`ledger.mjs`'s `OUTCOMES` allowlist didn't include `'stalled-before-pr'`**,
   so an orchestrator following SKILL.md's claim that the state "records"
   would hit `applyOutcome` throwing `unknown outcome`. Fixed by adding
   `'stalled-before-pr'` to `ledger.mjs`'s `OUTCOMES` (mirroring exactly how
   `'ready'` was added for #466 AC-6) — now genuinely recordable, so a real
   run report can show the stall, and a later resolved outcome for the same
   issue naturally supersedes it (`applyOutcome` is last-write-wins per issue).
2. **The `AC-464.5` test and its plan-doc update were uncommitted** at review
   time — working-tree edits not yet part of the reviewed commit. Fixed by
   committing them together with the rest of the fix wave.
3. *(minor)* **`action: 'resume'` collided with `select.mjs`'s existing
   `'resume'` selection action** — same string, two different concepts, both
   named in the same SKILL.md loop diagram. Renamed the watchdog's action to
   `'respawn'` throughout (code, tests, SKILL.md) to remove the ambiguity;
   `select.mjs`'s own `resume` action is untouched.
4. *(minor)* **`outcome ?? 'none'` didn't catch an empty-string outcome** in
   the `reason` text (cosmetic — classification/action/outcome fields were
   unaffected). Fixed with an explicit truthiness check that also catches `''`.

## Acceptance criteria (authoritative text is on the issue; summarised here)

- **AC.1** `resolveReturnedTicket` classifies a non-conforming terminal report
  as a distinct actionable state (`action: 'respawn'`, `outcome:
  'stalled-before-pr'`), never as `continue`/`outcome: null`.
- **AC.2** The returned action distinguishes stalled-before-PR (`action:
  'respawn'`) from `awaiting-merge` (`action: 'merge'`/`'escalate'`) — carries
  `pr` through so the loop knows whether a PR already exists.
- **AC.3** Stays pure — no IO in `resolveReturnedTicket` itself.
- **AC.4** Tests pin the four observed shapes (#429, #437, #446, #460),
  including #460 (agent stalls awaiting verdicts the orchestrator already
  holds).
- **AC.5** SKILL.md's § Return-then-resume watchdog documents the second
  shape alongside the first.

## Task 1 (test): regression tests first

Add an `AC-464.*`-titled describe block to `tests/autopilot/engine.test.mjs`
covering: a missing/`undefined` outcome with no PR classifies as
`stalled-before-pr`/`respawn` (not `continue`) (AC.1); free-text-shaped input
(an `outcome` that isn't in the resolved set) with no PR does the same
(AC.1); the four fixture shapes #429/#437/#446/#460 each resolve to `action:
'respawn'`, `outcome: 'stalled-before-pr'`, with `pr` correctly `null` (#429,
#446, #460) or carried through (#437) (AC.4); the existing resolved-outcome
pass-through set (`merged`/`escalated`/`awaiting-human`/`skipped`/`ready`)
still returns `action: 'continue'` unchanged (regression guard); the existing
`awaiting-merge` merge/escalate behaviour is untouched (regression guard).
Update the one pre-existing assertion this ticket deliberately changes
(`resolveReturnedTicket({}).action === 'continue'`, previously asserting the
exact bug this ticket fixes) to the corrected expectation, with a comment
citing #464. Written first against the pre-fix code so the new AC-464.1/AC-464.4
assertions fail, confirming the gap.

Also add an `AC-464.5` doc test to `tests/skills/autopilot.test.mjs` (mirroring
the file's existing SKILL.md-content-check pattern, e.g. `#177`/`AC-466.5`)
that pins the § Return-then-resume watchdog section naming both `#319` and
`#464`, the `stalled-before-pr` state, and its `action: respawn` recovery
(distinct from funnelling to the merge bar) — written first so it fails
against the pre-doc-update SKILL.md.

Fix-wave addition: a small `describe` in the ledger section of
`tests/autopilot/engine.test.mjs` (mirroring `AC-466.6`'s pattern exactly)
proves `applyOutcome`/`renderReport`/disk round-trip accept
`outcome:'stalled-before-pr'` without throwing (AC.1, fix-wave finding 1).

**Files:** tests/autopilot/engine.test.mjs, tests/skills/autopilot.test.mjs
**AC map:** AC-464.1, AC-464.2, AC-464.3, AC-464.4, AC-464.5
**Test plan:** see above; run `npx vitest run tests/autopilot/engine.test.mjs tests/skills/autopilot.test.mjs`.

## Task 2 (code): classify the non-conforming shape in watchdog.mjs

- Export `RESOLVED_OUTCOMES` and `NONCONFORMING_OUTCOME` alongside the
  existing `STALL_OUTCOME`.
- `resolveReturnedTicket`: after the existing `STALL_OUTCOME` branch, check
  `RESOLVED_OUTCOMES.includes(outcome)` for the `continue` pass-through
  (replacing the old unconditional fall-through); anything else returns the
  new `action: 'respawn'` decision with `pr` parsed and a reason distinguishing
  the no-PR vs PR-open cases.
- CLI (`isMain` block): map `action === 'respawn'` to exit code `4`.
- `ledger.mjs`'s `OUTCOMES` gains `'stalled-before-pr'` (fix wave, mirroring
  the `'ready'`/#466-AC-6 precedent) so the state is genuinely recordable, not
  just returned from the pure decision function.

**Files:** plugin/scripts/autopilot/watchdog.mjs, plugin/scripts/autopilot/ledger.mjs
**AC map:** AC.1, AC.2, AC.3
**Done:** Task 1's tests pass; `npx vitest run tests/autopilot/engine.test.mjs`
green.

## Task 3 (docs): SKILL.md + route index

- `plugin/skills/autopilot/SKILL.md` § Return-then-resume watchdog: document
  the `stalled-before-pr` shape next to `awaiting-merge` — what triggers it
  (a non-conforming free-text return, not the `awaiting-merge` sentinel), why
  briefing alone didn't prevent it, and its recovery (`action: 'respawn'` —
  resume or re-spawn the subagent; never funnel to the merge bar). Update the
  loop diagram's watchdog line and the action table to include the new
  action.
- Add this plan to `docs/README.md`.

**Files:** plugin/skills/autopilot/SKILL.md, docs/README.md
**AC map:** AC.5
