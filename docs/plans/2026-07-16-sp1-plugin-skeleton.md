# SP1 — Plugin skeleton — Implementation Plan

**Epic:** #1 · **Spec:** [platform design v3.6](../specs/2026-07-15-forge-platform-design.md) §2 §3 §6 §7
**Branch:** `feat/1-plugin-skeleton` · **Verify:** `pnpm verify` · **Date:** 2026-07-16

## Acceptance criteria

- **AC-1.1** — Plugin installs from the marketplace: `/plugin marketplace add dngioidev/forge` + install exposes `/forge:init` and `/forge:doctor` in a consumer session.
- **AC-1.2** — `/forge:init` on a fresh repo bootstraps end-to-end (project + fields per spike outcome, delivery-log issue, `forge.json`, `.gitignore` entry, statusline offer) and a re-run changes nothing (idempotent).
- **AC-1.3** — `/forge:init` in adopt mode on the forge repo itself discovers board #8 and produces a `forge.json` board block identical to the committed one.
- **AC-1.4** — `/forge:doctor` individually detects: missing gh auth / missing `project` scope, Node < 22.13, missing/invalid `forge.json`, dangling project/field/option IDs, missing `.forge/` gitignore entry — each with a distinct actionable message and nonzero exit on ✗.
- **AC-1.5** — Status line renders `forge #<ticket> <branch>` derived from the branch naming convention; `forge init` wires it into `.claude/settings.json` without clobbering existing keys.
- **AC-1.6** — `pnpm verify` (vitest) green in CI on both `windows-latest` and `ubuntu-latest`.

## Tasks

### T1 — Repo scaffolding
**Files:** `package.json`, `vitest.config.mjs`, `.gitignore`, `.github/workflows/verify.yml`
- `package.json`: `"engines": { "node": ">=22.13" }`, `packageManager` pnpm, scripts: `verify` = `vitest run`, zero runtime dependencies (vitest dev-only).
- CI: verify job on `windows-latest` + `ubuntu-latest` matrix (Windows-first law, spec §13), actionlint job, all actions SHA-pinned, concurrency cancel.
- `.gitignore`: `node_modules/`, `.forge/`.
**Test plan:** CI runs on the PR itself (AC-1.6).
**Done:** verify green both OSes.

### T2 — Plugin manifests
**Files:** `.claude-plugin/marketplace.json`, `plugin/.claude-plugin/plugin.json`, `docs/README.md` (route index line)
- marketplace.json: one marketplace, one plugin `forge`, source `./plugin`.
- plugin.json: name/description/version `0.1.0`.
**Test plan:** structural — vitest asserts both manifests parse and required keys exist (guards typo-level breakage; real install check is AC-1.1 at ship).
**Done:** AC-1.1 validated manually in a scratch session at ship time.

### T3 — Shared lib
**Files:** `plugin/scripts/lib/exec.mjs`, `lib/config.mjs`, `lib/ticket.mjs`, `lib/jsonfile.mjs` + `tests/lib/*.test.mjs`
- `exec.mjs`: Windows-safe spawn (no shell, argv arrays — spec §13 anti-injection; handles `.exe` resolution; the `.cmd` EINVAL lesson gets a regression test with a mocked spawn).
- `config.mjs`: load + validate `.claude/forge.json` — hand-rolled structural validation (required keys, ID shapes `PVT_*`/`PVTSSF_*`, option maps), no dependencies. Returns typed errors doctor can print.
- `ticket.mjs`: branch → ticket parser for `<type>/<issue#>-<slug>` (+ `--<role>` suffix, `spike/`, `hotfix/` types per spec §2).
- `jsonfile.mjs`: read-merge-write for settings files (used by statusline wiring) — never clobbers unknown keys, preserves key order where possible.
**Test plan:** unit tests per module; Windows path/CRLF cases explicitly (AC-1.4 foundations, AC-1.5 parser).
**Done:** all lib tests green.

