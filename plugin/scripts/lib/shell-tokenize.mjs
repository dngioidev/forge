/**
 * Real argv tokenizer — Phase 1 of tokenize-then-judge (#457, spike #451).
 *
 * DEAD CODE, DELIBERATELY: nothing in `plugin/hooks/denylist.mjs` imports this
 * module yet. That is the whole point of Phase 1
 * (`docs/spikes/2026-08-13-argv-tokenize-model.md` §5) — land the tokenizer,
 * its own bash-verified regression suite, and its own stated contract, in
 * isolation, with ZERO behaviour change to the shipped guard. Porting any
 * rule to consume this module is explicitly out of scope here (Phase 2+).
 *
 * WHAT IT DOES: a single-pass, synchronous, side-effect-free scan (no
 * filesystem access, no subprocess) that turns a raw command-line string into
 * a flat sequence of classified tokens:
 *
 *   Token = { text: string, kind: 'word' | 'assignment' | 'separator'
 *                                | 'ddash' | 'substitution' | 'unresolved-brace' }
 *
 * This is a REPLACEMENT DESIGN for `denylist.mjs`'s current approach of
 * running several independent regexes against a partially-normalised flat
 * string (`normalizeShellText()`'s `text`/`spacedText`/`guardedText` views,
 * `shortFlagCluster()`, `safeRmTarget()`) — see the spike for the full
 * rationale. It does not import from, or get imported by, that file.
 *
 * PRIOR ART REUSED: `denylist.mjs`'s `beforeEndOfOptions()` (#454, PR #496,
 * fix-wave 5+) already implements a depth-tracking, quote-aware `$()`/
 * backtick span scanner, forged through six adversarial review rounds. The
 * span-extraction logic here (`scanSubstitutionSpan()`) started as a direct
 * generalisation of that same flat `parenDepth`/`inBacktick` PAIR — "any bare
 * `(` counts, ambiguity always resolves toward NOT splitting a span early" —
 * from "find one truncation boundary" to "find where a span ends". A
 * full-branch adversarial review of THIS ticket found that flat pair is only
 * symmetric in the direction `beforeEndOfOptions()` happens to need: it
 * cannot recognise a backtick opening while already inside an unclosed
 * `$(...)`, so a bare `)` belonging to that nested backtick region's own
 * contents (e.g. a `case` statement's pattern-closing paren) misreads as
 * closing the OUTER span early — see `scanSubstitutionSpan()`'s own comment
 * for the verified repro. Fixed here with a proper STACK (this module's own
 * addition, not inherited) rather than the flat pair; whether
 * `beforeEndOfOptions()` itself carries the same latent gap is a fact about
 * THAT function, unchanged by this ticket, not claimed either way here.
 * Re-deriving the general shape of this scanner from scratch would still
 * have relitigated the six lessons the flat-pair PART of it already
 * encodes; this module did not skip that step, it started from it and then
 * found one more.
 *
 * ============================================================================
 * CONTRACT — what this module claims, precisely
 * ============================================================================
 *
 * - Word splitting on bash's own default IFS (space/tab/newline), not
 *   JavaScript's wider `\s` — promoted from `safeRmTarget()`'s local
 *   `/[ \t\n]+/` split (AC-446.6) so every future consumer gets it, not just
 *   one rule.
 * - A raw NUL byte is DELETED, not space-substituted, matching real bash's
 *   fuse-not-truncate behaviour for a persistent session (bash-verified
 *   below, case 3) — this is a deliberate divergence from
 *   `normalizeShellText()`'s NUL-to-space substitution, which exists for a
 *   different reason (serving two downstream consumers with one flat string,
 *   see that function's own comment) that does not apply here.
 * - A token matching `^[A-Za-z_][A-Za-z0-9_]*=` that appears before the first
 *   non-assignment token is classified `assignment` — PROVIDED that matched
 *   `NAME=` prefix is entirely UNQUOTED/UNESCAPED in source (checked against
 *   `wsBare`, not the resolved text). This is deliberately NOT the same test
 *   `ddash` uses below: full-branch adversarial `forge:reviewer` found real
 *   bash requires the assignment word's left-hand side to be literally bare
 *   — quoting even one character of it (`'FOO'=bar`, `FO'O'=bar`) makes bash
 *   try to run a command NAMED "FOO=bar" instead of treating it as an
 *   assignment (bash-verified: `command not found`, never assignment
 *   behaviour). Assignment recognition is a shell LEXICAL rule sensitive to
 *   literal source quoting; it is not an argv-value convention like `--`
 *   (below), and the two must not be tested the same way despite looking
 *   parallel. The VALUE half (after `=`) is captured WHOLE regardless of
 *   quoting, including any embedded substitution (`X=$(echo bar)` is one
 *   `assignment` token, not split at the substitution boundary) — only the
 *   `NAME=` prefix's bareness matters.
 * - A run whose resolved text is EXACTLY `--` is a structural `ddash` token,
 *   never a dash-prefixed word — checked against the token's RESOLVED text
 *   (quotes/escapes already removed), so a quoted `'--'` counts exactly as
 *   the AC-454.5 precedent in `denylist.mjs` already established: a shell
 *   delivers the identical argv value regardless of how it was quoted. This
 *   is safe for `--` specifically because it is a POSIX argv-value
 *   convention interpreted by the INVOKED program (bash-verified: a `--`
 *   spelled as `-'-'`, half-quoted, still behaves as end-of-options), unlike
 *   assignment recognition above, which is a bash PARSE-TIME decision about
 *   the word's own syntax, not its resolved value.
 * - `$(...)`/backtick spans are recognised as OPAQUE `substitution` tokens by
 *   a single-pass, depth- and backtick-aware scan. The scan never recurses
 *   into a span's own contents to tokenize them as their own command — it
 *   only asks "where does this span end", exactly as `beforeEndOfOptions()`
 *   does for its narrower question.
 * - Brace-group syntax (`{a,b}`, `{a..b}`, `{a..b..c}`) anywhere in a
 *   non-substitution token's text marks that WHOLE token `unresolved-brace`
 *   instead of `word`. The syntax is detected, never expanded — see NON-GOALS
 *   below for why. Scoping WHICH `unresolved-brace` tokens are
 *   "flag-relevant" (so an ordinary commit message or GraphQL query
 *   containing `{...}` is not blanket-flagged, #85's pinned case) is left to
 *   whichever Phase 2+ rule consumes this classification — the tokenizer's
 *   job is only to say "brace-group syntax is present here", not to judge
 *   position-in-command relevance.
 *
 * ============================================================================
 * NON-GOALS — stated explicitly so Phase 2 knows the boundary
 * ============================================================================
 *
 * - NO brace expansion. #448's own findings (eight defects across five
 *   review rounds, ending in a 4.65s ReDoS on a 74-byte input through the
 *   real hook entry point) are a direct, already-paid-for lesson: enumerating
 *   expansions has unbounded cost on both the generation side and the
 *   scanning-what-was-generated side. This module never materialises a
 *   brace-group's alternatives.
 * - NO glob expansion (`*`, `?`, `[...]`). Filesystem-dependent; out of scope
 *   for a module that must stay synchronous with zero syscalls.
 * - NO filesystem-backed path resolution (symlinks, cwd-relative resolution,
 *   mounted paths). `check()` must stay synchronous — see
 *   `docs/spikes/2026-08-12-agy-approval-semantics.md`'s fail-open-at-10s
 *   finding, load-bearing for every module in this file family.
 * - NO variable *value* substitution (`$FOO` -> its runtime value). There is
 *   no execution environment to consult; `$TMP`-shaped text is an ordinary
 *   `word` token, matched on its literal spelling only, exactly as
 *   `denylist.mjs`'s `SAFE_RM_TARGET` already does.
 * - NO `$'...'` ANSI-C escape decoding. `$'...'` is treated as an ordinary
 *   `$` character (bare word text) immediately followed by a plain
 *   single-quoted region — its content is passed through literally, exactly
 *   as `'...'` content is, WITHOUT decoding `\x`/`\u`/`\NNN`/`\c`-style
 *   escapes. `normalizeShellText()` needed three separate hardening rounds to
 *   get that decoder's lookahead boundaries right (see its own `\c` comment:
 *   "guarding case by case was losing"); none of AC.2's five pinned cases
 *   need decoded values, so this module does not carry that risk for no
 *   required behaviour. A flag spelled via `$'\x2df'`-style encoding is not
 *   recognised as one — recorded as a real gap, not a silent one.
 * - NO judgement of what a `substitution` token would evaluate to. A
 *   `$(...)`/backtick span is opaque data as far as this module is
 *   concerned — closing the "characters inside a subshell leak into the
 *   outer flag scan" bug class (#449) does not require, and this module does
 *   not attempt, knowing what the subshell would print.
 * - NO per-substitution quote-context stack. Real bash treats a `$(...)`/
 *   backtick span as its OWN fresh quoting context even when nested inside an
 *   outer quote of the same character — `"$(echo ')')"` re-opens single-quote
 *   parsing INSIDE the span despite the outer double quote already being
 *   open. This module tracks quoting with one flat state variable across the
 *   whole command, same as `normalizeShellText()` already does (see that
 *   function's own `quote` variable) — so a case shaped exactly like that one
 *   is NOT guaranteed to terminate its span correctly. This is an inherited
 *   limitation of the existing flat-scan model, not a new gap introduced
 *   here; see the `KNOWN LIMITATION` test case below for the precise
 *   boundary. Closing it would mean modelling bash's full recursive-descent
 *   quote grammar, which is exactly the "no recursive re-parsing of a
 *   span's own contents" boundary this module deliberately does not cross.
 * - The flat-sibling `Token` shape (`substitution` as a sibling of `word`,
 *   never embedded WITHIN one) cannot represent a substitution FUSED
 *   mid-word with literal flag characters as a single token — `-r$(true)f`
 *   tokenizes as three siblings (`word:-r`, `substitution:$(true)`,
 *   `word:f`), never as one fused `word:-rf`. This is exactly the gap the
 *   spike's §3 names as #459's (and #495's) live bypass: a consumer reading
 *   only `kind: 'word'` tokens for flag letters will still miss a flag
 *   spelled this way. Recorded here, not papered over — #459/#495 are NOT
 *   closed by this module, and the spike is explicit that closing them needs
 *   a different (non-flat-sibling) token shape, a design change this ticket
 *   does not make.
 *
 * Pure, side-effect-free module: exports one function and nothing else (no
 * self-exec guard), following `shell-split.mjs`'s precedent (#320).
 */

