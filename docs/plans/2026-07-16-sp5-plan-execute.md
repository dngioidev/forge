# SP5 — Plan + execute — Implementation Plan

**Epic:** #7 · **Spec:** [platform design v3.7](../specs/2026-07-15-forge-platform-design.md) §4 items 4/5, §13
**Branch:** `feat/7-plan-execute` · **Verify:** `pnpm verify` · **Date:** 2026-07-16

## Acceptance criteria

- **AC-5.1** — `forge:plan` skill with a machine-parseable plan template: per task `**Files:**` list and `**AC map:**` (AC-`<ticket>`.`<n>` ids), test-plan section, verify command, done criteria; plan gate auto by default (config can require sign-off).
- **AC-5.2** — AC gate (`gates/acgate.mjs`): given the plan's AC ids and a vitest JSON results file, passes only when every AC id appears in ≥1 **passing** test title; missing and failing ids named individually. Machine evidence only — never role reports.
- **AC-5.3** — Plan-drift gate (`gates/plandrift.mjs`): branch's touched files vs the plan's declared files + scoper extensions (`.forge/scope.json`) + default-allowed globs (tests/, docs/, CHANGELOG); deviations listed with the escalate instruction; clean branches pass.
- **AC-5.4** — Dependency guard (`gates/depguard.mjs`): new packages (diff vs main's package.json) checked against the registry — exists, age ≥ 90 days, weekly downloads ≥ 500 — violations named; existing/removed deps ignored; injected fetch for tests.
- **AC-5.5** — Test-intent gate (`gates/testintent.mjs`): removed/weakened assertion lines in *existing* test files flagged for reviewer sign-off (anti-gaming law); pure additions and new test files pass.
- **AC-5.6** — Ledger (`lib/ledger.mjs`): init from a plan's task list, mark task status, `next()` returns the first incomplete task; `.forge/progress.md` stays human-readable; the execute skill's resume protocol reads it.
- **AC-5.7** — `forge:plan` + `forge:execute` skills; `forge:ship` upgraded from degraded to mechanical gates (acgate/plandrift/testintent/depguard); suite green win+linux.

## Tasks

- **T1 — ledger lib** + tests (parse/init/mark/next; CRLF-safe).
  **Files:** plugin/scripts/lib/ledger.mjs, tests/lib/ledger.test.mjs
- **T2 — acgate** + tests (vitest JSON fixture; pass/missing/failing-AC cases; plan-file AC extraction).
  **Files:** plugin/scripts/gates/acgate.mjs, tests/gates/acgate.test.mjs
- **T3 — plandrift** + tests (declared+scope+default-allow; deviation naming; injected git exec).
  **Files:** plugin/scripts/gates/plandrift.mjs, tests/gates/plandrift.test.mjs
- **T4 — depguard** + tests (new/existing/removed diff; registry existence/age/downloads via injected fetch; npm-only v1).
  **Files:** plugin/scripts/gates/depguard.mjs, tests/gates/depguard.test.mjs
- **T5 — testintent** + tests (removed expect-lines in existing files flag; additions pass; new files pass; injected git exec).
  **Files:** plugin/scripts/gates/testintent.mjs, tests/gates/testintent.test.mjs
- **T6 — skills**: `forge:plan` (template with machine-parseable sections), `forge:execute` (scoper → test-architect → implementer → reviewer loop, fix waves, ledger + resume, per-task gates), `forge:ship` update (mechanical gate invocations replace the degraded notes).
  **Files:** plugin/skills/plan/SKILL.md, plugin/skills/execute/SKILL.md, plugin/skills/ship/SKILL.md
- **T7 — ship**: PR, trail, ritual; gates dogfooded on this very branch where applicable (plandrift vs this plan's own Files lists).
  **Files:** docs/

## Out of scope

Graph-powered scoper (SP8 — import-scan/manual until then) · e2e infra (skill text covers `features.e2e` placement; no Playwright in the forge repo itself) · parallel ticket execution (backlog).
