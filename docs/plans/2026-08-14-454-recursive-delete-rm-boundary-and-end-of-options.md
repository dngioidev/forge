# Plan: #454 - recursive-delete locates rm by unanchored indexOf, so `TERM=xterm rm -rf dist` is wrongly blocked

**Ticket:** #454 (board #8, child of epic #182) - **Kind:** bug
**Base:** main - **Branch:** fix/454-recursive-delete-rm-boundary - **Verify:** `pnpm verify`

`plugin/hooks/denylist.mjs`'s `recursive-delete` rule has two independent
false-positive defects in the same `test()` function, both over-blocking
safe deletes (never under-blocking a dangerous one):

1. **AC.1** — the target-slice re-locates `rm` in the `spacedText` reading
   with `cSpaced.indexOf('rm')`, an unanchored substring search. Any earlier
   text merely *containing* the letters "rm" (`TERM=xterm`, `X=affirm`) moves
   the slice point before the real `rm` token, so the rule judges the wrong
   span and wrongly blocks an ordinary env-prefixed command.
2. **AC.5 (absorbs #456)** — `shortFlagCluster()` and the `--recursive`/
   `--force` regexes scan the WHOLE segment for flag-shaped tokens, ignoring
   POSIX `--` end-of-options. `rm -- -rf target` and
   `rm -- --recursive --force target` place real *filenames* (not flags)
   after a bare `--`, but the rule reads them as flags anyway and
   over-blocks a non-recursive, non-forceful delete.

Landed together because both live in the same `test()` function on adjacent
lines — separate branches patching overlapping lines would conflict.

## Design

- **AC.1 fix:** replace `cSpaced.indexOf('rm')` with a command-token-boundary
  search, `/\brm\b/.exec(cSpaced)`, falling back to index 0 if (defensively)
  no boundary-anchored match is found. `\brm\b` requires "rm" to sit between
  non-word characters (or string start/end) on both sides — "xterm"/"affirm"
  never satisfy that (the "rm" there directly abuts a word character), while
  a real standalone `rm` token always does. `c`'s own pre-existing `\brm\b`
  guard already establishes a boundary-anchored "rm" exists in the sibling
  `text` reading, so the fallback is unreachable in practice.
- **AC.5 fix:** new helper `beforeEndOfOptions(command)` — bash-IFS token
  split (space/tab/newline, matching `safeRmTarget()`'s own `--` handling),
  returns everything before a bare `--` token, unchanged if there is none.
  Flag detection (`shortFlagCluster()`, the `--recursive`/`--force` regexes)
  now runs against `beforeEndOfOptions(c)` instead of the full `c`. Target
  parsing (`safeRmTarget(rest)`) is untouched — its own `--` handling (#450)
  already covers the target half.

Both fixes only touch `recursive-delete`; no other rule is modified.

## Fix wave: full-branch adversarial reviewer finding, closed

The first version of `beforeEndOfOptions()` did a flat whitespace-token
scan of the whole segment for a bare `--`, with no awareness that the
segment can contain a command substitution (`$(...)` or backticks) whose
OWN `--` belongs entirely to the inner command, never to the outer `rm`.
`forge:reviewer`, run adversarially on the full branch diff, found this was
a live under-blocking bypass, not a cosmetic gap: `rm $(cat -- flagfile)
-rf /important-template-configs` truncated flag detection right after the
inner `--`, before the real `-rf`, so a genuinely dangerous `rm -rf` on an
#446-pinned-unsafe target came back `blocked: false` — verified against
both the flat-scan version (wrongly allowed) and `main` pre-#454 (correctly
blocked). Closed by rewriting `beforeEndOfOptions()` to track `$(...)`/
backtick nesting depth and only recognise `--` as the end-of-options marker
at depth 0 — the same substitution forms `eval-exec`'s own `SUBSTITUTION`
regex already treats as one unit. Ambiguity (e.g. an unterminated `$(`)
resolves toward continuing to scan for flags, never toward hiding one — the
safe direction for a hook that fails open. Regression-pinned as
`AC-454.5: a -- embedded inside $(...) or backticks is not read as
top-level end-of-options` plus a paired "genuine top-level -- after a closed
substitution still works" case, both in
`tests/hooks/denylist.test.mjs`.

## AC map

- **AC-454.1** `rm` slice point found on a command-token boundary.
  `TERM=xterm rm -rf dist` / `X=affirm rm -rf dist` not blocked. Tests:
  `AC-454.1` (both directions — the false positive not blocked, and an
  env-prefixed *genuinely dangerous* target still blocked, proving the fix
  doesn't just widen the safe set blindly).
- **AC-454.2** No regression in #446: its dangerous-target cases stay
  blocked, its safe-target cases stay allowed. Tests: `AC-454.2` (both
  lists, verbatim from the ticket).
- **AC-454.3** Tests pin both directions and are confirmed to fail against
  the pre-fix code (verified live: both new-file assertions failed with
  `expected true to be false` before the source change, per the #437/#446
  discipline).
- **AC-454.4** Audit for the same unanchored-`indexOf`-verb-location pattern
  elsewhere: `plugin/hooks/*.mjs` and `plugin/scripts/lib/*.mjs` searched for
  `.indexOf(` — the only other hits are CLI `argv` flag-value lookups
  (`--question`, `--out`, `--issue`, `--base`, ...), a different problem
  class (pre-tokenized argv, not a raw shell-text verb search). No other
  instance found; nothing to fix or file.
- **AC-454.5 (absorbs #456)** `--` end-of-options honoured in recursive/
  force flag detection. `rm -- -rf target` / `rm -- --recursive --force
  target` not blocked. Tests: `AC-454.5`. No latency/perf assertion added
  (none required by this AC) — #486's timing-ratio flake is untouched.
- **AC-454.6** No regression on #450's `--` target-half handling
  (`rm -rf -- -prod-secrets dist` stays blocked) or #437's force-push/
  hard-reset/env-branch-delete spellings (untouched rules). Tests:
  `AC-454.6`.

## Task 1 (test): failing tests first

Added a `#454`-titled pair of describe blocks to
`tests/hooks/denylist.test.mjs`, immediately after the existing `#450`
describe block: `recursive-delete rm slice is command-token-anchored, not
substring (#454, AC-454.1)` and `recursive-delete flag detection honors
POSIX -- end-of-options (#454/#456, AC-454.5)`. Run against the pre-fix
source: 2 of 9 new tests failed exactly as expected
(`AC-454.1`'s env-prefix case, `AC-454.5`'s post-`--` flag case), the rest
passed already (regression pins that were never broken).

**Files:** tests/hooks/denylist.test.mjs
**AC map:** AC-454.1, AC-454.2, AC-454.3, AC-454.5, AC-454.6
**Test plan:** `npx vitest run tests/hooks/denylist.test.mjs -t "AC-454"`

## Task 2 (code): anchor the rm slice + honor -- in flag detection

- Add `beforeEndOfOptions(command)` next to `shortFlagCluster()`.
- In `recursive-delete`'s `test()`: compute `flagsSegment =
  beforeEndOfOptions(c)`, run `shortFlagCluster`/`--recursive`/`--force`
  against it instead of `c`; replace `cSpaced.indexOf('rm')` with
  `/\brm\b/.exec(cSpaced)` (fallback index 0).

**Files:** plugin/hooks/denylist.mjs
**AC map:** AC-454.1, AC-454.5
**Done:** Task 1's new tests pass; full `tests/hooks/denylist.test.mjs` and
`tests/lib/denylist-checks.test.mjs` green (125/125); full `vitest run`
green (1201/1201: 1192 pre-existing + 9 new).

## Task 3 (audit): AC.4 — no code change, findings recorded in plan + PR

Searched `plugin/hooks/*.mjs` and `plugin/scripts/**/*.mjs` for
`.indexOf(` uses that locate a command verb by unanchored substring search.
Only `recursive-delete`'s own (now-fixed) line matched that pattern; every
other `.indexOf(`/`.includes(` + `.indexOf(` pair in the tree operates on
already-tokenized `process.argv`/CLI-flag arrays, a different, non-buggy
class. No fix or new ticket needed.

**Files:** none (audit only)
**AC map:** AC-454.4
**Done:** documented above and in the PR body.