/** Bash's own default IFS characters — deliberately NOT JavaScript's `\s`. */
function isIfsChar(ch) {
  return ch === ' ' || ch === '\t' || ch === '\n';
}

/** A token matching this at its start is a leading env-var assignment. */
const ASSIGNMENT_RE = /^[A-Za-z_][A-Za-z0-9_]*=/;

/**
 * Detects brace-group SYNTAX (comma list, range, or step range), never
 * expanding it (see NON-GOALS). Detection never needs to classify which of
 * the three forms is present, only whether one is — a group counts as long
 * as its content (between one `{` and the next unnested `}`) contains a `,`
 * or a `..`.
 *
 * A HAND-WRITTEN LINEAR SCAN, deliberately not a regex. An earlier version
 * of this detector used `/\{[^{}]*(?:,[^{}]*)+\}/` for the comma-list form —
 * REJECTED by adversarial security review (full-branch pass on this ticket):
 * the outer `[^{}]*` and the repeated group's own `[^{}]*` both accept a
 * comma, so on an input with many commas and no closing `}` (`'rm -r{f' +
 * ','.repeat(30)`, a ~37-character, entirely plausible-looking fragment) the
 * engine backtracks over exponentially many ways to partition the comma run
 * between the two quantifiers before concluding no match — measured at
 * 14.3s for 30 commas, still not returned after 120s at 35. That is the
 * EXACT bug class #448's own ReDoS finding warns about (a `[^{}]*`-bounded
 * pattern is NOT automatically safe merely because it cannot cross a nested
 * brace pair — this repo already learned that lesson once and the regex
 * version of this function silently relearned it). A prior version of this
 * comment claimed the old regex was "bounded, no backtracking blow-up" —
 * that claim was false and is corrected here rather than quietly dropped,
 * per this file family's own established practice of recording a wrong
 * claim alongside its correction (see `denylist.mjs`'s own comment history
 * for the same discipline).
 *
 * This scan cannot have that failure mode: `i` only ever advances (the inner
 * `while` walks forward from the current `{` to the next unnested `{`/`}`,
 * and the outer loop resumes exactly there), so every character is visited
 * at most once — O(command length), full stop, not merely "bounded per
 * group".
 */
