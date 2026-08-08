# Plan: #407 - reduce GraphQL call volume + wire the dead rate-budget preflight

**Ticket:** #407 (parent #183, epic: autopilot hardening) - **Kind:** chore/hardening
**Base:** main - **Branch:** feat/407-graphql-call-reduction

Spec: `docs/specs/2026-08-08-github-resilience.md` §3.1. #360 closed 4 ACs but only
delivered 2: `rateBudget()` (`lib/exec.mjs`) shipped fully implemented and exported
with zero callers, and no call-volume reduction (CI-poll dedup, board-lookup
caching) was ever built. This plan closes that gap without touching the retry
primitive (`isRateLimited`/`retryDelayFrom`/`makeGh`) that already works and is
adopted across 24 files.

## AC map

- **AC-407.1** `rateBudget()` is called at the autopilot run-start preflight and
  re-checked every N iterations; when `low` trips, the loop pauses and surfaces
  the reset window. A FAILED budget check (not just low) degrades to today's
  reactive per-call retry rather than hard-blocking the run.
- **AC-407.2** the 3 independent CI-status pollers (the `forge-ci` monitor, the
  delivery subagent's own `gh pr checks --watch`, `merge.mjs`'s `ciGreen()`) are
  reduced to 2 or fewer for a ticket's lifecycle by threading the monitor's
  known-fresh transition into `ciGreen()`, so a very recent known-green
  transition satisfies the check without a redundant GraphQL re-fetch. The
  mandatory pre-merge green confirmation itself is never removed — only the
  redundant *re-fetch* is skipped when fresh data is already in hand.
- **AC-407.3** board field/option ID lookups (`lib/board.mjs` `getRepoInfo` /
  `getProjectFields`) are cached per-process/per-run instead of re-fetched on
  every op.
- **AC-407.4** a hermetic test (no real API, no real sleep) proves the preflight
  pauses on a mocked low-budget response, mirroring #360's own `exec.test.mjs`
  style.

## Task 1 (item): rate-budget preflight module (AC-407.1, AC-407.4)

New `ratebudget.mjs`, mirroring `sessionpause.mjs`'s pure-decision +
IO-wrapper split (itself mirroring `preflight.mjs`/`ledger.mjs`):
`shouldPauseForBudget(budget)` is the pure boundary decision; `evaluateRateBudget(gh,
{lowWater})` runs the live `rateBudget()` check and maps it through the
decision, degrading to `{pause:false, ok:false}` on a failed check rather than
hard-blocking; `budgetCheckDue(iterations, everyN)` gates the periodic
recheck cadence (default every 10 iterations). SKILL.md documents both the
run-start call (alongside the merge-auth preflight) and the periodic call
(alongside `ledger.mjs`'s `nextIteration`) as required orchestrator steps.

**Files:** plugin/scripts/autopilot/ratebudget.mjs, plugin/skills/autopilot/SKILL.md

## Task 2 (item): thread the CI monitor's fresh transition into `ciGreen()` (AC-407.2)

`monitors/ci-watch.mjs` now persists its last observed rollup state
(`{pr, state, at}`) to `.forge/autopilot/ci-watch.json` on every poll
(`writeCiWatchState`/`loadCiWatchState`, best-effort — a write failure never
crashes the monitor). `autopilot/merge.mjs`'s `ciGreen(gh, pr, {freshState})`
gains a pure `isFreshGreenTransition(state, pr, {now, maxAgeMs})` check (same
pr, state `'pass'`, within a 20s default window) — a match skips the GraphQL
`pr view` re-fetch entirely; anything else (wrong pr, stale, non-pass, or no
freshState at all) falls straight through to the unchanged real re-fetch, so
"nothing merges on red" is untouched. `runMerge` reads the on-disk state via
`ctx.cwd` (present on every real `makeBoardCtx`-resolved ctx; absent on a test
double, which degrades to today's unconditional re-fetch).

**Files:** plugin/scripts/monitors/ci-watch.mjs, plugin/scripts/autopilot/merge.mjs

## Task 3 (item): memoize board identity/schema lookups (AC-407.3)

`lib/board.mjs`'s `getRepoInfo(gh)` and `getProjectFields(gh, projectId)` are
memoized per injected `gh` instance (`WeakMap`-keyed, not a plain object) so
caching is scoped to whoever owns that `gh` — one process/run in production
(notably the long-lived forge-core MCP server), naturally test-isolated (each
test's own `gh` double never shares a cache entry). `{refresh: true}` bypasses
and repopulates the cache; `init.mjs`'s post-field-creation re-discovery call
passes it since that read must reflect the just-applied mutation. A failed
lookup is never cached.

**Files:** plugin/scripts/lib/board.mjs, plugin/scripts/init.mjs

## Task 4 (test): AC-mapped tests

- `tests/autopilot/engine.test.mjs`: `shouldPauseForBudget`/`budgetCheckDue`
  boundary tests + `evaluateRateBudget` hermetic pause/no-pause/degrade tests
  against a mocked `rate_limit` response (AC-407.1, AC-407.4); `ciGreen`
  fresh-transition tests + a `runMerge` integration test that asserts the `pr
  view` call never fires when a fresh on-disk transition exists, and DOES fire
  when it's stale/absent/wrong-pr (AC-407.2).
- `tests/monitors/monitors.test.mjs`: `writeCiWatchState`/`loadCiWatchState`
  round-trip + corrupt-file tolerance (AC-407.2).
- `tests/lib/board.test.mjs`: `getRepoInfo`/`getProjectFields` cache-hit,
  per-projectId isolation, `refresh:true` bypass, failure-never-cached, and
  cross-instance (different `gh`) isolation tests (AC-407.3).

**Files:** tests/autopilot/engine.test.mjs, tests/monitors/monitors.test.mjs, tests/lib/board.test.mjs

## Verification

`npm run verify` (vitest run, full suite — 790+ tests). Gates: plandrift clean
(this plan's **Files:** lists cover every touched file), testintent clean (only
new assertions added, nothing existing weakened — confirmed by re-running the
full pre-existing `init.test.mjs`/`doctor.test.mjs`/`engine.test.mjs`/
`monitors.test.mjs` suites unchanged and green), depguard clean (no new
dependencies), docsync clean (no new docs outside the route index; SKILL.md is
already indexed).
