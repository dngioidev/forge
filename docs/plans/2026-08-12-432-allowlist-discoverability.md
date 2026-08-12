# Plan: #432 - allowlist discoverability + AC.1/AC.2 verification

**Ticket:** #432 (board #8, parent #182) - **Kind:** doc/chore - **Base:** main -
**Branch:** docs/432-allowlist-discoverability

## Ground truth first: most of this ticket already shipped incidentally

#429 (PR #439, merged before this branch was cut) widened `ALLOW` and
single-sourced it. Re-verified directly against fresh `main`, not trusted from
the ticket's coordination note:

- **AC.1 — satisfied.** `node plugin/scripts/autopilot/perms.mjs` on `main`
  prints 22 entries (`allowed-commands.mjs:25-55`), including every command
  this ticket asked for: `pnpm verify`, `gh pr diff`, `gh pr list`,
  `git fetch`, and the read-only `git status` / `git diff` / `git log` /
  `git rev-parse`. Evidence: `tests/autopilot/engine.test.mjs`'s "autopilot
  permissions helper" describe block, extended in this PR (AC-432.1) to assert
  every one of AC.1's named commands is present in the imported `ALLOW`,
  rather than re-typing the list into a new fixture.
- **AC.2 — satisfied, stronger than asked.** `perms.mjs:19` builds `ALLOW` as
  a pure `.map()` over `allowed-commands.mjs`'s `ALLOWED_COMMAND_PREFIXES`,
  the same list `plugin/hooks/agy-deny.mjs` consumes — one source, two hosts,
  no fork possible. `grep -rn "perms.mjs|allowlist|pre-authoriz"
  docs/guides/install.md` on `main` returns zero hits, and no doc anywhere
  copies the 22-entry array verbatim (confirmed by grep across `docs/` and
  `plugin/skills/`). Evidence: AC-432.2 assertion added to the same describe
  block, checking `ALLOW` is structurally derived from
  `ALLOWED_COMMAND_PREFIXES` (`Bash(<prefix>:*)` for every prefix, nothing
  else) rather than an independently-maintained array.
- **AC.4 — satisfied.** `perms.mjs:6-7`'s own header states it only prints;
  reading the source confirms the only side effect gated behind `isMain` is
  `console.log`, and `permsBlock()` is a pure function with no `fs` import in
  the module at all. AC-432.4 makes this a machine-checked invariant: spawn
  the CLI in a fresh tmpdir and assert no file appears on disk.
- **AC.5 — satisfied, no change needed.** `plugin/skills/autopilot/SKILL.md`
  (`§ Permissions`, `§ Merge-authorization preflight`, `§ Auto-merge item 0`)
  already states the "necessary but not sufficient" caveat in stronger terms
  than the ticket's own wording — it names the harness auto-mode classifier
  explicitly, states what does *not* count as authorization, and (line ~259)
  already documents the exact live failure mode this delivery session
  independently reproduced (`autopilot_merge` denied per-attempt inside a
  subagent, #397/#398). No numeric claims ("14 entries" etc.) appear anywhere
  that #429 would have made stale. AC-432.5 pins the caveat's presence and
  specific load-bearing phrases so a future edit can't silently soften it.

## What actually remains: AC.3

`docs/guides/install.md` has no allowlist section. #441 (merged today)
restructured the doc around per-host `### Claude Code` / `### Antigravity
(agy)` subsections and a numbered top-level flow (0 Prerequisites … 6
Migrating); #440 established host-neutral prose with explicit branches as the
pattern for anything host-specific. This plan adds a new top-level section
following that shape, between the existing "5. Working in it" and "6.
Migrating from superpowers" (renumbering the latter to 7 — nothing else in the
repo references these section numbers or anchors, confirmed by grep).

## The `git add` decision (coordination note from #429's delivery)

Walking the delivery loop, 18 of 19 steps auto-approve; `git add -A` is the
one guaranteed prompt, absent from both hosts' command sets. Pre-existing
parity, not a regression, but AC.1-shaped. **Decision: leave it out of the
shared allowlist for now**, not add it:

