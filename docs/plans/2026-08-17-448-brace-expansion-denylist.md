# Plan: #448 - denylist: brace expansion can complete a flag the command text never spells

**Ticket:** #448 (board #8) - **Kind:** bug
**Base:** main - **Branch:** fix/448-brace-expansion-denylist - **Verify:** `pnpm verify`

`plugin/hooks/denylist.mjs` matches command TEXT. Bash brace expansion
(`{a,b}`, `{a..b}`, `{a..b..n}`) can complete a flag the source text never
literally spells — `git push --forc{e,} origin main` hands git a real
`--force`, `rm -r{f,} /opt/danger` hands `rm` a real `-rf`, `git branch
-{D,} main` hands branch a real `-D`, `git push {--force,} origin main`
too — defeating `force-push`, `recursive-delete`, `env-branch-delete` and
`hard-reset` alike.

An implementation was written for the parent ticket (#437 / PR #445),
reviewed five times, and removed before merge: it tried to correctly
EXPAND every brace form and match the result, and every one of eight
distinct defects traced back to that enumeration step (exponential
cross-products, a stack-overflowing single-element range, budget
starvation, an under-counted word-count budget, empty-alternative gluing,
pool exhaustion that let a real force-push through, and — the one that
ended the approach — a 74-byte input expanding to ~188KB and driving
4.65s of quadratic backtracking in the existing `\bgit\b…VERB` rules,
approaching agy's 10s fail-open timeout, #428). Full history in the
ticket body.

## Design: detect, don't enumerate

A single generic pattern — `BRACE_GROUP` — matches ANY `{…}` pair whose
content contains a comma or `..`, covering comma lists, ranges, and step
ranges alike with ONE regex that never classifies which of the three it
found. No candidate generation, no budget, no pool: cost is O(command
length), not exponential in group count, so none of the eight removed-
implementation defects have an equivalent bug surface (there is no
generate/consume sequencing left to get wrong). If the pattern is present
in a rule's dangerous-flag-bearing region, that rule refuses to certify
the command safe — the same over-block-not-under-block posture already
used throughout this file (SAFE_RM_TARGET, the `--`-boundary categorical
fallback, etc.).

### AC-448.6 — sits behind `normalizeShellText()`, not a parallel scan

The detector reads `guardedText` (already computed by
`normalizeShellText()` for `recursive-delete`'s own end-of-options
boundary check, #454) rather than raw command text or even the
canonical `text`. `guardedText`'s existing job is exactly this: tell a
GENUINE, syntactically-active character apart from one that only looks
like it after quotes are stripped. Bash's own brace expansion has the
identical quoting rule as `$(...)`  — "a correctly-formed brace
expansion must contain unquoted opening and closing braces, and at least
one unquoted comma or a valid sequence expression" (bash manual) — so
`guardedText` is the semantically correct reading to scan, not a
coincidental reuse. Extended its existing `maskable` set (whitespace,
`$`, `(`, `)`, backtick) to also cover `{` and `}` when the character is
quote/escape-PROTECTED (`bare[i] === false`), inheriting the same
same-length/same-position/UTF-16-code-unit-indexed guarantees the file's
six prior adversarial rounds on that exact mechanism already established
— no new tracking, only two more characters added to an existing,
audited substitution. A quoted `{`/`}` is masked to `GUARD_SENTINEL` and
can never satisfy `BRACE_GROUP`'s literal `{`/`}` requirement, so a
brace pair that exists only inside a quoted region (`query='mutation{a,
b}'`, a commit message `-m '…{a,b}…'`) is invisible to the detector
exactly as it is invisible to real bash's own expansion (AC-448.4,
AC-448.6). Comma/dot are deliberately NOT masked — masking just the two
delimiter characters is sufficient, since `BRACE_GROUP` cannot match
without a literal `{`...`}` pair to anchor on.

### AC-448.4 — flag-adjacent, not blanket

`hasFlagAdjacentBrace(guardedSegment, { allowBareBrace })` splits the
guarded segment on bash's own IFS (space/tab/newline — matching
`safeRmTarget()`'s established convention, not JS's wider `\s`) and asks,
per token: does this token contain a `BRACE_GROUP` match, AND does the
token look like it could BE or COMPLETE a flag? Two shapes satisfy that:

1. **The token itself starts with `-` or `+`** — the dash(es)/plus are
   already spelled; the brace only fills in the rest
   (`--forc{e,}`, `-r{f,}`, `-{D,}`, `-{f,}`, `--forc{d..e}`,
   `-{e..f}`, `--f{o..o..1}rce`). This is the shape behind every "The
   gap" example except one.
2. **The token IS ENTIRELY the brace group** (`allowBareBrace: true`
   only) — `{--force,}` — the flag's own leading dash lives INSIDE an
   alternative. Verified against real git in the ticket body as a
   genuine `--force` bypass.

`allowBareBrace` is per-call, not per-file, because shape 2 is not a
free widening everywhere: `recursive-delete`'s non-flag arguments are
ordinary bare words too (`rm {file1,file2}` deletes two named files —
nothing recursive or forced about it), so treating every leading-brace
token as flag-adjacent there would block plainly harmless commands this
ticket never asked to touch. `force-push`/`hard-reset`/
`env-branch-delete` have no equivalent "harmless bare list" argument
shape in the region they scan (a bare-brace refspec/branch-name token is
rare enough, and the demonstrated bypass real enough, that over-blocking
it is the correct trade — consistent with this file's stated safe
direction), so they pass `allowBareBrace: true`; `recursive-delete`
passes `false` and relies on the dash-prefixed shape plus its own
existing `SAFE_RM_TARGET` allowlist for the rest.

This token-shape restriction — never "any brace anywhere in the
segment" — is what keeps `git push origin feat/{a,b}` (branch name,
token starts with `f`), `rm -rf node_modules/{a,b}` (SAFE_RM_TARGET's
existing prefix match already allows this — "node_modules" starts the
token, `/` follows it, exactly like today; not new detector logic at
all), and `query='mutation{…}'`/commit-message braces (quoted, masked
per AC-448.6 above) all correctly unaffected.

