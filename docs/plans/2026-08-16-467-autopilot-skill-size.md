# Plan: #467 - autopilot/SKILL.md is 49KB (~12k tokens) loaded at every invoke — 3x the next-largest skill

**Ticket:** #467 (board #8, child of epic #183) - **Kind:** chore/item
**Base:** main - **Branch:** fix/467-autopilot-skill-size - **Verify:** `pnpm verify`

`plugin/skills/autopilot/SKILL.md` is loaded in full, at every autopilot invoke,
before a single ticket is selected. The ticket cites 49,195 bytes at filing;
measured at the start of this delivery it had grown to **75,603 bytes**
(#517/#523 landed new mandatory-procedure content after the ticket was filed).
The ticket's own governing principle: move what is *looked up* (pure
reference — script signatures, deep mechanics), keep what is *obeyed*
(mandatory run-start procedure) inline, and evict pure historical rationale
to a pointer where the reasoning already lives elsewhere or can be relocated
without loss.

## Design

- **AC-1 first (gating).** Read `plugin/scripts/agy/emit.mjs`: `COMPONENT_DIRS`
  includes `'skills'`, and `emitAgyPlugin` does a full recursive `cp()` of
  each component dir — so a new `plugin/skills/autopilot/reference/*.md`
  subtree is bundled into the emitted agy package automatically, no
  SKILL.md-only filtering. `rewriteRuntimePathsInTree` also walks every `.md`
  file recursively, not just SKILL.md. **Confirmed: agy is not
  reference-blind.** AC-2 proceeds.
- **AC-2 — move lookup.** Two sections, per the ticket's own identification:
  - `## Driver scripts (the executable spine)` — pure API reference for
    `select.mjs`/`merge.mjs`/`preflight.mjs`/etc. Moved in full to
    `plugin/skills/autopilot/reference/driver-scripts.md`; SKILL.md keeps a
    short paragraph naming every script + a link.
  - The deep-mechanics half of `## Monitor notifications` (exact poll
    cadence, GH check-state enums, throttled-error wording, the untested
    `forge-outbox` lock/drain internals, the `forge-agents` threshold
    derivation + field evidence + "honest limit" narrative) — moved to
    `plugin/skills/autopilot/reference/monitor-notifications.md`. SKILL.md
    keeps, per monitor: the line it emits and what the loop does with it —
    everything `tests/skills/autopilot.test.mjs` pins as a literal substring
    (verified by running the suite, not guessed).
- **Do NOT move (ticket's own list, honoured as-is):** Merge-authorization
  preflight, Rate-budget preflight, Permissions, Environment preflight,
  Session-window self-pause, Return-then-resume watchdog. These are
  mandatory-procedure sections whose specificity is the load-bearing content
  the delivery brief for this very ticket calls out by name (the
  return-then-resume stall in particular). No AC-3 eviction was attempted
  inside them — cutting their rationale would be the reserved-for-owner
  "drop or weaken a safety rule" call the brief carves out, not a
  restructuring call.
- **AC-3 — evict rationale.** Bounded to the two AC-2 sections' own
  overflow (the untested `forge-outbox` paragraph, the `forge-agents`
  "Honest limit" paragraph): relocated to the reference docs verbatim
  (nothing deleted — a new regression test, AC-467.3, pins that the exact
  removed text is present in the reference file and absent from SKILL.md).
  No further rationale eviction elsewhere in the file — see the "Do NOT
  move" note above.
- **AC-4 — tests follow content.** `tests/skills/autopilot.test.mjs` needed
  zero edits: every one of its 24 pre-existing assertions was checked against
  the final SKILL.md content, one literal string mention (`perms.mjs` in the
  new Driver-scripts summary line) was found to fail `tests/agy/emit.test.mjs`
  AC-430.4's Claude-scoping proximity check and was fixed by annotating it
  inline (`perms.mjs` (Claude-only, § Permissions)`) rather than by weakening
  the test. A new file, `tests/skills/autopilot-size.test.mjs`, adds AC-467.*
  coverage: the agy-bundling premise (AC-467.1, a real `emitAgyPlugin` run),
  that every mandatory section stayed inline (AC-467.2), that relocated
  content is present verbatim in the reference docs and absent from SKILL.md
  (AC-467.3), a literal-substring regression smoke test mirroring the parts
  of the existing suite this edit touched (AC-467.4), and the measured size
  reduction (AC-467.5).
- **AC-5 — measured.** Before: 75,603 bytes. After: recorded in the PR body
  and the ticket-trail comment (see `tests/skills/autopilot-size.test.mjs`
  AC-467.5 for the regression-pinned ceiling). The ticket's own `≤25KB`
  target was computed against the smaller 49,195-byte baseline and assumed
  cutting well beyond the two identified-safe sections; honoring the "do NOT
  move" list means that target isn't reached without owner sign-off on
  cutting a safety rule, which is out of this delivery's authority per the
  brief's explicit reservation.

## Acceptance criteria (authoritative text is on the issue; summarised here)

- **AC-1** Confirm whether agy carries bundled skill reference files; record
  the finding on the ticket.
- **AC-2** Move `## Driver scripts` and Monitor-notifications rationale to
  `plugin/skills/autopilot/reference/*.md`, linked from SKILL.md.
- **AC-3** Historical rationale reduced to rule + pointer; verified present
  in the relocated destination, nothing deleted.
- **AC-4** Every `tests/skills/autopilot.test.mjs` assertion targets the file
  that actually holds the text.
- **AC-5** Before/after byte count recorded on the ticket.

## Task 1 (docs + tests): relocate the two lookup sections, add regression coverage

- Create `plugin/skills/autopilot/reference/driver-scripts.md` (full,
  unedited content of the former `## Driver scripts` section) and
  `plugin/skills/autopilot/reference/monitor-notifications.md` (the deep
  mechanics moved out of `## Monitor notifications`).
- Edit `plugin/skills/autopilot/SKILL.md`: replace `## Driver scripts` with a
  short pointer paragraph; condense `## Monitor notifications` to the
  operational rule per monitor, linking to the reference doc; fix the
  `perms.mjs` Claude-scoping proximity regression surfaced by
  `tests/agy/emit.test.mjs` AC-430.4.
- Add `tests/skills/autopilot-size.test.mjs` (AC-467.1..5).
- Run `tests/skills/autopilot.test.mjs` unmodified to confirm AC-4 (all 24
  pass with no edits).

**Files:** plugin/skills/autopilot/SKILL.md, plugin/skills/autopilot/reference/driver-scripts.md, plugin/skills/autopilot/reference/monitor-notifications.md, tests/skills/autopilot-size.test.mjs
**AC map:** AC-467.1, AC-467.2, AC-467.3, AC-467.4, AC-467.5
**Test plan:** `npx vitest run tests/skills/autopilot-size.test.mjs tests/skills/autopilot.test.mjs tests/agy/emit.test.mjs`

## Task 2 (docs): route index

- Add this plan to `docs/README.md`.

**Files:** docs/README.md
**AC map:** AC-467.5
**Done:** `node plugin/scripts/gates/docsync.mjs --base main` clean.
