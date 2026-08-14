# Plan: #489 - fork-PR execution-surface check (AC.2 only)

**Ticket:** #489 (board #8, child of epic #214) - **Kind:** bug (security diagnostic)
**Base:** main - **Branch:** fix/489-fork-pr-approval-check
**Verify:** `pnpm verify`

Re-triaged twice; the current issue body and the 2026-08-14 trail comment are
authoritative (the original body's "stale registration / persistent
compromise" framing was corrected — the runner design is JIT + `--ephemeral`,
ADR-0005, and the residual risk is *execution*, not credential persistence).

## Scope boundary — AC.2 only, do not widen

- **AC.1** (remove registrations) is mostly done and the Windows leg is
  **owner-gated** (needs an elevated shell) — not this plan's job, not
  attempted here.
- **AC.3** (auto-start mechanism identified) is already satisfied — no work.
- **AC.4** moved to #462 (docs posture) — not this plan's job.
- This plan delivers **AC.2 only**: close the fork-PR path *by configuration*,
  made *mechanically verifiable* — not a one-time manual claim — with a
  documented fallback per the ticket's own reshaping, and a tie-in to #490
  (which owns the *general* live-registration reconciliation; this plan does
  not implement #490's broader doctor/runner-check work, only the one
  fork-PR-approval assertion AC.2 explicitly calls for).
- **No repo-settings change.** This plan only reads and reports the live
  fork-PR-approval policy. If the live value is not the strictest setting,
  the mechanical check reports it (fail/warn with a fix hint pointing at the
  Settings UI) — it never calls a write endpoint. Changing the posture is the
  owner's call (hard boundary in the ticket).

## Live-verification finding (updates the ticket's own uncertainty)

The ticket's AC.2 text assumed the fork-PR-approval policy "cannot be
read/set via API for a non-org personal repo" and planned a manual-only
fallback for that case. Live-checked during planning (2026-08-14): the
`GET /repos/{owner}/{repo}/actions/permissions/fork-pr-contributor-approval`
endpoint (enum `first_time_contributors_new_to_github` |
`first_time_contributors` | `all_external_contributors`) **is readable**
on this personal-account repo — the ticket's premise for the manual-only
path doesn't hold here. The manual-verification fallback is still
implemented (for the case the call itself fails — different scope, GitHub
changes the surface, etc.) but is not the primary path. (This repo's own
current runner-registration count and live policy value are deliberately
**not** restated in this committed, public-repo doc — see the
`fork-pr-exposure` gate's own live output, or the ticket's private-facing
delivery trail, for the current numbers; this file only needs to pin the
check's *design*, not stand as a running disclosure of this repo's exact
exposure.)

**Severity read:** `all_external_contributors` is the only value that fully
closes the gap while a self-hosted runner is registered on a public repo —
`first_time_contributors*` still lets a contributor who already has one
approved PR push a later, unapproved malicious PR that runs on the host.
So the check treats "a runner is registered AND the policy is anything less
strict than `all_external_contributors`" as `fail`, regardless of whether
that combination currently holds for this repo — that is the correct,
non-gameable signal (see the AC map below for why "ok" requires the
strictest policy specifically, not merely "some approval requirement").

## AC map

- **AC-489.2** `forge:doctor` and `forge:runner-check` gain a shared
  `checkForkPrExposure` (own function in `runner-checks.mjs`, the existing
  single-source-of-truth lib both commands already draw from) that:
  - is a no-op (`skip`) on a private repo;
  - on a public repo, queries **all** registered self-hosted runners
    (any labels — not just this project's configured set, so a leftover
    registration from unrelated tooling is still caught) via the repo
    runners endpoint; zero registered → `ok` (no exposure surface);
  - when ≥1 is registered, reads the live
    `actions/permissions/fork-pr-contributor-approval` policy; `ok` only
    when it is `all_external_contributors`; **`fail`** otherwise, naming the
    runner count and the live policy value, with a fix hint pointing at
    Settings → Actions → General → "Fork pull request workflows from outside
    collaborators" (never a write call);
  - degrades to `warn` (not a crash, not a silent `ok`) when either gh API
    call itself fails, naming the documented manual-verification fallback
    and cross-referencing #490 for the ongoing reconciliation work — this is
    what keeps the check from reporting a false green when the API is
    unreachable.
  - Runs **independent of this repo's own `runner.enabled`** config — the
    exposure is whatever is actually registered on GitHub right now, which
    is exactly the config/reality drift #489 was filed over (this repo's own
    `runner.enabled` is `false` today, so the existing `runner.enabled`-gated
    checks stay silent and would otherwise miss this).

## Task 1 (feature): checkForkPrExposure in runner-checks.mjs

New exported function alongside the other shared checks: argv-only gh calls,
never throws, matches the existing `ok/warn/fail/skip` result shape.

**Files:** plugin/scripts/lib/runner-checks.mjs
**AC map:** AC-489.2

## Task 2 (feature): wire into doctor.mjs

Call `checkForkPrExposure` from `runDoctor`, reusing the visibility already
resolved for the existing branch-protection/secret-scanning block (no extra
`gh repo view` round trip) — placed as its own always-eligible check, not
nested inside the `runner.enabled`-gated `checkRunner` block.

**Files:** plugin/scripts/doctor.mjs
**AC map:** AC-489.2

## Task 3 (feature): wire into runner/check.mjs

Call `checkForkPrExposure` from `runCheck`, reusing the `fetchRepoVisibility`
result already resolved for the private-repo guard (check 1).

**Files:** plugin/scripts/runner/check.mjs
**AC map:** AC-489.2

## Task 4 (test): doctor wiring

New describe block in `tests/doctor.test.mjs`: private repo → `skip`; public
repo + zero runners registered → `ok`; public + runners registered +
`all_external_contributors` → `ok`; public + runners registered + a
less-strict policy (e.g. `first_time_contributors`) → `fail` naming the
policy and runner count; a malformed (200 but shapeless) runners-list
response → `warn`, never a silent `ok`; runners-list API failure → `warn`
fallback; approval-endpoint API failure → `warn` fallback naming the
manual-verification path and #490.

**Files:** tests/doctor.test.mjs
**AC map:** AC-489.2

## Task 5 (test): runner-check wiring

New assertions in `tests/runner-check.test.mjs` mirroring Task 4's cases
through `runCheck`, confirming the same result shape/severity there.

**Files:** tests/runner-check.test.mjs
**AC map:** AC-489.2

## Task 6 (docs): route index

Add this plan to `docs/README.md`'s plan index.

**Files:** docs/README.md
