# Plan: #528 - autopilot/ratebudget: reduce per-ticket GraphQL consumption (continues #407 AC.2/AC.3)

**Ticket:** #528 (board #8, child of epic #183) - **Kind:** bug
**Base:** main - **Branch:** fix/528-boardctx-scoped-lookup - **Verify:** `pnpm verify`

Triage (2026-08-24) verified the crux is `boardctx.mjs`'s `findItemByIssue`,
whose default path always calls `ctx.listItems()` — a full `project
item-list --limit 500` GraphQL fetch of the ENTIRE board — for every
single-item lookup used by `move.mjs`, `close.mjs`, `create.mjs`'s dedup
check, and `escalate.mjs`: nearly every board write a delivery makes. The
cheap scoped per-issue query (`findItemViaIssue`, added for #114's index-lag
case) already exists in the same file but is fallback-only, because it never
carried the field values (`status`/`assignee`/`size`) those callers read off
the returned item.

An earlier hypothesis (#407 AC.3's `getProjectFields` WeakMap memoization
being the crux) is superseded: #360 made field ids config-sourced, so
`getProjectFields` is no longer called by any `board/*.mjs` script in
production — not spent here.

## Design

- Extend `findItemViaIssue`'s GraphQL query to also return `fieldValues`
  (matched back to forge's field keys by field **id**, never display name —
  immune to the #550 Type/Kind alias) and the issue's `assignees`, so its
  return shape matches what `listItems()` already produces.
- Flip `findItemByIssue`'s primary/fallback order: the scoped query first,
  the full `listItems()` scan only when the scoped query misses or fails
  outright. Correctness over savings (spec's own bar): a scoped miss/failure
  must never surface as "not found" on its own say-so — it always falls
  through to the full scan, pinned by a dedicated test.
- `digest.mjs`'s own unscoped `ctx.listItems()` read (AC-3) is evaluated
  against real child counts from #182 (92) and #183 (50) but left
  UNCHANGED: real measurement (see ticket #528 for the method and numbers)
  shows a per-child scoped loop is cheaper in raw GraphQL points today, but
  it would trade away the full scan's fail-loud guarantee (`!list.ok` fails
  the whole digest today; a per-child scoped loop degrades silently to
  per-row "no data" on a systemic failure instead). Pinned with a regression
  test (AC-528.3) rather than changed.
- `KIND_COST_ESTIMATES` (#526, `ratebudget.mjs`) is checked against the
  measured reduction (AC-4) and left UNCHANGED: its values are #462/#448's
  historical, ticket-specific total GraphQL spend, captured against whatever
  board size existed at THAT time (unreconstructable from persisted state —
  today's board holds 292 items, not what it held then). Re-deriving a
  post-fix figure honestly needs a real docs/spike-kind delivery measured
  end-to-end post-fix, which is sibling #531's job, not this ticket's.
  Recorded, not guessed.
- `status.mjs`/`select.mjs`, which genuinely need the full board list, are
  untouched (explicitly out of scope per the ticket's own AC-1 text).

## Acceptance criteria (authoritative text is on the issue; summarised here)

- **AC-1** `findItemByIssue` no longer defaults a single-item lookup to a
  full board scan for `move.mjs`/`close.mjs`/`create.mjs`'s dedup
  check/`escalate.mjs`; the scoped `findItemViaIssue` (extended with field
  values) is the primary path; `digest.mjs`/`status.mjs`/`select.mjs`
  unaffected.
- **AC-2** A real before/after GraphQL cost measurement for one `move.mjs`
  call, showing the fix removes at least one full-board-scan's worth of cost
  per call.
- **AC-3** `digest.mjs`'s child-status lookup evaluated against real numbers
  from #182/#183; scoped down or left as-is with the reason recorded.
- **AC-4** `KIND_COST_ESTIMATES` checked against the measured reduction;
  updated only if it measurably drifted, with the check recorded regardless.

## Task 1 (code + test): scoped-first `findItemByIssue`

Extend `findItemViaIssue`'s GraphQL query (issue `assignees` + per-project-item
`fieldValues`, mapped to forge field keys via a `fieldIdToKey` map built from
`board.fields`); flip `findItemByIssue` to try it first, falling back to
`listItems()` only on a miss/failure. Add `AC-528.1`/`AC-528.2`-labelled
tests to `tests/board.test.mjs`: the scoped path alone satisfies a lookup
(zero `project item-list` calls) with correctly-mapped field values; a
scoped-lookup `gh` failure still falls back to the full scan (never a false
"not found"); a full `runMove` find+setSelect+verify cycle makes zero full
board scans when the scoped path succeeds both times.

**Files:** plugin/scripts/lib/boardctx.mjs, tests/board.test.mjs
**AC map:** AC-528.1, AC-528.2
**Test plan:** `npx vitest run tests/board.test.mjs`

## Task 2 (test-only): AC-3/AC-4 evaluation, pinned

Add an `AC-528.3`-labelled regression test to `tests/board.test.mjs`'s
digest describe block pinning that a `listItems()` failure still fails the
whole digest (the fail-loud behavior AC-3's evaluation chose to keep).
Label the existing `KIND_COST_ESTIMATES` value-pinning test in
`tests/autopilot/engine.test.mjs` `AC-528.4` and record the check's reasoning
in a comment above it.

**Files:** tests/board.test.mjs, tests/autopilot/engine.test.mjs
**AC map:** AC-528.3, AC-528.4
**Done:** `pnpm verify` green; real before/after numbers + the AC-3/AC-4
reasoning recorded on issue #528.