- `ALLOWED_COMMAND_PREFIXES`'s own "argument-sensitive" tier
  (`allowed-commands.mjs:90-134`) exists because a verb's *arguments* can be
  the actual hazard, and `git add` is not exempt: `-p`/`--patch`,
  `-i`/`--interactive`, and `-e`/`--edit` open interactive/editor flows an
  unattended session must not silently enter — the same class of hazard that
  already earned `git rebase` its `-i` exclusion. Giving `git add` a correct
  positive-argument guard is real threat-modeling work, not a one-line add,
  and #429's own history (three missed force-push spellings across
  successive review rounds, `git rebase -x`/`git fetch --upload-pack=` found
  in later rounds) is direct evidence that this class of change needs
  dedicated adversarial review, not a rider on a P2 docs-discoverability
  ticket.
- It is a **staging**, not an outward, command — nothing leaves the local
  index — so unlike `pnpm verify`/`gh pr diff`/`git fetch` it was never named
  in AC.1's list; AC.1's own scoping note explicitly narrows the bar to
  "outward" commands agents type.
- Leaving it unresolved costs one approval prompt per ticket (or one
  "always allow" click), not a stall — it does not block autopilot's
  continuous loop the way an unauthorized `gh pr merge` would.
- Filed as a follow-up, child of #182, linked to #432: "consider adding
  `git add` (with a correct argument-safety guard) to the shared allowlist."

## AC map

- **AC-432.1** `ALLOW` contains every command AC.1 named. Test asserts against
  the imported `ALLOW`, not a re-typed fixture.
- **AC-432.2** `ALLOW` is structurally a pure map over
  `ALLOWED_COMMAND_PREFIXES` (single-sourcing holds).
- **AC-432.3** `docs/guides/install.md` gains a pre-authorization section:
  points at `perms.mjs`, states plainly it grants unattended push/merge
  authority, states it is opt-in, follows the host-neutral Claude/agy branch
  pattern.
- **AC-432.4** `perms.mjs` prints, never writes — machine-checked via a real
  subprocess run in a tmpdir.
- **AC-432.5** The "necessary but not sufficient" caveat's load-bearing
  phrases remain present in `SKILL.md`.

## Task 1 (docs): install.md pre-authorization section (AC-432.3)

New top-level section, host-neutral prose with explicit Claude Code / agy
branches (matching #440's pattern), placed after "5. Working in it":
points at `perms.mjs` for Claude, the PreToolUse hook for agy, states the
unattended push/merge grant plainly, states opt-in, and cross-links
`cross-gai.md`'s permissions section and the autopilot SKILL's
merge-authorization caveat rather than restating either. "6. Migrating from
superpowers" renumbers to "7."

**Files:** docs/guides/install.md

## Task 2 (test): AC.1/AC.2 verification, reusing the existing import (AC-432.1, AC-432.2)

Add a new describe block to `tests/autopilot/engine.test.mjs`, alongside the
existing "autopilot permissions helper" one, reusing its `ALLOW`/`permsBlock`
import plus a new `ALLOWED_COMMAND_PREFIXES` import for the AC.1 command list
and the AC.2 structural-derivation assertion. No new fixture, no re-typed
copy of the list — per the ticket's explicit instruction.

**Files:** tests/autopilot/engine.test.mjs

## Task 3 (test): AC.4 prints-never-writes, machine-checked (AC-432.4)

New assertion (same file or a new one) spawning `perms.mjs` as a real
subprocess in a fresh tmpdir cwd and asserting no file is created.

**Files:** tests/autopilot/engine.test.mjs

## Task 4 (test): AC.3 + AC.5 doc-content assertions

New `tests/docs/allowlist-discoverability.test.mjs`, mirroring the
`agy-install-docs.test.mjs` / `agy-ask-default.test.mjs` pattern: asserts
install.md's new section exists and says the required things (AC-432.3), and
that SKILL.md's caveat phrases are still present (AC-432.5).

**Files:** tests/docs/allowlist-discoverability.test.mjs

## Task 5 (board): file the `git add` follow-up

Child of #182, linked to #432, carrying the reasoning above. Board item only.

**Files:** (none)

## Task 6 (docs): route index entry (docsync gate)

**Files:** docs/README.md

## Non-goals

- Re-implementing AC.1/AC.2/AC.4 (already shipped by #429).
- Adding `git add` to the shared allowlist (see decision above; follow-up
  filed instead).
- Rewording SKILL.md's AC.5 caveat (already accurate and prominent; adding a
  pinning test instead of editing prose that isn't wrong).

## Test plan

`npx vitest run tests/autopilot/engine.test.mjs
tests/docs/allowlist-discoverability.test.mjs`, then full `pnpm verify`
before shipping.
