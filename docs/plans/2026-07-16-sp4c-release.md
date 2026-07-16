# SP4c — Release management — Implementation Plan

**Epic:** #6 · **Spec:** [platform design v3.7](../specs/2026-07-15-forge-platform-design.md) §4 item 7, §2 git conventions, §13 release-readiness
**Branch:** `feat/6-release` · **Verify:** `pnpm verify` · **Date:** 2026-07-16

## Acceptance criteria

- **AC-4c.1** — Bump derivation from conventional commits since the last tag: fix→patch, feat→minor, `!`/`BREAKING CHANGE`→major, mixed takes the highest; no releasable commits → refuse; no prior tag → `v0.1.0`.
- **AC-4c.2** — CHANGELOG.md: new section prepended (version, date, changes grouped by type with `#ticket` links from squash titles); committed as `chore(release): vX.Y.Z`.
- **AC-4c.3** — Computed readiness checklist refuses on: not on main / dirty tree / behind remote / verify failing / open `critical` journal findings / empty delta. Feature-conditional items (staging smoke, visual baselines) skip with an explicit note when their feature is off; degraded items (AC-gate map — SP5) noted as such.
- **AC-4c.4** — Annotated tag `vX.Y.Z` + GitHub Release with the generated description shape: one-line summary · changes grouped by type with ticket links · deploy notes (infra changed y/n, migrations y/n) · promoted image digest (deploy repos). `--dry-run` previews everything without touching git/GitHub.
- **AC-4c.5** — Deploy repos: the staging-built image for the release SHA is retagged `vX.Y.Z` in the registry (release names, never builds — degraded note when no image exists); npm publish only for public packages (skipped for `private: true`).
- **AC-4c.6** — Suite green on win+linux CI.

## Tasks

- **T1 — pure core** (`plugin/scripts/release/core.mjs` + tests): `parseCommit(line)`, `deriveBump(commits)`, `groupChanges(commits)`, `renderChangelogSection(version, date, groups)`, `renderReleaseBody(...)` — all pure, exhaustively testable.
- **T2 — readiness** (`plugin/scripts/release/readiness.mjs` + tests): checklist items as `{name, level, msg}` like doctor; git state via injected exec; journal criticals via journal lib; feature-conditional skips from forge.json.
- **T3 — release runner** (`plugin/scripts/release/release.mjs` + tests): readiness → bump → changelog write+commit → annotated tag → push → `gh release create` → image retag (`docker buildx imagetools create` via gh-less path or registry API — v1: `gh api` manifest copy note + degraded fallback) → npm publish gate. `--dry-run` short-circuits all writes.
- **T4 — `forge:release` skill** (`plugin/skills/release/SKILL.md`): when to release, timing rule (deploy repos: after staging smoke), how to run, what to relay.
- **T5 — ship**: PR, trail, ritual.

## Out of scope

AC-gate verification inside readiness (SP5 wires the mechanical map) · flaky quarantine ages (no quarantine registry yet) · user-facing docs regeneration (forge:docs, backlog).
