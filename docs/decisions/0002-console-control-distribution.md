# ADR-0002 — The console + control plane ship as repo tooling, not in the plugin

**Date:** 2026-07-19 · **Status:** superseded by [ADR-0003](0003-remove-control-console.md) · **Ticket:** #91 (iomanage feedback)

## Context

forge is distributed as a Claude Code plugin: `.claude-plugin/marketplace.json` declares `source: ./plugin`, so **only `plugin/` is packaged** and delivered via `/plugin update`. The forge-control console and control plane live in top-level `console/` and `control/` directories — siblings of `plugin/` — so they are **not** in the installed plugin. A downstream user (iomanage) hit this: on the installed plugin they could not reach the console control at all.

Three options were weighed (#91):

1. **Move `console/` + `control/` under `plugin/`** so they ship. Makes the control plane a first-class plugin feature, at the cost of a broad import-path refactor (both dirs import `../../plugin/scripts/lib/*`; all their tests import `../../console|control/*`).
2. **Keep them as repo tooling; document the checkout path as intended.**
3. **Bootstrap helper** — a plugin command that clones/points at a forge checkout and launches the console.

## Decision

**Option 2.** The console + control plane are **repo-level operator tooling**, run from a forge checkout. This is deliberate, not a temporary gap:

- The control plane is **machine-global** — it watches *many* repos (via `~/.forge/daemon.json`) and spawns headless sessions on the host. That is an operator/orchestration tool for the machine, not an artifact scoped to one project's plugin install.
- Packaging it into a per-project plugin would put a session-spawning daemon into every consumer's `~/.claude/plugins/` cache, which is a larger surface than the feature warrants.
- The pipeline plugin (skills, agents, board automation, hooks, gates) is what belongs in `/plugin update`; the control plane is cloned and run.

## Consequences

- Plugin users reach the console control by cloning forge and running `node console/daemon.mjs serve` — documented in the console-control guide (both removed in ADR-0003).
- `console/`/`control/` keep their current layout and import paths; no refactor.
- **Revisit if:** the control plane is later deemed a first-class *plugin* feature (→ Option 1), or checkout friction proves painful in practice (→ Option 3, a bootstrap launcher — the checkout stays the source of truth either way).

Option 3 (a one-command bootstrap launcher) remains an open ergonomic follow-up, not a blocker.
