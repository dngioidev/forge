# Plan: #466 - fix: autopilot orchestrate-only for every stage, not just deliver

**Ticket:** #466 (board #8, child of #183) - **Kind:** bug - **Base:** main - **Branch:** fix/466-orchestrate-only-every-stage

Spec (already committed on this branch, owner-approved): `docs/specs/2026-08-13-autopilot-orchestrate-only-every-stage.md`.
Amends `docs/specs/2026-07-21-forge-autopilot.md` § Orchestration and `docs/specs/2026-07-21-forge-autopilot-crazy-mode.md` §4.

## AC map (from the approved spec §6 AC-1..AC-7, ticket-prefixed for acgate)

- **AC-466.1** (spec AC-1) `SKILL.md` § Orchestration mandates a spawned
  subagent for **every** `select.mjs` action (resume/deliver/triage/shape);
  states "the main loop never runs a skill inline."
- **AC-466.2** (spec AC-2) the `--shape` route spawns a shape subagent with a
  self-contained brief, consumes only its terminal JSON; `crazy-mode.md` §4's
  diagram shows the spawn.
- **AC-466.3** (spec AC-3) the delivery brief no longer carries a
  `shape-first` fused route.
- **AC-466.4** (spec AC-4) the shape brief mandates escalate-before-return
  (writes via `escalate.mjs` before returning, forbids returning awaiting
  re-invocation); its outcome passes through `watchdog.mjs`.
- **AC-466.5** (spec AC-5) the loop re-reads `run.json` at the top of every
  iteration; the resume protocol covers "fresh session or after compaction";
  `mergeMode` is documented as a record of a past grant, not a recoverable
  grant.
- **AC-466.6** (spec AC-6) `ledger.mjs` accepts `ready` as an outcome; outcome
  entries carry the producing `stage`; `renderReport` emits a `ready:` line.
  A test asserts `applyOutcome(run, {issue, outcome:'ready', stage:'shape'})`
  round-trips (throws today).
- **AC-466.7** (spec AC-7) `tests/skills/autopilot.test.mjs` extends the #156
  orchestrate-only test to shape/triage; `tests/skills/shape.test.mjs` pins
  the spawn + escalate-before-return contract. Both fail against today's
  docs.

## Task 1 (test): ledger vocabulary for `ready` + `stage` (AC-466.6)

Extend `tests/autopilot/engine.test.mjs`'s ledger describe block:
- `applyOutcome(run, {issue, outcome:'ready', stage:'shape'})` round-trips
  (does not throw) and the entry carries `stage:'shape'`.
- `applyOutcome` on a `merged` outcome without a `stage` still works
  (back-compat — `stage` defaults to `null`).
- `renderReport` emits a `ready:` line when a `ready` outcome is present,
  formatted the same as the other `OUTCOMES` lines.

**Files:** tests/autopilot/engine.test.mjs

## Task 2 (implementer): ledger.mjs accepts `ready` + records `stage`

- `OUTCOMES` gains `'ready'` (order: keep `merged/escalated/skipped/awaiting-human`
  then `ready`, so existing report ordering is untouched).
- `applyOutcome(run, {issue, outcome, ref, stage = null})` — entry gains a
  `stage` field, default `null` (back-compat: no existing caller passes it,
  none is required to).
- `renderReport` already maps every `OUTCOMES` entry generically via
  `OUTCOMES.map(line)`, so a `ready:` line falls out for free once `ready`
  joins `OUTCOMES` — no separate rendering code needed, just confirm/test it.

**Files:** plugin/scripts/autopilot/ledger.mjs

## Task 3 (test): SKILL.md universal delegation + re-read-don't-remember (AC-466.1, AC-466.5, AC-466.7)

Extend `tests/skills/autopilot.test.mjs`:
- **AC-466.1/AC-466.7:** a new test (`#466`) asserting `SKILL.md` states the main
  loop "never runs a skill inline," names all four actions
  (resume/deliver/triage/shape) as spawned, and the § Orchestration table
  lists a subagent per action.
