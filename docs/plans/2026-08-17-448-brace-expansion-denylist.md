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
green; full `vitest run` green.