function hasBraceGroupSyntax(s) {
  const n = s.length;
  let i = 0;
  while (i < n) {
    if (s[i] !== '{') { i++; continue; }
    let j = i + 1;
    let hasComma = false;
    let hasRange = false;
    while (j < n && s[j] !== '{' && s[j] !== '}') {
      if (s[j] === ',') hasComma = true;
      else if (s[j] === '.' && s[j + 1] === '.') hasRange = true;
      j++;
    }
    if (j < n && s[j] === '}' && (hasComma || hasRange)) return true;
    i = j; // resume exactly where the inner scan stopped — never re-visited
  }
  return false;
}

/**
 * Pass 1 — resolve quotes/escapes structurally (NOT their decoded VALUE;
 * see the module comment's non-goals) and delete raw NUL bytes, producing
 * `text` (the resolved character stream) plus two PARALLEL boolean arrays
 * answering two DIFFERENT questions per character:
 *
 * - `wsBare[i]`: is `text[i]` a candidate to be a REAL IFS separator? False
 *   inside ANY quote (single or double) and for an escaped character — both
 *   kinds of quoting suppress word-splitting on the whitespace they contain.
 * - `synBare[i]`: is `text[i]` LIVE substitution syntax (can it be part of a
 *   `$(`/`)`/backtick span-boundary)? False inside SINGLE quotes and for an
 *   escaped character, but — unlike `wsBare` — still TRUE inside DOUBLE
 *   quotes, because `$(...)`/backtick substitution is syntactically active
 *   inside double quotes in real bash; only single quotes suppress it
 *   entirely. Collapsing these into one flag (as an earlier draft of this
 *   module did) is wrong: it would either miss `"$(...)"` opening a span
 *   (treating double-quote content as fully inert) or wrongly treat
 *   whitespace inside `"safe target"` as a real separator.
 *
 * NUL handling matches the fuse-not-truncate model `normalizeShellText()`
 * already established (#452 v2) and is bash-verified below (case 3): a raw
 * NUL is invisible to bash's own parser, and a backslash immediately before
 * one or more NULs reaches THROUGH them to whichever real byte follows.
 *
 * BACKSLASH-NEWLINE (line continuation) is a dedicated case, both unquoted
 * and inside double quotes — full-branch adversarial `forge:reviewer` found
 * an earlier version of this function had none, so `\<newline>` resolved to
 * a literal embedded newline instead of vanishing. Bash-verified: both an
 * unquoted and a double-quoted `\<newline>` join the surrounding text into
 * ONE word with NOTHING inserted, not even a space —
 *
 *   $ printf '[%s]\n' r\<LF>m -x        ->  [rm] [-x]
 *   $ printf '[%s]\n' "a\<LF>b"          ->  [ab]
 *
 * `normalizeShellText()` already has the identical special case
 * (`emitEscaped`'s own `if (ch !== '\n') emit(ch);`, and its double-quote
 * escape set already includes `\n`) — this mirrors it rather than
 * reinventing a second answer to the same question.
 */