### T4 — Spike: ProjectsV2 built-in Status options (timeboxed ½ day)
**Files:** `docs/decisions/0001-status-field-options.md` (ADR)
- On a scratch project: attempt `updateProjectV2Field` (and any current mutation) to add options to the built-in Status single-select; document exact GraphQL + result.
- Outcome A (mutable): init creates the 6-status standard set on fresh projects. Outcome B (immutable): init documents the one-time manual step and maps-what-exists (spec §6 fallback).
- ADR records finding + chosen init behavior; T5 implements accordingly.
**Done:** ADR merged; init behavior decided, route index updated.

### T5 — `/forge:init`
**Files:** `plugin/commands/init.md`, `plugin/scripts/init.mjs` + tests (gh mocked via injected exec)
Flow (every step detect-before-create — idempotency law, spec §6):
1. Preflight: gh present + authed + `project` scope, Node ≥22.13, inside git repo.
2. Mode: existing `.claude/forge.json` → adopt/refresh; else fresh.
3. Project: `--project <n>` flag or create (`--create "<title>"`); discover `projectId`.
4. Fields: discover status/priority/size/type; create missing custom fields; Status options per T4's ADR. Optional iteration/area discovered and mapped when present.
5. Delivery-log issue: find by title, create if missing.
6. Write `forge.json` (board + conventions + features + team skeleton: repo owner as sole `maintainer`).
7. `.gitignore`: append `.forge/` if absent.
8. Statusline: offer to merge `statusLine` into `.claude/settings.json` (T7).
9. Run doctor (T6); print summary.
**Test plan:** unit tests over each step with scripted gh responses — fresh, adopt, re-run (no-op), partial-failure resume (create succeeded, field-set failed → resume from field-set). AC-1.2, AC-1.3.
**Done:** AC-1.2 + AC-1.3 test-verified (mocked) + AC-1.3 exercised live against board #8.

### T6 — `/forge:doctor`
**Files:** `plugin/commands/doctor.md`, `plugin/scripts/doctor.mjs` + tests
- Checks (SP1 scope): gh auth + scopes · Node version · git repo · forge.json valid (T3 config) · project reachable + every field/option ID resolves · delivery-log issue open · `.forge/` gitignored · statusline wired (info-level) · branch protection + secret scanning (warn-level, API check).
- Output: aligned ✓/⚠/✗ table + one-line fix hint each; exit 0 (all ✓/⚠) or 1 (any ✗).
**Test plan:** one test per failure class with scripted gh responses (AC-1.4); one all-green integration shape.
**Done:** AC-1.4 test-verified; live run against forge repo is all ✓/⚠.

### T7 — Status line (minimal)
**Files:** `plugin/scripts/statusline.mjs` + tests
- Reads Claude Code statusline stdin JSON (cwd), resolves git branch, parses ticket via T3 `ticket.mjs`, prints `forge #<n> <branch>` (or `forge <branch>` when no ticket); fails silent-empty on any error (a status line must never break the session).
- Wiring lives in T5 step 8 via T3 `jsonfile.mjs` merge. Situation-aware upgrade is SP3 (spec §7) — out of scope here.
**Test plan:** parser cases (work branch, agent child `--role`, spike, env branch, detached head), settings merge no-clobber (AC-1.5).
**Done:** AC-1.5 test-verified + visible in this repo's session.

### T8 — Ship
- Branch `feat/1-plugin-skeleton`, conventional commits referencing #1, PR with commits→issue map + AC checklist, CI green (AC-1.6), owner merges.
- After merge: receipt comment on #1, board → Done, route-index line for the plan/ADR.
- **cms install (AC-1.1 dogfood) runs from the cms checkout, not this repo** (forge-scope rule); owner validates `/plugin marketplace add dngioidev/forge` there.

## Order & estimates

T1 → T2 → T3 → T4 (spike can run parallel to T2/T3) → T5 → T6 → T7 → T8. Size S overall: ~1 session of implementation + the spike timebox.

## Out of scope (lands later, per spec §12)

Consumer CI template + situation model (SP3) · backends sync (SP4) · deploy scaffold (SP4b) · board scripts beyond what init/doctor need internally (SP2 owns `forge:board`).
