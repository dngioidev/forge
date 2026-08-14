# Plan: #457 - denylist: build a real argv tokenizer (Phase 1 of tokenize-then-judge)

**Ticket:** #457 (board #8, child of epic #182) - **Kind:** chore (dead-code module + its own test suite)
**Base:** main - **Branch:** feat/457-argv-tokenizer-phase1 - **Verify:** `pnpm verify`

`docs/spikes/2026-08-13-argv-tokenize-model.md` (#451, merged PR #458) found that
`plugin/hooks/denylist.mjs`'s rules ask TEXT questions about ARGV semantics —
the shared root cause behind six sibling tickets and #446's six-round,
two-escalation delivery. Its recommendation: proceed, but scoped to **Phase 1
only** — land the tokenizer module as dead code, port nothing, change zero
behaviour. Committing to Phases 2-4 before Phase 1's real cost is known would
repeat #446's own mistake (sizing work by projection instead of evidence).

## ⚠ Scope — Phase 1 ONLY, load-bearing constraint

`plugin/scripts/lib/shell-tokenize.mjs` is imported by NOTHING in
`denylist.mjs`. `check()`'s verdicts are bit-identical before and after this
PR — proven by `git diff main -- plugin/hooks/denylist.mjs` being empty, not
merely by "the tests still pass". Porting any rule to consume the tokenizer,
the `SAFE_RM_TARGET` absolute-vs-relative semantics decision (spike §4), and
closing any of #448/#449/#452/#454/#456/#459/#495 are all explicitly OUT of
scope — Phase 2+, a separate ticket, a separate owner call.

## Design

`plugin/scripts/lib/shell-tokenize.mjs`, following `shell-split.mjs`'s
precedent (#320: small, pure, side-effect-free, no self-exec guard). Exports
one function:

```
tokenize(command: string): { text: string, kind: 'word' | 'assignment'
  | 'separator' | 'ddash' | 'substitution' | 'unresolved-brace' }[]
```

Two-pass, single-scan-per-pass implementation:

1. **`canonicalize()`** — resolves quotes/escapes structurally (not their
   decoded VALUE — no ANSI-C `$'...'` decoding, a stated non-goal) and
   deletes raw NUL bytes (fuse, not space-substitute — bash's real
   behaviour). Produces `text` plus TWO parallel boolean arrays: `wsBare`
   (real IFS-separator candidate — false inside any quote) and `synBare`
   (live `$`/`(`/`)`/backtick syntax — false only inside SINGLE quotes,
   since double quotes keep substitution syntax active in real bash). Using
   one flag for both would either miss `"$(...)"` opening a span or treat
   `"safe target"`'s internal space as a real separator — verified as a
   necessary distinction, not a defensive widening.
2. **`tokenizeCanonical()`** — walks `text` emitting `separator` tokens for
   real IFS runs, and for each non-separator run: `ddash` if the run's
   resolved text is exactly `--` (checked on resolved text, so a quoted or
   half-quoted `'--'`/`-'-'` counts per the AC-454.5 precedent already
   established — `--` is an argv-VALUE convention, quote-invariant by
   construction); `assignment` if the run starts with
   `^[A-Za-z_][A-Za-z0-9_]*=` AND that exact matched prefix is entirely
   UNQUOTED/UNESCAPED in source (checked against `wsBare`, not resolved
   text — see fix-wave 2 below for why this must NOT use the same
   resolved-text test `ddash` uses) and no verb has been seen yet (the value
   after `=` is still captured whole regardless of quoting, including any
   embedded substitution); otherwise the run is split into interleaved
   `word`/`unresolved-brace`/`substitution` pieces by `scanRun()`.
3. **`scanSubstitutionSpan()`** started as a direct generalisation of
   `beforeEndOfOptions()`'s flat `parenDepth`/`inBacktick` PAIR (#454, PR
   #496, fix-wave 5+) — "any bare `(` counts, an unterminated span runs to
   end-of-input rather than throwing or scanning unboundedly" — from "find
   one truncation boundary" to "find where THIS span ends". Reusing that
   pair rather than re-deriving it from scratch was the right call (triage's
   own instruction; re-deriving it from the spike's probes alone would have
   relitigated six already-paid-for review rounds) — but the flat pair
   itself turned out to have a real gap this ticket's own review found (fix
   wave 2), fixed with a proper stack instead of the pair.
4. Brace-group syntax (`{a,b}`, `{a..b}`, `{a..b..c}`) is DETECTED — never
   expanded, #448's own findings (eight defects, a 4.65s ReDoS on a
   74-byte input) are the direct lesson — by `hasBraceGroupSyntax()`, a
   hand-written LINEAR SCAN (not a regex; see fix wave 1 below for why),
   marking the whole containing token `unresolved-brace`. Scoping WHICH
   `unresolved-brace` tokens are flag-relevant (so `query='mutation{...}'`
   isn't blanket-flagged) is left to whichever Phase 2+ rule consumes this
   classification — real, non-free scoping work this ticket does not do.

## Fix waves (full-branch adversarial review, both required before ship)

**Fix wave 1 (`forge:security`, verdict fail -> fixed).** The FIRST version
of brace detection used a regex, `/\{[^{}]*(?:,[^{}]*)+\}/` for the
comma-list form. The review found it catastrophically backtracks on a long
comma run with NO closing `}` — the outer `[^{}]*` and the repeated group's
own `[^{}]*` both accept a comma, so the engine tries exponentially many
partitions before concluding no match. Measured: 14.3s for 30 commas in a
~37-character, entirely plausible command fragment (`'rm -r{f' +
','.repeat(30)`), not returned after 120s at 35 — the exact ReDoS class
#448's own finding (4.65s on a 74-byte input) warns about, silently
relearned here, and the module's own doc comment's safety claim about it was
simply wrong. Fixed by replacing the regex with `hasBraceGroupSyntax()`, a
hand-written scan whose index only ever advances (true O(command length),
verified at &lt;50ms across several adversarial shapes up to 200k characters).

**Fix wave 2 (`forge:reviewer`, verdict fail -> fixed).** Three findings on
the same full-branch pass:
- **Major.** `scanSubstitutionSpan()`'s flat `parenDepth`/`inBacktick` pair
  (see item 3 above) gates the backtick-toggle on `parenDepth === 0`, so a
  backtick opening while already inside an UNCLOSED `$(...)` is never
  recognised as opening a backtick region — a bare `)` inside it (e.g. a
  `case` statement's own pattern-closing paren, entirely ordinary syntax) is
  then misread as closing the OUTER span early, leaking the backtick
  region's inner text as sibling `word` tokens. Reproduced with fully valid,
  real-bash-executable syntax (`foo $(echo a; `case x in x) echo mid;; esac`;
  echo c) end` — real bash: ONE substitution, `end` the only other word).
  This is exactly the #449 leak class the module exists to prevent, and
  directly contradicted this doc's own (now-corrected) claim of symmetric
  handling. Fixed with a proper STACK of region kinds instead of the flat
  pair — see `scanSubstitutionSpan()`'s own comment for the full account.
- **Medium.** `canonicalize()` had no backslash-newline (line continuation)
  case, so an unquoted or double-quoted `\<newline>` resolved to a literal
  embedded newline instead of vanishing — real bash removes both bytes with
  nothing inserted, joining the surrounding text into one word
  (bash-verified both forms). Fixed to match `normalizeShellText()`'s own
  existing special case for the identical construct.
- **Medium.** Assignment-prefix recognition tested `ASSIGNMENT_RE` against
  already-DEQUOTED text, so `'FOO'=bar`, `FO'O'=bar`, and `FOO'='bar` were
  all wrongly classified `assignment` — real bash requires the `NAME=`
  left-hand side to be literally unquoted in source (bash-verified: each of
  those tries to run a command NAMED "FOO=bar" instead, "command not
  found"). The doc's own analogy to the `--`/`ddash` precedent (which DOES
  use resolved text, correctly) does not transfer: `--` is an argv-value
  convention interpreted by the invoked program, quote-invariant by
  construction; assignment recognition is a shell parse-time lexical rule,
  quote-SENSITIVE by construction. Fixed by additionally requiring the
  matched `NAME=` prefix be entirely `wsBare` (this module's own "reached
  output completely bare" flag) in source.

**Fix wave 3 (`forge:reviewer` round 2, verdict fail -> fixed; `forge:security`
round 2 ran in parallel, verdict pass, zero findings).** One new, narrower
finding: `canonicalize()`'s doc comment claimed the backslash-reaches-
through-NUL behaviour as a general, bash-verified property, but only the
UNQUOTED branch actually called `skipNuls()` — the double-quote escape
branch tested `command[i + 1]` directly. This was a genuine parsing bug, not
merely an undisclosed scope: `"a\<NUL>"b"` (an escaped literal quote with a
NUL fused in between) mis-closed the string at the NUL-adjacent quote
instead of reading the escape correctly and continuing the SAME string. No
test exercised a backslash-then-NUL sequence inside double quotes at all.
`denylist.mjs`'s own `normalizeShellText()` has an analogous asymmetry but
EXPLICITLY documents and justifies it; this module had no equivalent reason
to accept the gap, so it was closed rather than merely disclosed. Fixed by
making the double-quote branch call `skipNuls()` too, symmetric with the
unquoted branch.

### Stated non-goals (module doc comment, AC.4)

Glob expansion, filesystem-backed path resolution, variable-VALUE
substitution, judging what a `substitution` token would evaluate to,
recursive re-parsing of a span's own contents, `$'...'` ANSI-C escape
decoding, and a per-substitution quote-context stack (an inherited
limitation already present in `normalizeShellText()`'s own flat `quote`
variable — not a new gap this module introduces). Most consequentially: the
flat-sibling `Token` shape cannot represent a substitution FUSED mid-word
with literal flag characters as one token (`-r$(true)f` tokenizes as three
siblings, never a fused `-rf`) — this is exactly #459's (and, per
verification below, NOT #495's) live bypass, and it is NOT closed here. The
spike is explicit that closing it needs a different, non-flat-sibling token
shape — a design change this ticket does not make.

## Acceptance criteria (authoritative text is on the issue; summarised here)

- **AC-457.1** — Exported tokenizer produces the `Token = { text, kind }`
  shape, `kind` one of `word | assignment | separator | ddash | substitution
  | unresolved-brace`.
- **AC-457.2** — Its own test suite pins every bash-verified case from the
  spike (env-assignment prefix, `--` boundary, NUL fuse-not-space, subshell
  opacity, brace non-expansion) as its own regression corpus, each verified
  against real bash (GNU bash 5.3.15, Cygwin) from a script file, not
  asserted from memory — transcripts quoted inline in the test comments.
- **AC-457.3** — Zero behaviour change to `check()`/`handle()` in
  `plugin/hooks/denylist.mjs`. Structural test asserts neither file imports
  the other; `git diff main -- plugin/hooks/denylist.mjs` is empty at ship
  time; `pnpm verify` stays green at the pre-existing baseline (1213 tests on
  74 files) plus this ticket's own new tests.
- **AC-457.4** — The module's doc comment states plainly what it refuses to
  model, so the boundary is explicit for Phase 2. Mechanically checked
  (grep-style assertions on the source text) plus reviewed by eye.
- **AC-457.5** (optional, triage-suggested, implemented) — an ABSOLUTE
  wall-clock ceiling on an adversarial nested-substitution input, never a
  ratio (#486 is a live timing-ratio flake in `tests/hooks/denylist.test.mjs`
  — this assertion never compares two timings against each other).

**Conformance corpus (not an AC on its own, but required by the ticket):**
the real reproductions from #448, #449, #452, #454, #456, #459, #495,
tokenized directly and asserted against their bash-verified argv shapes.
Verified precisely, not assumed: #495's specific reproduction
(`` rm `a`$(b --)-rf /important-secrets ``) lands as one CLEAN `word:-rf`
token under this design (its bug was `shortFlagCluster()`'s own
whitespace-anchor regex, not a token-fusion problem) — #459's
(`rm -r$(true)f`) does not, and is pinned as the still-open bypass it is.
Neither claim closes its ticket; both are recorded in the PR body's unblock
accounting, matching triage exactly (#449 is the only ticket #457 unblocks,
and only "partially" per the spike; #459/#495 are NOT unblocked).

## Task 1 (test): failing tests first

Add `tests/lib/shell-tokenize.test.mjs`, importing a not-yet-existing
`plugin/scripts/lib/shell-tokenize.mjs` — fails on import until Task 2 lands.
Covers AC-457.1 (shape), AC-457.2 (bash-verified pinned cases, five named
shapes plus supporting cases), AC-457.3 (zero-behaviour-change structural
checks), AC-457.4 (doc-comment content checks), AC-457.5 (absolute-ceiling
perf tests), plus the conformance-corpus describe block for the seven family
tickets, including one test that PINS the known nested-quote-in-substitution
limitation (`"$(echo ')')"`) rather than silently getting it wrong.

**Files:** tests/lib/shell-tokenize.test.mjs
**AC map:** AC-457.1, AC-457.2, AC-457.3, AC-457.4, AC-457.5
**Test plan:** `npx vitest run tests/lib/shell-tokenize.test.mjs`

## Task 2 (code): the tokenizer module

`plugin/scripts/lib/shell-tokenize.mjs` — `canonicalize()`,
`scanSubstitutionSpan()`, `scanRun()`, `tokenizeCanonical()`, exported
`tokenize()`. No imports from, and no import by, `plugin/hooks/denylist.mjs`.

**Files:** plugin/scripts/lib/shell-tokenize.mjs
**AC map:** AC-457.1, AC-457.2, AC-457.4, AC-457.5
**Done:** Task 1's tests pass, plus the fix-wave regression tests above;
`npx vitest run tests/lib/shell-tokenize.test.mjs` green (41/41); full
`pnpm verify` green at 1254/1254 (1213 pre-existing + 41 new, zero
pre-existing tests modified); `git diff main -- plugin/hooks/denylist.mjs`
empty.

## Task 3 (docs): route index

Add this plan to `docs/README.md`.

**Files:** docs/README.md