function canonicalize(rawCommand) {
  const command = rawCommand.replace(/\r/g, '');
  const chars = [];
  const wsBare = [];
  const synBare = [];
  let quote = null; // null | "'" | '"'
  const push = (ch, ws, syn) => { chars.push(ch); wsBare.push(ws); synBare.push(syn); };
  const skipNuls = (j) => { while (command[j] === '\0') j++; return j; };

  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (ch === '\0') continue; // deleted, not substituted — case 3 below

    if (quote === null) {
      if (ch === '\\') {
        const j = skipNuls(i + 1);
        const target = command[j];
        // A line-continuation swallows both bytes with NOTHING emitted —
        // every other escape target is emitted literally, non-bare.
        if (target !== undefined && target !== '\n') push(target, false, false);
        i = target !== undefined ? j : j - 1;
        continue;
      }
      if (ch === "'" || ch === '"') { quote = ch; continue; }
      push(ch, true, true);
      continue;
    }

    if (ch === quote) { quote = null; continue; }
    if (quote === '"' && ch === '\\' && /["$`\\\n]/.test(command[i + 1] ?? '')) {
      if (command[i + 1] !== '\n') push(command[i + 1], false, false);
      i++;
      continue;
    }
    // Ordinary character inside an active quote: never a real separator.
    // Live substitution syntax only inside DOUBLE quotes — single quotes
    // suppress $(...)/backtick expansion entirely in real bash.
    push(ch, false, quote === '"');
  }
  return { text: chars.join(''), wsBare, synBare };
}

