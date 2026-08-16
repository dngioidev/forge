# Plan: #472 - denylist: a NUL fusing a safe word with a dash-prefixed suffix bypasses safeRmTarget

**Ticket:** #472 (board #8) - **Kind:** bug
**Base:** main - **Branch:** fix/472-safermtarget-nul-dash-fusion - **Verify:** `npm run verify`

`safeRmTarget()` in `plugin/hooks/denylist.mjs` splits `rm`'s argument text
(the `spacedText` reading, where a dropped NUL is substituted with an inert
space, #446) on whitespace and unconditionally filters any `-`-leading token
out as a flag. A raw NUL between a safe-word token and a dash-prefixed
continuation defeats this: `dist<NUL>-prod-secrets` real-bash-fuses to the
single argument `dist-prod-secrets` (not a whole `dist` component — nothing
ends the word at `/` or string-end there), which correctly fails
`SAFE_RM_TARGET` as one piece — but split via `spacedText`, "dist" is judged
and passes while "-prod-secrets" is silently discarded as a flag and never
judged at all. Verified against `check()` directly against `main` before
this fix: `rm -rf dist<NUL>-prod-secrets` read `blocked:false`.

Re-verified first per this ticket's own shaping instruction (a sibling,
#471, turned out to already be fixed by #452/PR #473) — this one still
reproduces on current `main`, unrelated to and unfixed by #452/#473.

## Design

`safeRmTarget()` is only eligible to filter a dash-leading token as a
genuine flag when REAL bash whitespace preceded it — not when the only
thing preceding it was a position where a NUL was substituted with a space.
It determines this per-token by walking `rest` (the existing
`spacedText`-derived reading) in LOCKSTEP with a new `restText` parameter
(the sibling `text`-derived reading, where a dropped NUL leaves nothing
behind at all — already computed by `normalizeShellText()` and already
available to `recursive-delete`'s rule as `c`, just not previously forwarded
into `safeRmTarget()`).

Two alternative designs were considered and rejected during shaping:

- **Always fuse a synthetic-gap pair back into one string before judging
  it.** Reopens #446: fusing `/prod-secrets<NUL>/scratchpad` back into one
  string reintroduces exactly the bypass #446 closed, since
  `SAFE_RM_TARGET.test()` matches a trailing safe component anywhere in a
  string, not the whole string — the fused form ends in `/scratchpad` and
  would wrongly test safe.
- **Embed a new sentinel character into `spacedText` itself** to mark
  synthetic insertion points, instead of comparing against the sibling
  `text` reading. Rejected: any single fixed sentinel character risks
  colliding with a literal, non-NUL control byte a real (adversarial)
  command could contain verbatim as ordinary bare data — `normalizeShellText()`
  never strips or decodes an unquoted, non-NUL control byte — which would
  spoof or blind the "was this gap synthetic" test depending on which
  direction the collision ran. It would also require changing
  `normalizeShellText()`'s `spacedText` output, touching AC-452.5's pinned
  exact-content assertions.

Neither `normalizeShellText()`, `spacedText`, nor `guardedText` is touched
by this fix — it is confined entirely to `safeRmTarget()`'s own
flag-eligibility test and the one call site that constructs its arguments.
No pinned AC-446.6 / AC-450.* / AC-452.* semantic changes.

## AC map

- **AC-472.1** A safe word fused by a dropped NUL with a dash-prefixed
  continuation is judged as part of the real target, not silently filtered
  as a flag — the ticket's exact reproduction, every `SAFE_RM_TARGET`
  alternative as the fused prefix, and regardless of position among other
  targets.
- **AC-472.2** No regression: #446's raw-NUL target-splice cases, #450's
  POSIX `--` end-of-options cases, and #452's NUL-in-flag-cluster cases all
  stay exactly as before.
- **AC-472.3** A genuine, standalone flag preceded by real whitespace is
  still correctly filtered, even alongside an unrelated NUL elsewhere in
  the same command.
- **AC-472.4** The long-flag (`--recursive --force`) spelling is affected
  identically to the short `-rf` spelling.

## Task 1 (test): failing tests first

New `#472`-titled describe block in `tests/hooks/denylist.test.mjs`, after
the existing `#454` blocks: the ticket's exact reproduction, every safe-word
alternative, position-independence, and explicit re-runs of #446/#450/#452's
own pinned cases by name.

**Files:** tests/hooks/denylist.test.mjs
**AC map:** AC-472.1 – AC-472.4
**Test plan:** `npx vitest run tests/hooks/denylist.test.mjs -t "472"`

## Task 2 (code): safeRmTarget() lockstep rewrite

- Rewrite `safeRmTarget()` to accept a second `restText` parameter and walk
  both readings in lockstep, only filtering a dash-leading token as a flag
  when the sibling reading shows real IFS whitespace at that same gap.
- Update `recursive-delete`'s `test()` to compute `restText` (sliced from
  `c` at its own `\brm\b` match) and pass it through.

**Files:** plugin/hooks/denylist.mjs
**AC map:** AC-472.1, AC-472.2, AC-472.3, AC-472.4
**Done:** Task 1's new tests pass; full `tests/hooks/denylist.test.mjs`
green (167/167); full `npm run verify` green (1533/1533 across 82 files).
