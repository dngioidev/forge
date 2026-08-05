# Plan: #389 - forge:init seeds a baseline docs/ structure + documents the route-index convention as a rule

**Ticket:** #389 (parent #182, plugin platform maintenance) - **Kind:** chore
**Base:** main - **Branch:** feat/389-scaffold-docs-structure

`forge:init`'s fresh-scaffold path creates zero code/docs directories — only board/config/CI
— even though `conventions.specsDir`/`plansDir` are written as config values. Separately,
this repo's own `docs/README.md` route-index convention (Specs/Plans/Spikes/Design
specs/Decisions/Guides, enforced by `docsync.mjs` when present) is not shipped as a
template, not seeded by init, and not documented as a rule for consumer projects.
`docsync.mjs` gracefully skips when `docs/README.md` is absent — so a brand-new scaffold
gets no structure and no enforcement pushing toward one.

## AC map

- **AC-389.1** a fresh `forge:init` (empty repo, no existing `docs/`) ends up with
  `docs/{specs,plans,spikes,design,decisions,guides}/` + `docs/README.md` route index. An
  **adopt** on a repo with an existing `docs/` (any layout) is left completely untouched —
  no clobbering, ever, even in the edge case where `docs/` predates `forge.json` in an
  otherwise-fresh repo.
- **AC-389.2** the convention is documented as a real, named rule a consumer can read
  (`docs/guides/install.md`), not just inferred from forge's own repo.
- **AC-389.3** `docsync.mjs` behavior is unchanged — this ticket seeds structure, it
  doesn't touch the gate.
- **AC-389.4** test coverage for both the fresh-scaffold-seeds-structure path and the
  adopt-doesn't-clobber path, mirroring the existing fresh-vs-adopt test patterns in
  `tests/init.test.mjs`.

## Task 1 (item): ship the docs/README.md template (AC-389.1)

New template file mirroring this repo's own route-index format: the header line ("One
line per doc. Update this file whenever a doc lands, moves, or renames") and the six
section headers (Specs/Plans/Spikes/Design specs/Decisions/Guides), with a `{{PROJECT}}`
title placeholder substituted the same way `verify.yml` substitutes `{{VERIFY}}`.

**Files:** plugin/templates/docs-readme.md

## Task 2 (item): seed docs/ from forge:init, fresh-only, no-clobber (AC-389.1, AC-389.3)

New step in `runInit` (after the CI-template step, before status line): in fresh mode
only (`!adopt`) and only when `docs/` is not already present on disk, create
`docs/{specs,plans,spikes,design,decisions,guides}/` and write `docs/README.md` from the
template. Adopt mode never runs this check at all. `docsync.mjs` is untouched — no
changes to `plugin/scripts/gates/docsync.mjs`.

**Files:** plugin/scripts/init.mjs

## Task 3 (test): AC-mapped tests (AC-389.4)

Four new tests in `tests/init.test.mjs` (new `describe` block, `freshRoutes` hoisted to
module scope for reuse): fresh init seeds the six empty subdirs + route-index content
(AC.1); fresh init leaves a pre-existing `docs/` (predating `forge.json`) untouched
(AC.1 edge case); adopt mode never creates `docs/` at all; adopt mode on a repo with its
own existing `docs/` layout leaves it byte-for-byte untouched (AC.1).

**Files:** tests/init.test.mjs

## Task 4 (doc): document the convention as a named rule (AC-389.2)

New "Docs structure — the route-index convention" section in the install guide: what
`forge:init` seeds and when, the adopt/pre-existing no-clobber guarantee, one line per
folder (specs/plans/spikes/design/decisions/guides), and the route-index / `docsync`
relationship.

**Files:** docs/guides/install.md

## Verification

`pnpm verify` (vitest run, full suite). Gates: plandrift clean (this plan's **Files:**
lists cover every touched file), testintent clean (only new assertions added, nothing
weakened), depguard clean (no new dependencies), docsync clean (docs/guides/install.md
is already indexed in docs/README.md; no new docs/ file added by this change — the new
template lives under plugin/templates/, outside docs/).