/**
 * Extract the extent of a `$(...)`/backtick span. `openIndex` points at the
 * span's own opening character(s) (`$` of `$(`, or the backtick). Returns
 * the EXCLUSIVE end index.
 *
 * STACK-BASED, not the flat `parenDepth`/`inBacktick` PAIR
 * `beforeEndOfOptions()` uses (#454, PR #496) — a full-branch adversarial
 * `forge:reviewer` pass on THIS ticket found that the flat pair is only
 * symmetric in the direction it happens to test: gating the backtick-toggle
 * on `parenDepth === 0` means a backtick opening while already inside an
 * UNCLOSED `$(...)` (`parenDepth >= 1`) is never recognised as opening a
 * backtick region at all, so a bare `)` inside it — e.g. a `case` statement
 * pattern's own closing paren, entirely ordinary shell syntax — is
 * misread as closing the OUTER `$(...)` early, leaking the backtick
 * region's own inner text as sibling `word` tokens. Verified against real
 * bash (the substitution's own inner `case` block runs as ONE unit; nothing
 * about it should ever surface as an outer-command word):
 *
 *   $ foo() { printf 'ARGV[%d]=[%s]\n' "$#" "$*"; printf '[%s]\n' "$@"; }
 *   $ foo $(echo a; `case x in x) echo mid;; esac`; echo c) end
 *   ARGV[3]=[a c end]        <- ONE substitution; "end" is the only other word
 *
 * the exact #449 leak class this module exists to prevent. A prior version
 * of this function's own comment (and the plan doc) claimed the flat pair
 * handled paren/backtick suspension symmetrically "vice versa" — that claim
 * was false and is corrected here, not quietly dropped, matching this file
 * family's own practice of recording a wrong claim alongside its fix.
 *
 * The stack tracks, innermost-last, which KIND of region each currently-open
 * level is. Only the TOP frame's kind decides what closes it:
 *  - top `'paren'`: a bare `(` pushes another `'paren'` frame; a bare `)`
 *    pops the current frame (returning the end index once the stack empties
 *    while the OUTERMOST frame was itself `'paren'`); a bare backtick pushes
 *    a `'backtick'` frame (opens a NESTED backtick region — the case this
 *    fixes).
 *  - top `'backtick'`: ONLY a bare backtick pops it (real backtick spans
 *    terminate purely at the next unescaped backtick — POSIX backtick
 *    parsing has never been paren-aware, so parens inside are correctly
 *    inert here, not a simplification). Nested backtick-WITHIN-backtick
 *    without escaping is not modelled (POSIX itself requires escaping a
 *    backtick when nesting inside another backtick — the unescaped form is
 *    ambiguous even to real bash, so there is no single correct answer to
 *    reproduce; module non-goal, same "never recurse into a span's own
 *    contents" boundary as everywhere else in this module).
 *
 * Never recurses into a span to tokenize its contents (module non-goal) —
 * it only tracks enough structure to know when each open region closes.
 *
 * An unterminated span (the stack never empties before end of input) runs to
 * end-of-string — a defined, safe outcome per the spike's own requirement,
 * rather than an unbounded or undefined one.
 */
function scanSubstitutionSpan(text, synBare, openIndex, kind) {
  const n = text.length;
  const stack = [kind]; // 'paren' | 'backtick', innermost last
  let i = kind === 'paren' ? openIndex + 2 : openIndex + 1;

  while (i < n && stack.length > 0) {
    const top = stack[stack.length - 1];
    if (top === 'backtick') {
      if (synBare[i] && text[i] === '`') { stack.pop(); i++; continue; }
      i++;
      continue;
    }
    // top === 'paren'
    if (synBare[i] && text[i] === '(') { stack.push('paren'); i++; continue; }
    if (synBare[i] && text[i] === ')') { stack.pop(); i++; continue; }
    if (synBare[i] && text[i] === '`') { stack.push('backtick'); i++; continue; }
    i++;
  }
  return i; // stack empty -> just past the outermost frame's own close;
  //          loop exhausted with stack non-empty -> unterminated, i === n
}

/**
 * Walk one whitespace-bounded run `[start, n)` (stopping at the first REAL
 * IFS boundary, i.e. `wsBare[i] && isIfsChar`), splitting it into `pieces` —
 * plain word-text spans interleaved with opaque substitution spans found by
 * `scanSubstitutionSpan()`. Whitespace INSIDE an active span never ends the
 * run early: once `scanSubstitutionSpan()` returns, scanning resumes at its
 * end index, so an internal space (e.g. inside `$(echo a b)`) is correctly
 * invisible to this loop — it is consumed as part of the span, not reached
 * as a top-level position at all.
 */
