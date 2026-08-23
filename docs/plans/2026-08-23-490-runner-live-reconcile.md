# #490 — runner-check/doctor: reconcile live registrations against config

Parent epic #182 · bug · p2 · size m

## Problem

`forge:runner-check` and `forge:doctor` assessed the runner layer from
`.claude/forge.json`'s `runner` block alone. Neither asked GitHub what was
actually registered, so a config/reality drift read as healthy. Concretely:
`runner.enabled: false` plus a live orphaned self-hosted registration
produced zero rows from either tool — the exact shape that let three
registrations on a public repo (#489) go unmentioned for weeks after #426
flipped the config.

## Tasks

**T1 — failing tests (AC-490.1, AC-490.3, AC-490.4, AC-490.5)**
**Files:** tests/runner-check.test.mjs, tests/doctor.test.mjs

**T2 — reconcileRunnerRegistrations (AC-490.1, AC-490.3, AC-490.5)**
**Files:** plugin/scripts/lib/runner-checks.mjs

**T3 — wire into runner-check (AC-490.1, AC-490.3)**
**Files:** plugin/scripts/runner/check.mjs

**T4 — wire into doctor (AC-490.1, AC-490.5)**
**Files:** plugin/scripts/doctor.mjs

**T5 — cross-reference existing AC-490.2/AC-490.4 coverage**
**Files:** tests/doctor.test.mjs, tests/runner-check.test.mjs

**T6 — docs sync**
**Files:** plugin/commands/runner-check.md, docs/README.md, docs/plans/2026-08-23-490-runner-live-reconcile.md

## What shipped

A new check, `runner-reconcile`, added to `plugin/scripts/lib/runner-checks.mjs`
as `reconcileRunnerRegistrations()`, wired into both consumers:

- **`plugin/scripts/runner/check.mjs`** (AC-490.1, AC-490.3) — reuses the visibility
  already resolved by check 1 and the runners list already fetched for
  check 5's online probe; adds its own `runner-reconcile` row.
- **`plugin/scripts/doctor.mjs`** (AC-490.1, AC-490.5) — runs unconditionally,
  independent of `runner.enabled` (unlike the pre-existing `checkRunner()`
  block, which stays enabled-gated and untouched), reusing the owner/name
  already resolved for the neighboring `fork-pr-exposure` check.

### Mismatch classes (AC-490.1)

- `registered-but-config-disabled` — config disabled/absent, ≥1 live
  registration exists.
- `config-enabled-but-none-registered` — config enabled, no live
  registration matches the configured labels.
- stale/offline — config enabled, matching registrations exist but none
  are online.
- clean case — config enabled, a matching registration is online → `ok`.

All rows are `warn` or `ok`, never `fail` — additive to, and non-colliding
with, the existing hard-fail paths (`runner-block`/`runner-online`'s
adoption gate, `fork-pr-exposure`'s public-repo fail from #489).

### Degrade-safe (AC-490.3)

If the live `actions/runners` lookup itself fails (no network, no `gh`
auth, insufficient scope, unqueryable repo), the check returns `warn`
naming "could not verify" rather than a false green or a hard failure —
mirrors the idiom already used by `checkDenylistStaleness` and the
rate-budget preflight.

### Silence for the ordinary consumer (AC-490.5)

`runner.enabled: false`/absent with zero live registrations returns `null`
— no row at all, matching the precedent set by #447's staleness check.

### AC-490.2 / part of AC-490.4 — already shipped by #489

The public-repo + registered-runner security case (AC-490.2) and its hermetic
coverage were already implemented by `checkForkPrExposure` (#489, wired
into both `doctor.mjs` and `runner/check.mjs`, tested in both suites).
#489's own plan doc explicitly scoped that ticket as excluding "#490's
broader doctor/runner-check work." This ticket cross-references those
existing tests to `AC-490.2`/`AC-490.4` rather than re-implementing a
second, potentially conflicting check.

### Hermetic tests (AC-490.4)

`tests/runner-check.test.mjs` and `tests/doctor.test.mjs` cover, against
mocked `gh` responses only (no live API calls): public+registered,
private+registered+config-disabled, config-enabled+none-registered,
all-offline-stale, lookup-unavailable, the clean case, org-scoped sharing
(`runner.sharing: 'org'` hits the org endpoint, not the repo endpoint), and
a no-duplicate-fetch assertion (the reconciliation call reuses an
already-fetched runners list rather than re-querying the endpoint a second
time in the same run).

## Out of scope

Re-implementing or modifying `checkForkPrExposure`'s existing AC-490.2 logic;
changes to the `runner.enabled`-gated `checkRunner()` block in `doctor.mjs`.
