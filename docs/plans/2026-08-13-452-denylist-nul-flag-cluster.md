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

## Design — v2 (v1 was rejected by adversarial review; see "Fix wave" below)

A bounded fix local to `plugin/hooks/denylist.mjs`, built from exactly ONE
scan of the command per `check()` call, not two independent ones:

- `normalizeShellText()` returns `{ text, spacedText }`. `text` is the
  canonical parse (quotes stripped, escapes resolved, a raw NUL byte
  DELETED — bash's real drop-then-parse behaviour, restoring flag-cluster
  contiguity). `spacedText` is `text` with one inert SPACE re-inserted at
  every position a raw NUL was dropped, built by pure character INSERTION
  into the already-final `text` — never a second scan of the raw command.
- Every rule's `test()` reads `text`'s segment as its primary argument.
  `force-push`, `env-branch-delete`, `hard-reset`, `git-clean-force` need
  nothing else (their whole test needs contiguous flag letters, which `text`
  already gives them). `recursive-delete` alone also reads `spacedText`'s
  corresponding segment, as a second argument, for its own `safeRmTarget()`
  target-parsing only — preserving #446's target-splice behaviour without
  touching `safeRmTarget()` itself, so AC-446.6's pinned tests need zero
  edits.
- Because `spacedText` is derived from `text` by insertion, not by an
  independent parse, `segments(text)` and `segments(spacedText)` are
  PROVABLY the same length and order for any input — inserting a character
  that is never one of `;|&\n` cannot create or remove a split point. This
  is a structural guarantee, not a coincidence pinned only for the cases the
  test tries.

Not a dependency on #457's argv tokenizer, and not contingent on the
`SAFE_RM_TARGET` absolute-vs-relative semantics question from
`docs/spikes/2026-08-13-argv-tokenize-model.md` §4 — this fix touches neither.

## Fix wave: v1 rejected by adversarial review, v2 shipped

v1 ran `normalizeShellText()` TWICE independently — once mapping a raw NUL to
a space (unchanged legacy behaviour), once deleting it — and cross-indexed
the two resulting segment arrays by position by assuming they always
segment identically. Both `forge:reviewer` and `forge:security`, run in
parallel on the full branch diff, independently found that assumption false
and each produced a concrete, confirmed bypass: a NUL directly after a
backslash and before a `;` changes which character the backslash escapes
between the two independently-pre-substituted texts (space view: escapes
the substituted space, leaving the `;` a real separator; delete view: the
vanished NUL leaves the backslash directly adjacent to the `;`, so it
escapes and neutralises the `;` instead) — desyncing segment counts and
letting `check()`'s array-index fallback silently hand `recursive-delete`
the wrong (still-broken) text. `forge:reviewer` found an independent second
trigger: a NUL directly between `$` and `'` changes whether `$'…'` ANSI-C
quote-opening syntax is recognised between the two views, with the same
desync consequence. v2 (above) closes the whole class categorically by
never computing two independently-parsed texts in the first place.

A confirming re-review of v2 found two more, narrower gaps in the same
spirit, both fixed within v2's single-scan design rather than reopening it:

- `forge:security` found that `segments()` treats `&&` as one two-character
  separator with no single-character fallback (unlike `||`, where a lone `|`
  is ALSO independently a separator, so splitting `||` apart still converges
  to the same segment count once the empty piece in between is filtered). A
  NUL landing between the two `&` characters silently dropped a split rather
  than adding a harmless extra one. Fixed by pushing any marker landing
  inside a `&` run forward past the whole run before building `spacedText`.
- A follow-up pass then found the same shape one level down, inside
  `recursive-delete`'s own `safeRmTarget()`: a NUL splitting a standalone
  `--` (POSIX end-of-options, #450) token defeats its exact `t === '--'`
  match, filtering the real dash-led target out as a bare flag. Fixed the
  same way, but scoped strictly to a whitespace-BOUNDED `--` — a blanket
  dash-run push (unlike `&&`) would risk splitting an unrelated word and
  dropping half of it from judgement, trading one bypass for another. A
  third, lower-severity finding (`parts.pop()` in the ANSI-C quote-open
  handler can retroactively invalidate an already-recorded marker position,
  risking a non-monotonic `nulMarkers` array) was fixed by rebasing affected
  trailing markers at the pop site.

The `--` finding was initially triaged as out-of-scope-and-filed (#471) on
the strength of "verified identical on `main` before any marker mechanism
existed" — but on reflection that's the wrong test: the SAME mechanism
already fixed for `&&` (an upstream marker-position adjustment in
`normalizeShellText`, never touching `safeRmTarget()`'s own code, so
AC-446.6 stays untouched) extends cleanly to `--` too, and leaving a live,
directly-confirmed bypass sitting beside code this ticket just touched was
the wrong call once that was clear. Fixed in the same pass; #471 stays filed
as the historical record but its fix shipped here, not as a deferred
follow-up. `#470` (an ANSI-C-escaped NUL in a flag cluster —
`emitCodePoint()`'s control-byte handling, a genuinely different mechanism
untouched by any of this ticket's raw-NUL-handling changes) remains
correctly out of scope and filed separately.

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

## Task 2 (code): single-scan text + spacedText in denylist.mjs

- `normalizeShellText(rawCommand)` returns `{ text, spacedText }`, exported
  for the AC-452.5 test. Raw NUL handling moves INSIDE the main character
  scan (no more pre-substitution `.replace(/\0/g, …)` before it runs): a raw
  NUL is deleted from ordinary output (recorded as an output-position marker
  instead), and an unquoted backslash skips over a run of raw NULs to find
  its real escape target — the one place a backslash can consume a `;|&\n`
  separator as its target, matching what a persistent bash session (which
  never saw the dropped byte) actually does. After the scan, `spacedText` is
  built by a single linear pass inserting a space at each marker.
- `check()` computes `{ text, spacedText }` once (existing fallback-on-error
  behaviour preserved for both), segments both, and calls every rule with
  `text`'s segment as the first argument and `spacedText`'s corresponding
  segment as the second. No rule declares which "view" it wants any more —
  every rule just reads its first argument; only `recursive-delete` also
  reads the second.
- `recursive-delete`'s `test` becomes `(c, cSpaced) => …`: `c` (canonical)
  drives `shortFlagCluster()`/recursive/force detection; `cSpaced` drives
  `rest`/`safeRmTarget()` only.

**Files:** plugin/hooks/denylist.mjs
**AC map:** AC-452.1, AC-452.2, AC-452.5
**Done:** Task 1's tests pass; `npx vitest run tests/hooks/denylist.test.mjs`
green (104/104: 96 pre-existing + 8 new, all pre-existing tests unmodified).
AC-452.5's test additionally pins both adversarial-review PoCs directly.

## Task 3 (docs): route index

Add this plan to `docs/README.md`.

**Files:** docs/README.md
