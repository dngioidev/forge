# Plan: #491 - autopilot readiness gate misclassifies shaped tickets as unshaped on heading/AC-id spelling

**Ticket:** #491 (board #8, child of epic #183) - **Kind:** bug
**Base:** main - **Branch:** fix/491-readiness-gate-heading-id-spelling - **Verify:** `pnpm verify`

`plugin/scripts/autopilot/readiness.mjs`'s `isShaped(body, config)` decides
whether a Backlog ticket carries acceptance criteria. It returns true on
either a heading matching `DEFAULT_AC_HEADINGS` (anchored `#{1,6} <heading>`
immediately after the hashes) or the id pattern `/\bAC-?\d+\b/`. Two ordinary
spellings already in use on this board defeat both tests at once:

- `## Suggested acceptance criteria` — the heading regex anchors the heading
  text immediately after the hashes, so a qualifier word ahead of it
  ("Suggested") breaks the match.
- `AC.1` — the id pattern accepts `AC-1`/`AC1` but not a dot separator.

Ground truth: #438's real, unedited body uses both spellings and still
classifies unshaped on `main`. Under the default mode (no `--shape`) that
means a fully-specified ticket gets escalate-and-skipped for a punctuation
reason. #452 is the regression tell: it classifies shaped today only because
it happens to cite `AC-446.6` from a different ticket — not because its own
"Suggested acceptance criteria" heading is recognised.

## Design

Two narrow, additive regex changes in `readiness.mjs`, no API/shape change:

- **Heading regex**: allow an optional single qualifier word
  (`\p{L}[\p{L}\p{N}'-]*\s+`, `{0,1}`) between the hashes and the heading
  term. The qualifier must be followed by whitespace before the heading term
  is tried, so it cannot itself absorb part of the heading term — the
  existing trailing `(?![\p{L}\p{N}_])` boundary check still runs
  immediately after the heading term, so a longer word sharing the same
  prefix ("Acceptances...") still fails regardless of how many (0 or 1)
  qualifier words precede it. This is a bounded, non-backtracking-prone
  widening (capped at one repetition), not an open-ended "any prose before
  the heading" grant — the AC-491.3 boundary at risk from over-widening.
- **Id regex**: `/\bAC-?\d+\b/` → `/\bAC[-.]?\d+\b/` — `-` or `.` as the
  AC/number separator, same word-boundary discipline either side.

Both changes are pure widenings of what already-passing false-positive
guards must survive (the pre-existing "Acceptances of the plan" test), so
the fix is additive rather than a redesign of the predicate.

## Acceptance criteria (authoritative text is on the issue; summarised here)

- **AC-491.1** — `isShaped()` recognises a qualified heading ("Suggested"
  prefix) and dot-separated ids (`AC.1`).
- **AC-491.2** — Pinned against the real corpus: the five false-negative
  bodies (#438 verbatim; #486/#487/#489/#490 reconstructed per the ticket's
  evidence table, since those four were hand-edited on the live board mid-run
  and are no longer live repros) classify shaped; the three true positives
  (#436, #447, #448) stay shaped; #452 is an explicit regression case shown
  shaped with the `AC-446` citation removed from its body.
- **AC-491.3** — No false positives: prose-only bodies, and near-miss words
  (including a qualifier word ahead of a near-miss word, "AC" as a bare
  non-numeric acronym, an unrelated numbered list) stay unshaped.
- **AC-491.4** — The accepted spellings are documented in `forge:triage` and
  `forge:shape` skill prose, where a ticket author/shaper meets them.
- **AC-491.5** — The routing outcome (`select.mjs` `actionFor`/`selectNext`)
  is asserted: a ticket shaped only via the widened spelling is never
  escalate-and-skipped under default (non `--shape`) autopilot, and is never
  routed to a wasted `shape` spawn under crazy mode either.

## Task 1 (test): regression tests first

Add a `#491`-titled describe block to `tests/autopilot/engine.test.mjs`
covering AC-491.1 (qualified heading + dotted id), AC-491.2 (the five
false-negative bodies, the three true positives, and the #452
regression-without-coincidence case), AC-491.3 (prose-only bodies and a set
of near-miss adversarial headings/tokens), and AC-491.5 (`selectNext`
outcome, not just `isShaped`). Written first against the pre-fix code so
AC-491.1/.2/.5 fail, confirming the regression they pin.

**Files:** tests/autopilot/engine.test.mjs
**AC map:** AC-491.1, AC-491.2, AC-491.3, AC-491.5
**Test plan:** see above; run `npx vitest run tests/autopilot/engine.test.mjs`.

## Task 2 (code): widen the heading and id regexes in readiness.mjs

- `headingRegex()`: insert `(?:\p{L}[\p{L}\p{N}'-]*\s+){0,1}` between the
  `#{1,6}\s*` anchor and the heading alternation.
- `isShaped()`: change the id test to `/\bAC[-.]?\d+\b/`.
- Update the file's header comment (it currently says "The `AC-\d+` id match
  is unchanged" — no longer true).

**Files:** plugin/scripts/autopilot/readiness.mjs
**AC map:** AC-491.1, AC-491.2, AC-491.3, AC-491.5
**Done:** Task 1's new tests pass; full `tests/autopilot/engine.test.mjs`
green (168/168: 161 pre-existing + 7 new).

## Task 3 (docs): accepted conventions where authors meet them

- `plugin/skills/triage/SKILL.md` step 4: note the heading/id spellings
  `isShaped()` recognises, and the `readiness.acHeadings` config hook for a
  fully custom/localized heading.
- `plugin/skills/shape/SKILL.md` step 4 ("clean" branch): same note, so a
  ticket `forge:shape` just promoted doesn't get misread as unshaped on its
  next readiness pass.
- `docs/README.md`: add this plan to the route index.

**Files:** plugin/skills/triage/SKILL.md, plugin/skills/shape/SKILL.md, docs/README.md
**AC map:** AC-491.4
**Done:** `forge:docsync-check` clean.