### Per-rule wiring

- **force-push / hard-reset**: scan the whole guarded segment (matching
  the scope their existing flag checks already use —
  `shortFlagCluster(c)`, `HARD_RESET.test(c)` both scan the whole
  segment today).
- **env-branch-delete**: scan the guarded segment within the existing
  `git push`-delete and `git branch`-delete blocks (already gated behind
  `PROTECTED_BRANCHES.test(c)` at the top, so a brace-hidden flag next to
  an UNPROTECTED branch name still correctly falls through — matching
  today's scope for the rest of the rule).
- **recursive-delete**: scan `flagsSegment`'s own guarded reading
  (`cGuarded.slice(0, flagsSegment.length)` — same length/position
  guarantee `segsGuarded`/`segsSpaced` already rely on elsewhere in this
  file, so no new parsing is needed to derive it), `allowBareBrace:
  false`. A hit here makes BOTH `recursive` and `force` true — the
  ticket's own framing ("if present, the rule refuses to certify the
  command safe") intentionally doesn't try to guess which of `-r`/`-f`
  an ambiguous brace resolves to.

### Known, deliberate over-block (documented, not a defect)

`recursive-delete`'s dash-prefixed check does not verify that the hidden
letters could plausibly BE `r`/`f` — `rm -{v,}` (an ambiguous, wholly
non-dangerous brace on an unrelated flag) also blocks. Peeking inside
the group to check would be a step back toward "classify what this
brace could resolve to", the exact enumeration this design exists to
avoid. Rare in practice, and the safe direction for a rule whose own
stated purpose is exactly this kind of conservative refusal.

## AC map

- **AC-448.1** All 4 rules refuse to certify a command whose
  dangerous-flag-bearing region contains brace-group syntax, without
  expanding/classifying which form. Tests: literal reproductions of
  every "The gap" argv example, plus each of the eight removed-
  implementation defects re-expressed as a detector input (each must
  resolve to blocked-or-correctly-allowed, never a crash/bypass).
- **AC-448.2** Zero materialisation — `BRACE_GROUP` never generates,
  stores, or iterates candidates. Tests: a 20k-repetition single-element-
  range construction and an ~11KB/188KB-class adversarial input both
  complete without throwing, without slowdown proportional to expansion
  size.
- **AC-448.3** A hard absolute wall-clock ceiling (under 500ms) on the
  AC-448.2 adversarial constructions, through `check()` — never a ratio
  (per #486's already-flagged timing-ratio flake in this same file).
- **AC-448.4** No false positives: `query='mutation{...}'` (#85),
  `feat/{a,b}`-branch-name arguments, `node_modules/{a,b}` paths, and
  brace text inside `-m '...'` commit messages all remain allowed.
- **AC-448.5** `check()` stays total — no input throws, no rule is
  skipped, across every AC-448.1–448.4 case.
- **AC-448.6** `normalizeShellText()`'s quote/escape normalisation is
  undisturbed; the detector sits behind its `guardedText` output.

## Task 1 (test): failing tests first

New `#448`-titled describe blocks in `tests/hooks/denylist.test.mjs`,
after the existing `#454` blocks: literal "The gap" reproductions per
rule, the eight defect scenarios re-expressed as detector inputs,
AC-448.4's four false-positive categories, AC-448.2/448.3's adversarial-
size + latency cases, and an AC-448.5 totality sweep.

**Files:** tests/hooks/denylist.test.mjs
**AC map:** AC-448.1 – AC-448.6
**Test plan:** `npx vitest run tests/hooks/denylist.test.mjs -t "AC-448"`

## Fix wave 1: full-branch adversarial REVIEWER finding, closed

`forge:reviewer`, run on the full branch diff before shipping (per this
file's own established policy), found a critical bypass in
`recursive-delete`'s `allowBareBrace: false` narrowing: it exempted every
leading-`{` token from the check specifically so `rm {file1,file2}` (a
harmless bare target list) stayed allowed, reasoning that `rm`'s non-flag
arguments are ordinary bare words too. But that reasoning didn't account for
a bare-brace token whose OWN leading character is `{`, yet one of its
alternatives itself starts with `-` — bash glues whatever comes before/after
a group onto EVERY alternative, so the token's own first character does not
determine every possible resulting word's first character. Verified against
real bash: `bash -c 'echo {,-}rf'` prints `rf -rf`; `bash -c 'echo
{-rf,rf}'` prints `-rf rf`. Both are genuine `rm -rf`-class bypasses (GNU
`rm` permutes options anywhere in argv) that read `blocked: false` before
this fix.

**Fix:** rather than add a narrower peek (check whether the group's first
alternative specifically looks flag-shaped), `allowBareBrace` was removed
entirely. Every rule now treats ANY token starting with `{` (and containing
a qualifying brace-group) as flag-adjacent, uniformly. `rm {file1,file2}`
becomes a known, accepted over-block — documented below — traded
deliberately for a check whose correctness doesn't depend on getting a
nested-alternative peek right, after this exemption's specific narrowing
was where the bypass lived.

Regression-pinned as `rm {,-}rf /important-secrets` / `rm {-rf,rf}
/important-secrets` / `rm target {,-}rf` all blocking as `recursive-delete`,
plus a re-pin of `rm {file1,file2}` now correctly blocking (was previously
asserted allowed). Full suite green (1517/1517: 1361 pre-existing + 156 in
this file).

## Fix wave 2: full-branch adversarial SECURITY finding, closed

`forge:security`, dispatched in parallel with the fix-wave-1 reviewer pass,
found two independent CRITICAL problems in the original `BRACE_GROUP`
regex (`/\{[^{}\s]*(?:,|\.\.)[^{}\s]*\}/`):

1. **Nesting bypass.** The regex's `[^{}\s]*` deliberately would not cross a
   nested `{`/`}` boundary. A token where the qualifying comma sits at the
   TOP level but a comma-less NESTED group sits between the flag's literal
   prefix and that comma — `--for{ce,c{xy}e}` — real-bash-expands to a
   literal `--force` (verified: `bash -c "printf '%s\n' --for{ce,c{xy}e}"`
   prints `--force` and `--forc{xy}e`) while containing no FLAT `{...}`
   substring anywhere for the old regex to match. Reproduced identically for
   `rm -r{f,x{yz}}`, `git branch -{D,x{yz}}`, and `git reset
   --{hard,x{yz}}`.
2. **Quadratic backtracking.** The same regex's two adjacent unbounded
   `[^{}\s]*` runs either side of the comma/`..` alternation backtrack
   catastrophically on a token containing a long comma-bearing run with NO
   closing `}` ahead — measured at 8.7s through the real `check()` entry
   point on a ~120KB input (`git push -{` + `a,`×60000), breaching
   AC-448.3's own 500ms ceiling by ~17x and approaching agy's 10s fail-open
   budget (#428) — the exact hang-on-every-Bash-call failure class the
   whole detect-don't-enumerate design exists to eliminate, reopened by the
   regex ENGINE's own retry behaviour rather than by anything this file
   materialised.

**Fix:** `BRACE_GROUP` (the regex) was replaced by `tokenHasBraceGroup()`, a
linear left-to-right scan with an explicit depth counter — genuinely
O(token length), one character visited once, no backtracking possible
because nothing is ever re-scanned from an earlier position, and nesting is
handled BY CONSTRUCTION (the depth counter) rather than excluded by a
character class. Mirrors this file's own established pattern elsewhere
(`beforeEndOfOptions()`'s paren-depth tracker, `ampRunEnd`'s precomputed
backward pass) of replacing a regex whose worst case is hard to bound with
an explicit scan.

Regression-pinned as the four nested-brace reproductions all blocking
correctly, plus a linear-time pin on the ~120KB unclosed-brace construction
(completes well under 500ms and correctly resolves to `blocked: false`,
matching real bash's own "an unterminated brace never expands" behaviour).
Full suite green (1517/1517).

## Fix wave 3: full-branch adversarial SECURITY finding (deciding round), closed

The re-dispatched `forge:security` pass (run in parallel with a re-dispatched
`forge:reviewer` pass, both explicitly briefed as the deciding round before
shipping) found a THIRD critical bug — narrower in cause than fix wave 2 but
the same underlying failure shape: `tokenHasBraceGroup()`'s depth-tracking
scan closed a group unconditionally at the FIRST `}` reached at matching
depth, discarding it for good if the span up to that point had no qualifying
separator. Real bash's own closing-brace search does not stop there either —
when a span has no qualifying separator, bash treats the failed `}` as
ordinary literal content and keeps scanning right for a LATER `}` whose
widened span does qualify.

Verified against real bash: `--for{.},ce}` real-bash-expands to `--for.}`
and `--force` — the FIRST `}` (closing `{.}`, content `.`, no separator) is
not the one bash actually uses; finding no qualifying separator there, bash
re-absorbs that `}` as literal and extends to the SECOND `}`, whose widened
content `.},ce` does contain a top-level comma. The fix-wave-2 depth
tracker had no equivalent "extend past a failed close" step, so it missed
this. An exhaustive fuzz (all `{`,`}`,`,`,`.`,`a` combinations up to length
6 — 19,530 tokens, cross-checked word-for-word against real bash) found 101
tokens where bash genuinely expands but the depth-tracking scan reported no
brace group present. Confirmed to reproduce identically for `rm`, `git
branch`, and `git reset` — all four rules were bypassable.

**Fix:** rather than hand-roll bash's actual retry/extend grammar (a THIRD
from-scratch state machine, after two which each turned out to have a real
adversarially-found gap in this exact area), `tokenHasBraceGroup()` was
rewritten to a deliberately WEAKER but provably SOUND question: does the
token contain, in left-to-right order, an unquoted `{`, followed (anywhere
later) by a qualifying `,`/`..`, followed (anywhere later still) by an
unquoted `}`? This is a strict over-approximation of "bash would actually
expand this" — never an under-approximation, since any string bash's brace
expansion fires on must, by definition of the syntax, contain that character
order somewhere, regardless of which exact retry path bash took internally.
It cannot reproduce either fix wave 2's nesting bypass or fix wave 3's
failed-close bypass, and it is simpler than both prior versions: two
booleans, one linear pass, no stack, no retry.

Regression-pinned as the four `{.},X}`-shaped reproductions blocking
correctly (`git push --for{.},ce}`, `rm -r{.},f}`, `git branch -{.},D}`,
`git reset --{.},hard}`), a paired control (a token with `{`/`}` but no
separator anywhere stays allowed), and an exhaustive small-alphabet fuzz
(3,000+ generated tokens) confirming `check()` never throws and stays fast.
Full suite green (1520/1520: 1361 pre-existing + 159 in this file).

## Task 2 (code): the detector + four rule sites

- Extend `normalizeShellText()`'s `guardedText` `maskable` set to include
  `{`/`}`.
- Add `BRACE_GROUP` regex and `hasFlagAdjacentBrace()` helper next to
  `beforeEndOfOptions()`.
- Wire into `force-push`, `hard-reset`, `env-branch-delete` (whole
  guarded segment, `allowBareBrace: true`) and `recursive-delete`
  (guarded `flagsSegment`, `allowBareBrace: false`).

**Files:** plugin/hooks/denylist.mjs
**AC map:** AC-448.1, AC-448.4, AC-448.6
**Done:** Task 1's new tests pass; full `tests/hooks/denylist.test.mjs`
green; full `vitest run` green. Superseded by fix waves 1-2 above (the
`allowBareBrace` per-rule narrowing was removed, and `BRACE_GROUP` the
regex was replaced by `tokenHasBraceGroup()` the linear scan) — final state
after both fix waves: full suite green (1517/1517), all 6 mechanical gates
(plandrift/testintent/depguard/acgate) pass, both `forge:reviewer` and
`forge:security` re-dispatched clean on the fix-wave-2 tip before shipping.