function scanRun(text, wsBare, synBare, start) {
  const n = text.length;
  const pieces = [];
  let i = start;
  let wordStart = start;
  const flushWord = (end) => { if (end > wordStart) pieces.push({ text: text.slice(wordStart, end), kind: 'word-part' }); };

  while (i < n) {
    if (wsBare[i] && isIfsChar(text[i])) break;
    if (synBare[i] && text[i] === '$' && synBare[i + 1] && text[i + 1] === '(') {
      flushWord(i);
      const spanStart = i;
      i = scanSubstitutionSpan(text, synBare, i, 'paren');
      pieces.push({ text: text.slice(spanStart, i), kind: 'substitution' });
      wordStart = i;
      continue;
    }
    if (synBare[i] && text[i] === '`') {
      flushWord(i);
      const spanStart = i;
      i = scanSubstitutionSpan(text, synBare, i, 'backtick');
      pieces.push({ text: text.slice(spanStart, i), kind: 'substitution' });
      wordStart = i;
      continue;
    }
    i++;
  }
  flushWord(i);
  return { end: i, pieces };
}

/**
 * Pass 2 — walk the canonicalised text left to right, emitting the flat
 * `Token[]` stream: `separator` tokens for real IFS runs, and one or more
 * tokens per non-separator run (classified `ddash` / `assignment` / `word` /
 * `unresolved-brace` / `substitution` per the contract above).
 */
function tokenizeCanonical(text, wsBare, synBare) {
  const n = text.length;
  const tokens = [];
  let i = 0;
  let seenVerb = false; // a non-assignment, non-separator token has appeared

  while (i < n) {
    if (wsBare[i] && isIfsChar(text[i])) {
      let j = i + 1;
      while (j < n && wsBare[j] && isIfsChar(text[j])) j++;
      tokens.push({ text: text.slice(i, j), kind: 'separator' });
      i = j;
      continue;
    }

    const runStart = i;
    const { end, pieces } = scanRun(text, wsBare, synBare, i);
    const runText = text.slice(runStart, end);
    i = end;

    if (runText === '--') {
      tokens.push({ text: runText, kind: 'ddash' });
      seenVerb = true;
      continue;
    }

    if (!seenVerb && pieces.length > 0 && pieces[0].kind === 'word-part') {
      const m = ASSIGNMENT_RE.exec(pieces[0].text);
      // The matched `NAME=` prefix must be entirely BARE in source — real
      // bash requires the assignment word's left-hand side to be literally
      // unquoted; quoting even one character of it (`'FOO'=bar`, `FO'O'=bar`)
      // makes bash try to run a command NAMED "FOO=bar" instead (bash-
      // verified: exits "command not found", never treated as an
      // assignment). Full-branch adversarial `forge:reviewer` finding: an
      // earlier version tested the match against already-DEQUOTED text,
      // over-matching every one of those quoted spellings. `pieces[0]`
      // always starts exactly at `runStart` (see `scanRun()`), so its
      // matched prefix occupies `[runStart, runStart + m[0].length)` in
      // `text` — checked directly against `wsBare`, which is already this
      // module's "reached output completely bare" flag (see `canonicalize()`).
      const prefixBare = m && Array.from({ length: m[0].length }, (_, k) => wsBare[runStart + k]).every(Boolean);
      if (prefixBare) {
        tokens.push({ text: runText, kind: 'assignment' });
        continue; // an assignment prefix never itself counts as the verb
      }
    }

    for (const piece of pieces) {
      if (piece.kind === 'substitution') {
        tokens.push({ text: piece.text, kind: 'substitution' });
      } else {
        tokens.push({ text: piece.text, kind: hasBraceGroupSyntax(piece.text) ? 'unresolved-brace' : 'word' });
      }
    }
    seenVerb = true;
  }

  return tokens;
}

/**
 * Tokenize a raw shell command line into the flat `Token[]` stream described
 * in the module contract above.
 *
 * @param {string} command - the raw command line (as `denylist.mjs` receives
 *   it — one segment or the full line; this module has no opinion on
 *   `splitSegments()`, which stays a separate concern).
 * @returns {{ text: string, kind: 'word'|'assignment'|'separator'|'ddash'|'substitution'|'unresolved-brace' }[]}
 */
export function tokenize(command) {
  const { text, wsBare, synBare } = canonicalize(command);
  return tokenizeCanonical(text, wsBare, synBare);
}
