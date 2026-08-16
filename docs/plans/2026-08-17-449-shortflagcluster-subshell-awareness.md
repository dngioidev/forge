# Plan: #449 - denylist: shortFlagCluster() has no subshell awareness (false-positive class)

**Ticket:** #449 (board #8) - **Kind:** bug
**Base:** main - **Branch:** fix/449-shortflagcluster-subshell-awareness - **Verify:** `pnpm verify`

## Triage premise re-check

#449 was sequenced behind #457 (Phase 1 argv tokenizer, spike #451). #457 is
now CLOSED (`plugin/scripts/lib/shell-tokenize.mjs`, PR #498) — a stack-based,
quote- and depth-aware `$(...)`/backtick span scanner
(`scanSubstitutionSpan()`), landed as dead code per its own Phase 1 scope
(imported by nothing yet). It correctly closes exactly the boundary cases the
2026-08-14 triage verdict flagged as still-unverified (`probe4`: nested
`$(...)`, a literal `)` inside a quoted string inside a span, backtick and
mixed forms). Verdict: **reuse it, deliver now** — scope stays #449's own
AC-449.1..4, no Phase 2/3 rule port.

## Problem

`shortFlagCluster()` in `plugin/hooks/denylist.mjs` scans a command segment's
WHOLE text for `-X`-shaped tokens with a plain regex
(`(?:^|\s)-([a-zA-Z0-9]+)`), with zero awareness of `$(...)`/backtick spans.
A flag-shaped token that is really an argument to an INNER command inside a
subshell (`rm "$(cat -rf backup.tar)" node_modules/x` — `-rf` belongs to
`cat`, not `rm`) gets collected into the cluster and can trip `force-push`,
`env-branch-delete`, and `recursive-delete` on a command that is not actually
dangerous — a false-positive class, not a bypass class.

## Design: reuse #457's tokenizer, mask by intersection

`subshellSafeShortFlagCluster(rawSegment, textSegment, opts)` (next to
`shortFlagCluster()`) is a drop-in companion at each of the four call sites.
It tokenizes the segment's own RAW (pre-dequote) text via `tokenize()`
(#457) and builds two reconstructions from the same token walk:
`unmasked` (every token's own text, concatenated — a plain dequoted
rendering) and `masked` (identical, except every substitution token for
which `isTerminatedSubstitution(token.text)` is true is replaced by one
space). Three clusters are then compared:

- `oldCluster = shortFlagCluster(textSegment, opts)` — the existing,
  already-trusted `c`-space (`normalizeShellText()`-dequoted) reading.
- `unmaskedCluster` / `maskedCluster` — from the two tokenizer
  reconstructions above.

If `oldCluster` and `unmaskedCluster` do not agree as character SETS, the
function returns `oldCluster` unchanged — this is the guard against
`tokenize()` and `normalizeShellText()` being two independently-written
dequoders that do not decode identically in every case (concretely:
`tokenize()` deliberately does not decode `$'...'`/`$"..."` ANSI-C/locale
escapes, AC-437.5, while `normalizeShellText()` does — this manifested as a
real regression against the AC-437.5 pinned suite during implementation,
caught by `pnpm verify`, and fixed by adding this gate rather than by
special-casing ANSI-C decoding into the new code path). When the two DO
agree, the return value is `oldCluster` filtered to characters also present
in `maskedCluster` — i.e. an intersection, not a switch to the masked
reading.

Three reasons this needs no raw-vs-dequoted OFFSET reconciliation and stays
safe by construction once the two dequoders agree:

1. Masking only ever REMOVES characters relative to `unmaskedCluster` (a
   terminated span becomes one space, never more), so intersecting can never
   surface a flag letter neither dequoder actually found outside a masked
   span (AC-449.4).
2. Whatever `textSegment` already excludes for ITS OWN reasons (most
   notably `recursive-delete`'s `--`-truncated `flagsSegment`, produced by
   `beforeEndOfOptions()`'s existing #454 fix-wave-6 "trustworthy" safety
   net) stays excluded, because the final intersection can only narrow
   `oldCluster`, never add to it. This function needs no independent
   `--`/end-of-options awareness of its own, and cannot reopen a bypass that
   safety net was built to close.
3. An UNTERMINATED span (`isTerminatedSubstitution()` false — the tokenizer
   ran it to end-of-segment without closing) is never masked, so its raw
   text stays in `maskedCluster` too — the ambiguous case can only ever
   over-block, never silently drop a genuine flag (AC-449.2).

`check()` gains one more per-segment view, `segsRaw = segments(command)` (the
RAW command, naively split the same way every other view already is), passed
as each rule's 4th `test()` argument — `undefined` whenever its length
doesn't match `segs.length` (not provably aligned the way `segsSpaced`/
`segsGuarded` are, since dequoting is not length-preserving), which disables
subshell-masking for the whole command and falls back to `oldCluster`
everywhere — again, over-block direction, never under.

`shell-tokenize.mjs` itself gains one exported function,
`isTerminatedSubstitution(spanText)`, built by widening
`scanSubstitutionSpan()`'s own (already-computed, previously-discarded)
internal state to return `{ end, terminated }` instead of a bare index —
zero change to `tokenize()`'s own pinned `Token` shape (AC-457.1 stays
green unmodified) and zero behaviour change to any existing tokenizer test.

