# ADR-0004 — Remove the multi-backend (CLI role-swap) plane

**Date:** 2026-07-19 · **Status:** accepted · **Ticket:** #99 · **Related:** ADR-0003

## Context

Spec §5 describes a backend-neutral role system: role cards compile to Claude-native subagents, but "swappable" search roles (`investigator`, `librarian`, `second-opinion`) can be routed to a cheaper non-Claude CLI (agy/Gemini, or a future codex adapter) via a per-repo **roster**. The machinery for this was built and tested: `runrole.mjs` (resolve → run → extract), `loader.mjs` (roster + pin enforcement), `agy.mjs` (the one shipped adapter), `presend.mjs` (anti-secret-leak scan), `report.mjs` (structured-report contract + cite-or-drop), and `sync.mjs` (GEMINI.md/AGENTS.md managed blocks + ignore files). `init` offers the roster; `backends-sync` renders the CLI context files.

An orchestration review found this plane **never executes**. The evidence:

- `resolveBackend` has exactly one caller, `runRole`; `runRole` has **no importer and no CLI entrypoint** — it is exercised only by its own unit tests.
- No skill and no command routes through it. `review`, `ship`, and `execute` instruct the main loop to spawn a **Claude subagent directly** from `plugin/agents/*.md`; they never consult the roster.
- Therefore the **roster is never read to make a runtime decision.** `DEFAULTS` (e.g. `second-opinion → codex:gpt-5`), the `SWAPPABLE` allowlist, and the agy adapter are inert. A `second-opinion` spawn runs on Claude regardless of the roster.
- Two docs describe behavior that never fires: `init.md` offers a CLI-backend choice that only writes a GEMINI.md block and otherwise changes nothing; `respond/SKILL.md` claims security-response "disables CLI backends (`runRole` falls back to Claude)" — there are no live CLI backends to disable.

This is the same build-ahead-of-need pattern removed in ADR-0003 (control/console): a well-engineered subsystem with no consumer, carrying test-suite time, maintenance, and — worse than control/console — **misleading guarantees** in the skill/command docs.

## Decision

Remove the multi-backend plane and its tendrils. **Plane A — the live Claude-native path (cards → `compile.mjs` → `agents/*.md` → subagent spawn) — is unaffected and stays.**

- Delete `plugin/scripts/backends/{runrole,loader,agy,presend,report,sync}.mjs` and their tests (`tests/backends/{runrole,loader,presend,report,sync}.test.mjs`).
- **Keep** `compile.mjs`, `cards/`, `agents/`, and `tests/backends/cards.test.mjs` — Plane A depends on them. Rehome the `ROLES` constant (today exported from `loader.mjs`, imported by `cards.test.mjs` and `compile`-adjacent code) into `compile.mjs` or a small shared module.
- Strip the roster from `init.mjs` (`scaffoldRoster`, `--roster`, the roster write, the `loader`/`agy` imports) and remove step 3 (the CLI-backend offer) + `--roster` from `init.md`.
- Remove the `backends-sync` command + skill and the shell-context template used only by `sync.renderBlock` (`templates/shell-windows.md`), after confirming no other consumer.
- Fix the two misleading docs: drop the "disables CLI backends / `runRole` falls back" clause from `respond/SKILL.md`; the security-response freeze on ship/release/CLI stays described only for mechanisms that exist.
- Update spec §5 to describe the Claude-native role system only, with a note that multi-backend routing was removed here.

## Consequences

- The pipeline plugin — skills, the compiled agent roster, board automation, gates, care flows, learning loop, graph, deploy, release — is **unaffected**. The suite drops the five backend test files; `cards.test.mjs` stays green.
- The docs stop promising routing that never happened — the sharpest reason for this removal over merely leaving dead scripts in place.
- **No user-facing capability is lost**: every role already runs on Claude today; removing the inert roster changes nothing observable.
- **Recovery:** the full plane is preserved in git history and the `v0.5.0` tag. If an unattended or cost-sensitive multi-repo workflow ever wants cheap CLI search roles, re-introduce by wiring `runRole` into `review`/`ship` for `SWAPPABLE` roles — the missing piece was always the caller, not the machinery.
