# Plan: #452 - a raw NUL inside a short-flag cluster defeats four rules at once

**Ticket:** #452 (board #8, child of epic #182) - **Kind:** bug
**Base:** main - **Branch:** fix/452-denylist-nul-flag-cluster - **Verify:** `pnpm verify`

`shortFlagCluster()` (`plugin/hooks/denylist.mjs`) collects short-flag letters
via a contiguous `[a-zA-Z]+` run immediately after a `-`. A raw NUL byte
embedded inside a short-flag cluster breaks that contiguity, so the cluster is
never recognised, while a real shell silently drops the NUL and executes the
fully intact flag. Four rules are affected: `recursive-delete`, `force-push`,
`git-clean-force`, `env-branch-delete`. Pre-existing on `main`, not a
regression from #446.

#446 closed a raw-NUL splice in delete *targets* by mapping a raw NUL to an
inert SPACE. That does not help here — a space is a non-letter, so it breaks
flag-cluster contiguity exactly as the raw byte did. The alternative,
*deleting* the NUL (bash's real behaviour), closes this class but reopens
#446's target-splice class. No single global substitution closes both.

## Design (triage-verified, see issue #452 for the full analysis)

A bounded dual-view fix local to `plugin/hooks/denylist.mjs`:

- `normalizeShellText()` takes the NUL-handling mode as a parameter
  (`nulReplacement`, default `' '`) instead of a hard-coded global choice.
- `check()` computes BOTH views of the same command (space and
  NUL-deleted) and segments each with the existing `segments()` splitter.
- Each rule declares which view it reads via a `view` property:
  `force-push`, `env-branch-delete`, `hard-reset`, `git-clean-force` read the
  NUL-deleted view (their whole `test()` needs contiguous flag letters).
  `recursive-delete` is the one rule needing BOTH — its own
  `shortFlagCluster()` call reads NUL-deleted, its `safeRmTarget()` target
  parsing keeps reading the pre-existing NUL-as-space view, completely
  unchanged, so AC-446.6's pinned tests need zero edits. All other rules
  (unset `view`) keep the default space view, i.e. unchanged behaviour.
- The two views are proven to always segment identically (same count/order)
  by a dedicated regression test, since neither NUL-handling mode touches a
  `;|&\n` separator character.

Not a dependency on #457's argv tokenizer, and not contingent on the
`SAFE_RM_TARGET` absolute-vs-relative semantics question from
`docs/spikes/2026-08-13-argv-tokenize-model.md` §4 — this fix touches neither.

## Acceptance criteria (authoritative text is on the issue; summarised here)

- **AC-452.1** — All four reproductions block, each with the correct `rule`.
- **AC-452.2** — #446's target-path NUL splice (`AC-446.6`,
  `tests/hooks/denylist.test.mjs:442-483`) stays blocked with zero changes to
  those pinned tests.
- **AC-452.3** — Existing safe-target cases (`AC-312.*`, `AC-446.1`,
  `AC-450.*`) and the class-5 fused non-IFS token cases (NBSP/VT/FF,
  `tests/hooks/denylist.test.mjs:466-483`) all keep passing unmodified.
- **AC-452.4** (regression guard, not new work) — `plugin/hooks/denylist.mjs`
  and `tests/hooks/denylist.test.mjs` continue to state the correct
  exec-layer behaviour (Node throws synchronously on an embedded NUL; a live
  bash session drops the byte and fuses surrounding text), not a truncation
  model. The correction shipped in PR #453; do not reintroduce it.
- **AC-452.5** (design constraint) — The fix is a bounded, context-aware
  patch local to `plugin/hooks/denylist.mjs`'s own NUL handling. A regression
  test proves the NUL-deleted and NUL-as-space views of the same command
  always produce the same segment count/order from `segments()`.

**Guard safe-direction rule:** over-blocking is the file's stated safe
direction, never under-blocking — never trade a blocked class for an
unblocked one.

## Task 1 (test): regression tests first

Add an `AC-452.*`-titled describe block to `tests/hooks/denylist.test.mjs`
covering the four reproductions (AC-452.1), the #446 splice staying blocked
(AC-452.2), a spot-check of unaffected safe/non-IFS cases (AC-452.3), a
positive assertion that the fuse/throw exec-layer language is still present
in both files (AC-452.4), and the segment count/order parity test across many
representative NUL placements, using a newly-exported `normalizeShellText`
(AC-452.5). Written first against the pre-fix code so AC-452.1/AC-452.5
fail, confirming the regression they pin.

**Files:** tests/hooks/denylist.test.mjs
**AC map:** AC-452.1, AC-452.2, AC-452.3, AC-452.4, AC-452.5
**Test plan:** see above; run `npx vitest run tests/hooks/denylist.test.mjs`.

## Task 2 (code): dual-view NUL handling in denylist.mjs

- `normalizeShellText(rawCommand, { nulReplacement = ' ' } = {})`, exported
  for the AC-452.5 test; only the raw-NUL pre-scan line changes to use the
  parameter.
- `check()` computes `normalized` (space view, existing fallback-on-error
  behaviour unchanged) and `normalizedNulDeleted` (same fallback pattern),
  segments both, and dispatches each rule to its configured `view` (default
  space), passing the *other* view's aligned segment as the test function's
  second argument.
- `force-push`, `env-branch-delete`, `hard-reset`, `git-clean-force` gain
  `view: 'nulDeleted'`.
- `recursive-delete`'s `test` becomes `(c, cNulDeleted) => …`, using
  `cNulDeleted` only for its own `shortFlagCluster()` call; `rest`/
  `safeRmTarget()` keep reading `c` (space view) unchanged.

**Files:** plugin/hooks/denylist.mjs
**AC map:** AC-452.1, AC-452.2, AC-452.5
**Done:** Task 1's tests pass; `npx vitest run tests/hooks/denylist.test.mjs`
green (104/104: 96 pre-existing + 8 new, all pre-existing tests unmodified).

## Task 3 (docs): route index

Add this plan to `docs/README.md`.

**Files:** docs/README.md