- **AC-466.5:** a test asserting the loop diagram / prose documents re-reading
  `run.json` at the top of every iteration, the resume protocol covers
  "fresh session **or** after compaction," and `mergeMode` is documented as
  a record of a past grant, not a recoverable grant (existing #397/#398 prose
  already says the classifier re-evaluates per attempt — extend the
  assertion to the explicit "record, not a recoverable grant" framing).
- **AC-466.3:** a test asserting the delivery brief no longer contains the
  `shape-first` fused-route clause.

**Files:** tests/skills/autopilot.test.mjs

## Task 4 (test): shape spawn + escalate-before-return (AC-466.2, AC-466.4, AC-466.7)

Extend `tests/skills/shape.test.mjs`:
- **AC-466.2:** `crazy-mode.md` §4's diagram shows a spawn for the `shape`
  branch (not an inline call); `SKILL.md`'s crazy-mode section documents the
  shape subagent spawn (Task tool, pinned model) parallel to the delivery
  spawn.
- **AC-466.4:** `shape/SKILL.md` mandates writing the escalation via
  `escalate.mjs` **before returning**, explicitly forbids returning awaiting
  re-invocation (the return-then-resume stall, mirroring #319/#177's
  delivery-side language), and states its outcome passes through
  `watchdog.mjs` like every other report.

**Files:** tests/skills/shape.test.mjs

## Task 5 (docs): SKILL.md — universal delegation, shape/triage spawns, re-read-don't-remember (AC-466.1, AC-466.3, AC-466.5)

- § Orchestration: generalize the opening line from "the main loop only
  orchestrates" (delivery-specific framing) to state the universal rule
  verbatim: *"The main loop never runs a skill inline. Every action
  `select.mjs` returns is executed in a spawned subagent."* Add the
  action→subagent→brief→terminal-report table from the spec §3.1.
- Add spawn instructions for `shape` and `triage` actions (Task tool,
  `subagent_type: general-purpose, model: sonnet`, pinned per #379/#101,
  self-contained brief, terminal report contract) alongside the existing
  delivery spawn paragraph.
- Delete the `"shape-first under --shape"` clause from the delivery brief's
  route description (§ Orchestration item 1) — one action, one spawn.
- § Crazy mode: update the prose so `--shape` is described as spawning a
  shape subagent, not running `forge:shape` inline.
- § The loop (ASCII diagram): note that `select next actionable ticket` is
  followed by a spawn keyed on the returned action (deliver/resume → delivery
  subagent; triage/shape → their own subagents), not just delivery.
- § Resume protocol: add "the loop re-reads `run.json` at the top of every
  iteration — before selecting — so a mid-run auto-compaction is harmless by
  construction; the resume protocol below applies on a fresh session **or
  after any compaction**." Add the explicit failure-mode note: `mergeMode` in
  `run.json` is a record of a past grant, not a recoverable grant — a
  re-anchored loop must not believe merge authority was restored merely
  because `run.json` still shows `auto-merge`.

**Files:** plugin/skills/autopilot/SKILL.md

## Task 6 (docs): crazy-mode.md diagram + shape SKILL.md escalate-before-return (AC-466.2, AC-466.4)

- `docs/specs/2026-07-21-forge-autopilot-crazy-mode.md` §4: redraw the
  ASCII diagram so `backlog + NOT shaped + --shape ──▶ forge:shape` shows a
  spawn (Task tool, own context) rather than an inline call — mirroring how
  `forge-autopilot.md`'s own diagram already draws the delivery spawn.
- `plugin/skills/shape/SKILL.md` § Ground gate / § Guardrails: add the
  escalate-before-return mandate — write the escalation via `escalate.mjs`
  **before** returning; never return expecting re-invocation (nothing
  re-invokes a returned subagent); state that the shape outcome
  (`ready`/`escalated`) passes through the loop's `watchdog.mjs` like every
  other delivery report.

**Files:** docs/specs/2026-07-21-forge-autopilot-crazy-mode.md, plugin/skills/shape/SKILL.md

## Task 7 (docs): route index

Add this plan to `docs/README.md`'s route index (spec is already listed
from the earlier commits on this branch — confirm, don't duplicate).

**Files:** docs/README.md