## AC map

- **AC-449.1** `force-push`, `env-branch-delete`, `recursive-delete`: a
  `-X`-shaped token entirely inside a well-formed `$(...)`/backtick span no
  longer contributes to the cluster. Regression corpus: nested `$(...)`, a
  literal `)` inside a quoted string inside a span, backtick, mixed
  `$()`/backtick forms — each also re-verified with a REAL flag OUTSIDE the
  span still blocking (this is simultaneously an AC-449.1 pass and an
  AC-449.2/AC-449.4 regression guard).
- **AC-449.2** An unterminated `$(`/backtick never excludes the remainder
  of the command from the scan; the ambiguous case fails toward the
  existing over-blocking behaviour.
- **AC-449.3** Every new expectation bash-verified (probes run inline
  during implementation, GNU bash 5.3.15/Cygwin — this machine's own bash,
  same as the #451 spike) or, for the `denylist.test.mjs` corpus, verified
  before/after against this working tree directly via `git stash` (pre-#449
  `main` reproduces `blocked:true` for every false-positive case; this
  branch's tip reproduces `blocked:false` for those same cases only).
- **AC-449.4** No change to existing true-positive coverage — full
  `tests/hooks/denylist.test.mjs` stays green, plus `tests/lib/shell-
  tokenize.test.mjs` and the repo-wide `pnpm verify`.

## Task 1 (code): shell-tokenize.mjs — terminated flag

`scanSubstitutionSpan()` returns `{ end, terminated }`; its two call sites
in `scanRun()` destructure `.end`. New export `isTerminatedSubstitution()`.

**Files:** plugin/scripts/lib/shell-tokenize.mjs
**AC map:** enabling change for AC-449.1/AC-449.2
**Test plan:** `npx vitest run tests/lib/shell-tokenize.test.mjs` stays
green unmodified by this task alone (verified before Task 3's new tests
were added).

## Task 2 (test): bash-verified probes (AC-449.3)

Inline probes against real bash (nested/quoted-paren/backtick/mixed/
unterminated) and against this repo's own `check()` before/after via `git
stash`, establishing the false-positive baseline and the fix's effect —
transcripts folded into Task 3's test comments rather than committed as
standalone scripts (matching this file's established practice of quoting
probe evidence inline in code/test comments).

## Task 3 (code + test): denylist.mjs wiring

`subshellSafeSurfaces()`/`subshellSafeShortFlagCluster()` added next to
`shortFlagCluster()`; `check()` computes `segsRaw`/`rawAligned` and passes a
4th arg to every per-segment `rule.test()`; `force-push`, `env-branch-
delete`, `recursive-delete` call the new helper in place of the old direct
`shortFlagCluster()` call. New `AC-449` describe block in
`tests/hooks/denylist.test.mjs`.

**Files:** plugin/hooks/denylist.mjs, tests/hooks/denylist.test.mjs
**AC map:** AC-449.1, AC-449.2, AC-449.3, AC-449.4
**Test plan:** `npx vitest run tests/hooks/denylist.test.mjs -t "449"`,
then full `npx vitest run`.

## Task 4 (test): update the two pinned "spike/#457 touched nothing yet"
assertions

`tests/lib/shell-tokenize.test.mjs`'s AC-457.3 block and
`tests/docs/argv-tokenize-model.test.mjs`'s "no production hook source was
touched" test both pinned, by design, that `denylist.mjs` did not yet import
`shell-tokenize.mjs` — exactly the state #449 is the sanctioned ticket to
change (per #457's own header and the #451 spike's §5 migration plan/§3
subsumption matrix). Both updated to assert the new, honest state rather
than left stale or silently deleted.

**Files:** tests/lib/shell-tokenize.test.mjs, tests/docs/argv-tokenize-model.test.mjs
**AC map:** AC-449.4 (repo-wide green)
**Done:** full `pnpm verify` green (1544/1544 at authoring time: 1523
pre-existing + 21 new in this branch across the four touched test files).

## Fix wave 1: full-branch adversarial REVIEWER finding, closed

`forge:reviewer`, run on the full branch diff before shipping, found a
CRITICAL bypass in the intersection logic: it compared `oldCluster`/
`unmaskedCluster` as character **Sets**, discarding which token each letter
came from. A real, ANSI-C-decoded flag (`$'-f'`, decoded to a bare `-f` by
`normalizeShellText()`'s own AC-437.5 support, invisible to `tokenize()`'s
own reading per its NON-GOALS) sitting beside a same-letter DECOY `-f`
inside an otherwise-maskable subshell made the two sets agree by
coincidence (both `{f}`) even though they described different occurrences —
the masking then dropped the REAL flag along with the decoy. Verified:
`git push $'-f' "$(echo -f)" origin main` — `main` blocks it (force-push);
this branch's tip through fix wave 0 did not.

**Fix:** compare and intersect whole MATCHED-RUN **arrays**
(`shortFlagMatches()`, a new helper factored out of `shortFlagCluster()`),
never individual characters — `subshellSafeShortFlagCluster()` now requires
`oldMatches` and `unmaskedMatches` to be the exact same sequence, element
for element, before trusting any masked/unmasked delta; a lockstep walk
then identifies exactly which POSITIONS survived masking. See that
function's own comment for the full mechanism and why identical-text
duplicates at different positions are provably inert to the ambiguity this
introduces.

Regression-pinned as the reproduction above blocking correctly, plus a
re-confirmation that the original AC-449.1 false positives stay closed.
Full suite green (1548/1548 after both fix waves — see below).

## Fix wave 2: full-branch adversarial SECURITY finding, closed

The re-dispatched `forge:security` pass (run in parallel with the
re-dispatched `forge:reviewer` pass above) found a SECOND, independent
CRITICAL bug: `check()`'s `segsRaw = segments(command)` / `rawAligned =
segsRaw.length === segs.length` guard only checked segment COUNT, not
positional correspondence. A crafted multi-segment command — combining a
quoted separator (`"p;q"`, a raw-only split point `text` neutralises) with
an empty-quote pair straddling two otherwise-non-adjacent `&` characters
(`&""&`, a TEXT-only split point raw doesn't have, since the quote
characters keep the two `&`s apart in raw but vanish in `text`, gluing them
into a real `&&`) let the total segment count balance while `segsRaw[i]`
and `segs[i]` were sourced from unrelated parts of the command. Verified:
`A"p0;q0" ; noop $(echo -f) end ; git push -f origin main&""&Z` — real bash
runs `git push -f origin main` as its own undisguised top-level command;
`main` blocks it; this branch (through fix wave 1) did not, because
`subshellSafeShortFlagCluster()` was fed `noop $(echo -f) end` — a decoy
raw segment from a DIFFERENT part of the line — for the `git push -f
origin main` segment's own flag scan, and the decoy's own maskable `-f`
coincidentally matched the real one's letter.

**Fix:** stop independently re-segmenting `command` and index-pairing
altogether. `check()` now only ever trusts a raw view when the whole
command is provably ONE segment on BOTH `segments(command)` and
`segments(text)` — with exactly one entry on each side there is no index to
mis-pair, since that single entry necessarily spans the entire (trimmed)
command on both views by construction (`text` is derived from `command` via
one linear dequoting pass, not independently recomputed). A genuine
multi-segment command now always falls back to the OLD, unmasked, already-
safe (over-blocking) behaviour for the new helper — a real, disclosed
narrowing of this ticket's fix (a subshell false positive INSIDE a
multi-segment command is not closed), traded deliberately to close the
exploit class categorically rather than attempt a more precise raw-offset
mapping under adversarial time pressure. Every AC-449.1 named boundary case
is itself single-segment, so the narrowing does not affect this ticket's
required closures.

Regression-pinned as the reproduction above blocking correctly, plus an
explicit pin of the disclosed narrowing (a subshell false positive chained
after an unrelated segment stays over-blocked, unchanged from pre-#449).
Full suite green (1548/1548: 1523 pre-existing + 25 in the four touched
test files). Both `forge:reviewer` and `forge:security` re-dispatched clean
on this tip before shipping.

## Implementation-time fix: ANSI-C decoding divergence (caught by `pnpm verify`, not a separate adversarial round)

First implementation of `subshellSafeShortFlagCluster()` intersected
`oldCluster` directly against a single `maskedCluster` reading. Running the
full suite immediately surfaced 9 failures in the pre-existing AC-437.5
block (`$'\x2df'`-style ANSI-C-encoded flags no longer detected) —
`tokenize()` deliberately does not decode `$'...'`/`$"..."` (its own
NON-GOALS), so a flag spelled that way is invisible to the new masked
reading even though `normalizeShellText()` correctly decodes it into
`oldCluster`. Fixed by adding the `unmaskedCluster`-vs-`oldCluster`
set-equality gate described above, rather than teaching the new code path
to decode ANSI-C escapes (out of scope, and exactly the kind of "re-derive
a hard sub-problem" this ticket was sequenced to avoid). Full suite
re-verified green after the fix; the four false-positive cases (AC-449.1)
re-confirmed still closed.
