# SP4 — Agent roster + backend adapters — Implementation Plan

**Epic:** #4 · **Spec:** [platform design v3.7](../specs/2026-07-15-forge-platform-design.md) §5 §13
**Branch:** `feat/4-roster-backends` · **Verify:** `pnpm verify` · **Date:** 2026-07-16

## Acceptance criteria

- **AC-4.1** — Eleven backend-neutral role cards in `plugin/cards/` (implementer, reviewer, security, design-reviewer, scoper, test-architect, devops, designer, investigator, librarian, second-opinion), each with mission / checklist / guardrails / output contract / honesty clause; `compile.mjs` renders them to `plugin/agents/<role>.md` native subagents (no model pin; read-only roles get read-only tools); a test fails when agents drift from cards.
- **AC-4.2** — Loader enforces the swap allowlist in code: pinned roles ignore non-Claude roster entries with a journaled warning; investigator/librarian/second-opinion swap freely; implementer swaps only when the current branch matches the agent child-branch pattern (`…--implementer`).
- **AC-4.3** — Adapter contract + fallback: the agy adapter renders card + conventions + task brief + report contract into one prompt with model-id→flag mapping; missing CLI / auth failure / timeout / malformed report → one retry (violation appended) then fallback backend, `backend-fallback` journaled; `optional: true` roles skip with a note.
- **AC-4.4** — Pre-send scan refuses any composed prompt containing secret-shaped content (pattern + entropy) before it reaches an external CLI.
- **AC-4.5** — `backends sync` writes managed blocks into `GEMINI.md`/`AGENTS.md` (content from forge.json + static shell template only; hand-written sections survive) and CLI ignore files (`.geminiignore`, `.codexignore`: env/keys/tfstate/`.forge/`); idempotent.
- **AC-4.6** — Report-contract parser: extracts the terminal JSON block, validates shape (`verdict`, `findings[]` with severity/file/line/summary), applies **cite-or-drop** (findings whose file doesn't exist are dropped with a journal note).
- **AC-4.7** — `forge:review` skill (standalone PR review over reviewer+security roles); suite green on win+linux CI.

## Tasks

- **T1 — role cards** (`plugin/cards/*.md`, 11 files): shared shape — mission, checklist, guardrails (incl. §13 honesty clause verbatim), output contract (report JSON). Content distilled from spec §5 table + §4 skill flows.
- **T2 — compile** (`scripts/backends/compile.mjs` + generated `plugin/agents/*.md` + test): frontmatter (name, description, tools — read-only set for reviewer/security/scoper/investigator/librarian/second-opinion), body = card; freshness test recompiles and diffs.
- **T3 — backend id + loader** (`scripts/backends/loader.mjs` + tests): `parseBackendId('agy:gemini-flash')`; `resolveBackend(role, roster, branchName)` → pins/allowlist/child-branch rule; warnings journaled (`backend-fallback` kind, reason `pin-ignored`).
- **T4 — report contract** (`scripts/backends/report.mjs` + tests): terminal-JSON-block extraction, shape validation, cite-or-drop against cwd.
- **T5 — pre-send scan** (`scripts/backends/presend.mjs` + tests): journal redaction patterns + Shannon-entropy check on long tokens; returns refuse+reason.
- **T6 — agy adapter + runner** (`scripts/backends/agy.mjs`, `scripts/backends/runrole.mjs` + tests): adapter = `{ id, defaultModel, models, buildArgs(model), available() }`; runner composes prompt (card + conventions + brief + contract), presend-scans, executes with timeout, parses report, retry-once-then-fallback, journals; optional-role skip.
- **T7 — backends sync** (`scripts/backends/sync.mjs`, `plugin/templates/shell-windows.md`, `/forge:backends-sync` command + tests): managed blocks via markers lib; ignore files; wired into init (replacing the SP1 stub note).
- **T8 — `forge:review` skill** (`plugin/skills/review/SKILL.md`): PR diff → reviewer + security passes → findings per report contract posted on the PR.
- **T9 — ship**: PR, trail, ritual.

## Out of scope

codex adapter (contract makes it a follow-up ticket when needed) · role-card consumer overrides testing beyond precedence note · scoper/test-architect gate wiring (SP5) · graph-backed librarian (SP8).
