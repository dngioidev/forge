# SP6 — Ideate + brainstorm + spike + design — Implementation Plan

**Epic:** #8 · **Spec:** [platform design v3.7](../specs/2026-07-15-forge-platform-design.md) §4 items 1/3/11/12, §7
**Branch:** `feat/8-front-of-pipeline` · **Verify:** `pnpm verify` · **Date:** 2026-07-17

## Acceptance criteria

- **AC-6.1** — `forge:ideate` skill: feature area → decomposed epic + child tickets via `create.mjs` (parent links, AC/type/size/priority), grounded in `docs/product/` when present, dedup-first.
- **AC-6.2** — `forge:brainstorm` skill: ticketed feature → spec in `conventions.specsDir`, decomposition-first rule, self-review checklist, **approval via the decision-comment mechanism** (`escalate.mjs` — a spec approval is a scheduled decision, spec §7); execution starts only from a resolved answer.
- **AC-6.3** — `forge:spike` skill: `spike/<n>-<slug>` branch that never merges (ship refuses spike branches — lint line added), findings → numbered ADR in `docs/decisions/` + route index.
- **AC-6.4** — `forge:design` skill (NEW mode only until SP8): designer role variants → human pick via decision comment → visual spec in `docs/design/` from the template.
- **AC-6.5** — Visual-spec template (`plugin/templates/visual-spec.md`) + `speclint.mjs`: validates a design doc carries every mandatory section (states matrix, breakpoints, themes, a11y contract, motion, token delta) — complete spec passes, missing sections named.
- **AC-6.6** — Suite green win+linux CI.

## Tasks

- **T1 — visual-spec template + speclint** + tests.
  **Files:** plugin/templates/visual-spec.md, plugin/scripts/design/speclint.mjs, tests/design/speclint.test.mjs
- **T2 — forge:ideate skill.**
  **Files:** plugin/skills/ideate/SKILL.md
- **T3 — forge:brainstorm skill** (approval gate wired to escalate.mjs).
  **Files:** plugin/skills/brainstorm/SKILL.md
- **T4 — forge:spike skill** + ship lint line (spike branches never PR).
  **Files:** plugin/skills/spike/SKILL.md, plugin/skills/ship/SKILL.md
- **T5 — forge:design skill** (NEW mode; template + speclint wired; token governance).
  **Files:** plugin/skills/design/SKILL.md
- **T6 — ship.**
  **Files:** docs/

## Out of scope

Design iterate/system modes + graph ripple (SP8) · Figma source mode (backlog) · superpowers uninstall from cms (owner action from the cms checkout, after this merges — spec §12).
