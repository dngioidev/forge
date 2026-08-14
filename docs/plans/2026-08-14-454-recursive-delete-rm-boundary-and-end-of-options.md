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

## Fix wave 2: full-branch adversarial SECURITY finding, closed

`forge:security`, run adversarially in parallel with the reviewer, found a
SECOND, independent bypass in the nesting-aware `beforeEndOfOptions()`:
`normalizeShellText()` strips quote CHARACTERS but discards which spaces
were genuinely separators versus which were literal content inside a quote.
A single argv token like `'X --'` (one shell argument — the space between
"X" and "--" is quoted, part of the SAME argument) flattens to text
indistinguishable from a real, separate `--` token. `rm 'X --' -rf
/important-secrets` is a live, dangerous `rm -rf` in real bash (getopt
never stops at a non-`--`-exact argument, and GNU coreutils' default option
permutation keeps `-rf` active regardless of an earlier non-flag operand) —
confirmed to reproduce (`blocked: false`) and confirmed still blocked on
`main`.

Closed by extending `normalizeShellText()`'s single scan to also track,
per emitted character, whether it was BARE (unquoted, unescaped, the one
`push(ch, true)` call site) or PROTECTED (everything routed through
`emit()`/`emitEscaped()`/`emitCodePoint()` — inside a quote, `$'…'`, or
immediately after a backslash). A new derived reading, `guardedText`, is
`text` with every PROTECTED whitespace character replaced by a sentinel
that cannot match `[ \t\n]` — same length as `text`, built by pure
substitution at positions that are never a `;|&\n` separator (a separator
surviving inside a quote is already neutralised to a plain space by
`emit()`'s own check before it can ever be `bare: false`), so
`segments(guardedText)` is provably identical in split points/order to
`segments(text)`, the same argument `spacedText` already established for
insertion. `beforeEndOfOptions()` now takes a second parameter — the
`guardedText` counterpart of its `command` argument — and reads boundary
whitespace from IT, not from `command`, while still reading the `-`
characters themselves from `command` unchanged.

Deliberately NOT masking hyphens, only whitespace: a QUOTED flag is still a
REAL flag to the invoked program (`rm '-rf' target` really does pass an
`-rf` argv element; quoting affects the shell's word-splitting, not the
invoked program's own option parsing), and `main` already relies on that.
Masking hyphens too would have traded this false negative for a new one.
The control case this precision buys — `rm '--' -rf target` (the WHOLE
argv element equals `--`, not merely containing it) — has no internal
protected whitespace either way and correctly stays allowed, matching real
bash and the security review's own empirical check.

Regression-pinned as `AC-454.5: a quoted decoy merely containing -- is not
read as end-of-options` (the four reproduction commands) plus `AC-454.5: a
bare quoted -- token (the whole argument, not a substring of one) is still
honoured` (the control case), both in `tests/hooks/denylist.test.mjs`. A
same-day proactive check added a fifth pin for the backslash-escaped-space
sibling of the same decoy shape (`rm X\ -- -rf target`), confirmed already
correctly handled by the same mechanism (the escape path routes through the
same default-protected helper as the in-quote path).

## Fix wave 3: full-branch adversarial reviewer finding (re-review), closed

Re-dispatching `forge:reviewer`/`forge:security` on the fix-wave-2 tip (per
policy: re-run both after any fix wave before shipping) found a THIRD,
genuinely new bug, this time an implementation defect in `guardedText`
itself rather than a design gap: it was built with
`Array.from(text, (ch, i) => ...)`, which iterates a JS string by Unicode
CODE POINT, while `bare` (built by the main scan's own plain `command[i]`
loop) is indexed by UTF-16 CODE UNIT. A surrogate-pair character (most
emoji, many CJK-extension/mathematical/supplementary-plane characters)
collapses to one iteration step under `Array.from`, so once any such
character appeared anywhere earlier in the command, every later `bare[i]`
lookup silently read one position too early — un-masking a genuinely
PROTECTED whitespace and reopening the exact quoted/escaped-decoy bypass
fix wave 2 had just closed. Confirmed reproducible
(`rm <emoji>X\ -- -rf target` read `blocked: false`) before this fix.
Closed by rebuilding `guardedText` with a plain `text[i]`/`text.length`
loop — the same UTF-16-code-unit index space `bare` already uses
throughout, so the two arrays can no longer diverge. Regression-pinned as
`AC-454.5: an astral (surrogate-pair) character earlier in the command does
not desync the guarded-whitespace masking`, covering both the
still-dangerous decoy case and a genuine bare `--` after the same emoji
(must stay honoured). Full suite green (1209/1209: 1192 pre-existing + 17
new).

## Fix wave 4: full-branch adversarial SECURITY re-review finding, closed

The re-dispatched `forge:security` pass (run in parallel with fix wave 3's
reviewer re-dispatch) found a FOURTH, independent bug: the `$(...)`/backtick
nesting-depth tracker itself — the mechanism fix wave 1 introduced — still
read raw, already quote-stripped `command` text with no reference to
`guarded`, so a close-paren or backtick that originated INSIDE A QUOTE
(ordinary literal data passed as an argument to the INNER command, e.g.
`cat`'s own quoted `')'` argument) was indistinguishable from a genuine
syntactic one. That let `rm $(cat ')' -- flagfile) -rf /important-secrets`
prematurely decrement `parenDepth` back to 0 at the quoted `)`, misreading
the inner command's own `--` as the outer `rm`'s end-of-options marker and
truncating flag detection before the real, live `-rf` — confirmed to
reproduce (`main` blocks it; this branch's tip after fix wave 3 did not).

Closed by extending `guardedText`'s masking to cover PROTECTED `$`, `(`,
`)`, and `` ` `` as well as protected whitespace (previously whitespace
only), and having `beforeEndOfOptions()`'s nesting-depth tracker read `$`/
`(`/`)`/backtick from `guarded` instead of `command` too — the hyphen check
is unaffected, still reading `command` for the reason already established
(a quoted flag is still a real flag). This is the semantically correct
model, not a defensive widening: single quotes suppress `$(...)` expansion
entirely in real bash, so a quote-protected instance of these characters
genuinely is inert data, and `normalizeShellText()`'s existing quote
tracking already runs uniformly through `$(...)`'s content (it has no
concept of substitution grouping), so `bare[i]` was already correct for
this purpose with no new tracking needed — only the consumer
(`beforeEndOfOptions`) was reading the wrong view. Regression-pinned as
`AC-454.5: a quoted paren/backtick inside a command substitution does not
desync the nesting-depth tracker`. Full suite green (1210/1210: 1192
pre-existing + 18 new).

## Fix wave 5: full-branch adversarial SECURITY re-review finding, closed

A third re-dispatch of `forge:security` (run in parallel with a third
`forge:reviewer` re-dispatch, both explicitly briefed as a deciding round)
found a FIFTH bug, narrower in cause than fix wave 4 but the same failure
shape: the depth tracker incremented ONLY on a genuine `$(` sequence, but
decremented on ANY `)` at depth > 0, regardless of which `(` it
structurally closed. A bare paren construct nested INSIDE an outer
`$(...)`/backtick region — a subshell `(cmd)`, or process substitution
`<(cmd)`/`>(cmd)`, neither preceded by `$` — was never counted going in,
but its own matching `)` still decremented the counter coming out,
returning `parenDepth` to 0 one level too shallow while genuinely still
inside the outer substitution.

`rm $(cat <(true) -- ) -rf /important-secrets` exploited exactly this: the
inner `<(true)`'s own `)` wrongly zeroed the depth, so the `--` right after
it (still, per real bash, inside the outer `$(...)`) was misread as the
real end-of-options marker, truncating flag detection before the real,
live `-rf`. Verified against real bash (`set -x`) that the whole `$(...)`
here expands to nothing (the inner process substitution's output is
empty), so the ACTUAL argv reaching `rm` is `-rf /important-secrets` — a
genuine recursive-force delete; `main` blocks it, this branch's tip after
fix wave 4 did not.

Closed by counting every bare `(` uniformly — regardless of what
introduces it — rather than requiring a preceding `$`. This is the
structurally correct model, not a narrower patch: a `--` inside ANY nested
parenthetical construct belongs to that construct, never to the outer
command, so the specific syntax that opened the parenthesis (`$(`, a bare
subshell `(`, or process substitution `<(`/`>(`) is irrelevant to this
function's one question — "has every nested region closed yet?".
Regression-pinned as `AC-454.5: a bare paren construct (process
substitution) nested inside $(...) does not desync the nesting-depth
tracker`. Full suite green (1211/1211: 1192 pre-existing + 19 new).

## Fix wave 6: full-branch adversarial REVIEWER re-review finding — closed CATEGORICALLY, not with a seventh per-case patch

A third `forge:reviewer` re-dispatch (run in parallel with fix wave 5's
security re-dispatch, both explicitly briefed as a deciding round) found a
SIXTH bug — and this one is architecturally different from the first five,
not merely another instance of the same shape. `normalizeShellText()`
tracks quoting with a SINGLE flat `quote` variable, with no concept that
`$(...)`/backticks open a genuinely INDEPENDENT quoting scope in real bash.
When the SAME quote character is reused both OUTSIDE and INSIDE a
substitution — `rm "$(cat " -- ")" -rf /important-secrets`, where the inner
argument's own `"` delimiters are, to a flat scan, indistinguishable from
the outer quote's — the scanner's quote PARITY itself desyncs, not merely
one character's masking. That produces WRONG `bare[]` values for the
content between the mistoggled positions, which no per-character masking
fix (fix waves 2-5, each of which patched one specific character class
within an ASSUMED-correctly-tracked quote) could catch, because the
underlying tracking was already wrong before any masking logic ever ran.

Verified against real bash (`set -x`): the whole `$(...)` in the
reproduction expands to an empty string (the inner `cat " -- "` call fails
harmlessly — no such file), so the outer double-quoted argument becomes one
empty-string argv element, and the ACTUAL argv reaching `rm` is `["",
"-rf", "/important-secrets"]` — a genuine, live recursive-force delete.
`main` blocks it; this branch's tip through fix wave 5 did not.

**Scope decision, made rather than continuing to patch narrower cases:**
six rounds of real, distinct adversarial findings on the SAME underlying
mechanism (flattened-text approximation of nested quote/substitution
parsing) is a strong signal that chasing a seventh, eighth, Nth variant of
"which exact nested-quote-reuse shape breaks the flat scan next" would not
converge — each fix wave had already gotten progressively more general
(fix wave 5's uniform-paren-counting closed a whole CLASS, not one
spelling), but finding 6 shows even that generality has a limit the current
architecture cannot reach without becoming the full argv tokenizer #457
explicitly defers. Per the escalation criteria ("a guard-behaviour tradeoff
for the owner... reviewer↔implementer deadlock or the same gate failing
twice"), this was weighed against escalating — but the resolution below is
NOT a guard-behaviour tradeoff (it weakens no dangerous-case block) and
closes the entire bug class rather than one more instance of it, so it was
implemented directly rather than parked.

**Fix:** `recursive-delete`'s `test()` now only TRUSTS
`beforeEndOfOptions()`'s truncation when the segment has NO quote-protected
syntactically-relevant character anywhere — checked via
`cGuarded.includes(GUARD_SENTINEL)` (`GUARD_SENTINEL`, a new shared `'\x01'`
constant, replaces the inline sentinel literal `guardedText` already used).
Whenever that check trips, flag detection falls back to scanning the WHOLE
segment unconditionally — `main`'s exact pre-#454 behaviour, already
secured by #446/#437, inheriting all of its existing correctness with zero
new risk. This is strictly a NARROWING of where the AC.5 relaxation
applies, never a weakening: it does not affect either of AC.5's own named
cases (`rm -- -rf target`, `rm -- --recursive --force target`), neither of
which involves any quoting at all, and it re-verified as still correctly
blocking every one of findings 1-6's own reproductions (re-checked directly
against `check()`, not merely inferred) — those cases now correctly block
via the categorical fallback rather than via each finding's own specific
mechanism, which remains in place as defense-in-depth for the no-quoting
case it was always sound for.

Regression-pinned as `AC-454.5: a same-quote-character reused both outside
and inside a command substitution does not desync quote tracking` plus `AC-
454.5: the categorical quote-protection gate does not affect AC.5's own
quote-free named cases`. Full suite green (1213/1213: 1192 pre-existing +
21 new).

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
