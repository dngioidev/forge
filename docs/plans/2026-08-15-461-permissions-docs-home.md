# Plan: #461 - the permission model has no Claude-facing home

**Ticket:** #461 (board #8, parent #182) - **Kind:** docs (p1)
**Base:** main - **Branch:** docs/461-permissions-handbook-home

`docs/guides/install.md:150-181` (#432) and `docs/guides/cross-gai.md:331-472`
(#429) already document the permission model honestly - a tripwire denylist,
per-host `ask`/`allow` defaults, agy's fail-open timeout, agy-only argument
guards. Nothing routes a reader to them: `handbook.md` (billed as the daily-use
reference) has zero agy mentions, `README.md:21` still calls Claude Code the
"required host" while `:3`/`:44-55` say otherwise, `README.md:46-47` lists "the
safety denylist" with no qualifier, and `troubleshooting.md` §4 is Claude-PATH
only with no agy fail-open entry.

This repo is public. Per the ticket's own triage trail: document the guard's
**contract and limits** (tripwire-not-boundary, fails open, agy-only argument
guards, `git push`'s zero-Claude-side-fallback gap) - never publish a live,
unfixed bypass reproduction (#448, #459 round 4 stay unnamed at the payload
level). `install.md` and `cross-gai.md` are out of scope for edits (already
current/honest) - this ticket only adds routing to them plus the one net-new
handbook section.

## AC map

- **AC-461.1** `handbook.md` gains a short "Permissions & safety" section:
  tripwire-not-a-security-boundary framing, the per-host default (`ask` on agy
  since #429, per-action Claude prompt), the agy fail-open timeout, and links
  to `install.md`'s pre-authorization section + `cross-gai.md`'s permissions
  section. Explicit per-host branches (the #430 host-neutral pattern), not a
  Claude-shaped default with an agy footnote.
- **AC-461.2** `README.md:21` no longer states Claude Code is required; the
  Quickstart gets an explicit agy branch/pointer to `install.md`'s agy path.
- **AC-461.3** `README.md`'s denylist mention carries the tripwire qualifier
  (or points at where the honest framing lives) - must not read as a security
  guarantee.
- **AC-461.4** `troubleshooting.md`'s hooks section covers the agy shims and
  the host-level timeout fail-open, with the "it stopped prompting me" symptom
  findable.
- **AC-461.5** Doc-assertion tests pin AC.1-AC.4 (`tests/docs/` pattern,
  `allowlist-discoverability.test.mjs` precedent).

## Task 1 (test): failing doc-assertion tests for AC.1-AC.4 (AC-461.5)

New `tests/docs/permissions-handbook-home.test.mjs`. Each assertion fails
against the pre-edit files, proving the gap the ticket describes:

- `handbook.md` contains a "Permissions & safety" heading; mentions "agy" (the
  file currently has zero occurrences); states the tripwire framing (not a
  security boundary); names the agy `ask` default and Claude's per-action
  prompt with explicit `**Claude Code:**`/`**Antigravity (agy):**` branches;
  mentions the fail-open timeout; links to `install.md` and `cross-gai.md`.
- `README.md` does NOT contain "required host for the plugin"; contains an
  agy-specific pointer/branch in the Quickstart (anchor to
  `install.md#antigravity-agy` or equivalent).
- `README.md` does NOT contain the bare phrase "the safety denylist"
  unqualified; the denylist mention carries "tripwire" or a pointer to the
  qualified framing.
- `troubleshooting.md` mentions `agy-deny.mjs` (or agy hooks generally), the
  host-level `timeout` fail-open, and the phrase "stopped prompting" (the
  findable symptom).

**Files:** tests/docs/permissions-handbook-home.test.mjs

## Task 2 (docs): handbook "Permissions & safety" section (AC-461.1)

Add a `### Permissions & safety` subsection to `docs/guides/handbook.md`
section 4 ("Your interaction points"), replacing the single existing
permission-layer bullet with a pointer to it. Content, re-verified against
current source before writing (per the ticket's accuracy discipline):
tripwire-not-boundary framing quoting `denylist.mjs`'s own header intent
(never a security guarantee); explicit Claude Code vs. Antigravity (agy)
branches for the default (`ask` on agy since #429 vs. Claude's per-action
prompt, and the prefix-glob-can't-narrow-arguments limit); the agy fail-open
timeout (non-deterministic ~10-15s, not a clean boundary, per the #436 spike);
the `git push` zero-Claude-side-fallback gap (pre-approved via
`ALLOWED_COMMAND_PREFIXES` and this repo's own unrestricted
`Bash(git push:*)`, so a missed denylist spelling gets no block and no prompt
on Claude, while agy's argument guard still asks about most unrecognised
forms); links to `install.md`'s pre-authorization section and `cross-gai.md`'s
permissions section for the full mechanics/table. No bypass payloads named.

**Files:** docs/guides/handbook.md

## Task 3 (docs): README host/denylist fixes (AC-461.2, AC-461.3)

`README.md`:
- Prerequisites table (`:21`): stop calling Claude Code the required host;
  state that either Claude Code or Antigravity works.
- Install block (`:26-34`): add an explicit Antigravity (agy) branch pointing
  at `install.md#antigravity-agy`'s three-step path, alongside the existing
  Claude Code slash-command block.
- Denylist mention (`:46-47`): qualify "the safety denylist" with the
  tripwire-not-boundary framing (or point at the handbook's new Permissions &
  safety section) so it no longer reads as an unqualified safety claim.

**Files:** README.md

## Task 4 (docs): troubleshooting agy hooks entry (AC-461.4)

`docs/guides/troubleshooting.md` §4: add a subsection covering agy's
`agy-deny.mjs`/`agy-capture.mjs` shims, the "it stopped prompting me" symptom,
and the host-level `timeout: 10` (seconds) fail-open with its actual
non-deterministic ~10-15s behaviour (per the #436 spike) - distinct from the
existing Claude-PATH-missing entry, not a replacement for it.

**Files:** docs/guides/troubleshooting.md

## Task 5 (test): verify tests now pass + route index (AC-461.5)

Confirm Task 1's tests pass against Tasks 2-4's edits. Add this plan to the
docs route index.

**Files:** tests/docs/permissions-handbook-home.test.mjs, docs/README.md
