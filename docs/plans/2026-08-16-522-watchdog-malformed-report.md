# Plan: #522 - watchdog: a subagent returning no report at all falls through every resolveReturnedTicket branch

**Ticket:** #522 (board #8, child of epic #183) - **Kind:** bug
**Base:** main - **Branch:** fix/522-watchdog-malformed-report - **Verify:** `pnpm verify`

`watchdog.mjs` `resolveReturnedTicket({outcome, pr, ciGreen, mergeMode})` (#319)
models `awaiting-merge` — a well-formed report describing an unfinished state.
#464 added a second classification, `respawn`/`stalled-before-pr`, for a
non-conforming report (missing `outcome`, or free text) — but it applied that
*same* classification whether or not a PR already existed, i.e. it treated "a
PR is open and awaiting review" and "no PR at all, working-tree state
unknown" identically. Delivering #517 (2026-08-16), 3 of 4 delivery attempts
stalled on exactly the second shape — a subagent returning free text with no
PR yet open (e.g. "Still waiting on the full verify suite to finish.") — and
each stall's only real recovery was manual: inspect `git status`/`git log`/
`gh pr list`, judge whether the working-tree diff was salvageable, and
re-spawn with a corrected brief. On one of those occasions, uncommitted
security-critical fixes sat in the tree and nearly got discarded as
"abandoned" work. A blind `respawn` on the no-PR shape does not surface that
judgment call to anyone — it just retries — which is why the manual
inspection kept being necessary despite #464 already being live.

## Design

Bounded to `resolveReturnedTicket`'s classification plus the SKILL.md prose
that documents it (design caution: keep the two consistent). Out of scope,
per the ticket: proactive stall *detection* (#505), automated relay to a
stalled subagent (#474), worktree isolation (#508).

- Split the #464 non-conforming-report branch on the one piece of state the
  caller already has and can pass in — `Number.isInteger(pr)` — never IO
  inside the pure function (AC.3):
  - **No PR** (`pr` not a real number): **unrecoverable**. `action: 'escalate'`,
    `outcome: 'escalated'` (AC.2 — surfaced, fail-closed, never a silent
    terminal success). The shared working tree's state cannot be observed
    from `resolveReturnedTicket`'s inputs, so this forces a human/orchestrator
    to inspect it (the same `git status`/`git log` check the three real
    2026-08-16 recoveries needed) before anything respawns onto it.
  - **PR exists**: **recoverable**. If the caller's own observed `ciGreen`/
    `mergeMode` already show it green + authorized, `action: 'merge'` straight
    away (AC.3's "hand to the merge bar" path — `runMerge` re-verifies
    everything itself, so this is safe even though the outcome text was
    garbage). Otherwise `action: 'respawn'`, `outcome: 'stalled-before-pr'`
    (AC.3's "resume protocol" path) — unchanged from #464.
- `RESOLVED_OUTCOMES`, `STALL_OUTCOME`, `NONCONFORMING_OUTCOME`, and the
  `awaiting-merge` branch are untouched (AC.5 — #319's behaviour, and #464's
  with-PR behaviour, are both preserved byte-for-byte).
- `ledger.mjs`'s `OUTCOMES` already carries both `'escalated'` and
  `'stalled-before-pr'` — no ledger change needed.
- SKILL.md's § Return-then-resume watchdog documents the split explicitly:
  the loop diagram, the § prose, and the § Orchestration paragraph all name
  the no-PR shape as `escalate` and the with-PR shape as `respawn` (or `merge`
  when already green + authorized).

Not touched: `#474`'s automatic `SendMessage`-relay recovery, `#505`'s
proactive liveness detection, `#508`'s worktree isolation for delivery
subagents — all explicitly out of this ticket's scope per its own text.

## Acceptance criteria (authoritative text is on the issue; summarised here)

- **AC.1** `resolveReturnedTicket` handles a malformed/absent report as an
  explicit, named action, never falling through unclassified.
- **AC.2** That action is fail-closed and visible: escalated or recorded
  awaiting-human, never a silent park, never a terminal success.
- **AC.3** Distinguishes recoverable (PR exists → merge bar / resume
  protocol) from unrecoverable (no PR → escalate) using only caller-observed
  state — no IO inside `resolveReturnedTicket`.
- **AC.4** Tests cover the three verbatim #517 returns, plus
  `undefined`/`null`/`''` outcomes.
- **AC.5** Existing `awaiting-merge`/`merged`/`escalated`/`awaiting-human`/
  `skipped` behaviour is unchanged (regression-pinned).

## Task 1 (test): regression tests first

Add an `AC-522.*`-titled describe block to `tests/autopilot/engine.test.mjs`
(alongside the existing `#464` describe block, which is narrowed to cover
only the with-PR/recoverable shape) covering: a missing/`undefined` outcome
with no PR escalates, never respawns/continues (AC.1); `null`/`''` outcomes
with no PR classify identically (AC.4); the malformed text itself is never
recorded as the outcome and the action is never `continue` (AC.2); the
recoverable/unrecoverable split keyed on `pr` alone, pure (AC.3); the three
verbatim #517 returns each escalate with `pr: null` (AC.4). Update the
existing `#464` describe block's no-PR fixture tests (previously asserting
`respawn`) to `pr`-bearing recoverable fixtures instead, since #464's own
AC.5-equivalent list never protected the no-PR/`respawn` combination — only
`awaiting-merge`/`merged`/`escalated`/`awaiting-human`/`skipped` are pinned.
Add a merge-fast-path test (malformed outcome + PR + observed green +
auto-merge → `action: 'merge'`) and a not-yet-green counterpart (stays
`respawn`) to prove AC.3's "hand to the merge bar" path.

Also add an `AC-522.5` doc test to `tests/skills/autopilot.test.mjs`
(mirroring the file's existing `AC-464.5` pattern) that pins the § Return-
then-resume watchdog section naming `#522`, the no-PR-escalates rule, the
PR-already-exists distinction, the three verbatim #517 quotes, and the
working-tree hazard that motivates escalate over a blind respawn — written
first so it fails against the pre-doc-update SKILL.md.

**Files:** tests/autopilot/engine.test.mjs, tests/skills/autopilot.test.mjs
**AC map:** AC-522.1, AC-522.2, AC-522.3, AC-522.4, AC-522.5
**Test plan:** see above; run
`npx vitest run tests/autopilot/engine.test.mjs tests/skills/autopilot.test.mjs`.

## Task 2 (code): split the non-conforming shape on `pr` in watchdog.mjs

- `resolveReturnedTicket`: inside the existing non-conforming-report branch
  (after the `STALL_OUTCOME`/`RESOLVED_OUTCOMES` checks), branch on
  `Number.isInteger(pr)` — no PR → `action: 'escalate'`, `outcome:
  'escalated'`; PR present + `ciGreen === true` + `isAutoMergeMode(mergeMode)`
  → `action: 'merge'`, `outcome: 'merged'`; PR present otherwise → the
  existing `action: 'respawn'`, `outcome: NONCONFORMING_OUTCOME` path,
  unchanged.
- Update the file's top-of-file JSDoc (the two-stall model becomes a
  three-shape model) and the function's own JSDoc to match.
- No CLI (`isMain`) change needed — exit code `3` (escalate) and `4`
  (respawn) already cover both outcomes of the split; `0` already covers
  `merge`.

**Files:** plugin/scripts/autopilot/watchdog.mjs
**AC map:** AC.1, AC.2, AC.3
**Done:** Task 1's tests pass; `npx vitest run tests/autopilot/engine.test.mjs`
green.

## Task 3 (docs): SKILL.md + route index

- `plugin/skills/autopilot/SKILL.md` § Return-then-resume watchdog: document
  the split explicitly (three shapes, not two) — the no-PR shape escalates,
  the with-PR shape respawns (or merges when already observed green +
  authorized). Update the loop diagram's watchdog lines, § Orchestration's
  paragraph 2, and the § Driver scripts bullet for `watchdog.mjs` to match.
- Add this plan to `docs/README.md`.

**Files:** plugin/skills/autopilot/SKILL.md, docs/README.md
**AC map:** AC.5
