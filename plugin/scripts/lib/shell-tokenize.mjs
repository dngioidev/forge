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
 * span-extraction logic here (`scanSubstitutionSpan()`) generalises that same
 * state machine — "any bare `(` counts, paren-counting is suspended inside a
 * backtick span and vice versa, ambiguity always resolves toward NOT
 * splitting a span early" — to extract a span's full extent rather than just
 * answer one truncation question. Re-deriving this from scratch would have
 * relitigated the same six lessons; this module does not.
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
 *   non-assignment token is classified `assignment`. Its value is captured
 *   WHOLE, including any substitution embedded in it (`X=$(echo bar)` is one
 *   `assignment` token, not split at the substitution boundary) — the
 *   assignment's target name is what a rule cares about; sub-classifying its
 *   value is out of scope.
 * - A run whose resolved text is EXACTLY `--` is a structural `ddash` token,
 *   never a dash-prefixed word — checked against the token's RESOLVED text
 *   (quotes/escapes already removed), so a quoted `'--'` counts exactly as
 *   the AC-454.5 precedent in `denylist.mjs` already established: a shell
 *   delivers the identical argv value regardless of how it was quoted.
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
 * Brace-group SYNTAX, detected never expanded (see NON-GOALS). One pattern
 * covers all three forms the spike names — comma list, range, step range —
 * because detection never needs to classify which kind is present, only
 * whether one is. `[^{}]*` deliberately refuses to match across a NESTED
 * brace pair (bounded, no backtracking blow-up on a long flat run of `{`/`}`
 * characters — the same class of cost #448's ReDoS finding warns about).
 */
const BRACE_GROUP_RE = /\{[^{}]*(?:,[^{}]*)+\}|\{[^{}]*\.\.[^{}]*(?:\.\.[^{}]*)?\}/;

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
        if (target !== undefined) push(target, false, false);
        i = target !== undefined ? j : j - 1;
        continue;
      }
      if (ch === "'" || ch === '"') { quote = ch; continue; }
      push(ch, true, true);
      continue;
    }

    if (ch === quote) { quote = null; continue; }
    if (quote === '"' && ch === '\\' && /["$`\\]/.test(command[i + 1] ?? '')) {
      push(command[i + 1], false, false);
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
 * Extract the extent of a `$(...)`/backtick span, generalising
 * `beforeEndOfOptions()`'s hardened state machine (see module comment) from
 * "find one boundary" to "find where this specific span ends". `openIndex`
 * points at the span's own opening character(s) (`$` of `$(`, or the
 * backtick). Returns the EXCLUSIVE end index.
 *
 * Never recurses into the span to tokenize its contents (module non-goal) —
 * it only tracks enough structure (bare paren depth, backtick toggling) to
 * know when the OUTER span itself has closed, exactly as
 * `beforeEndOfOptions()` does for the same reason.
 *
 * An unterminated span (`i` reaches the end of input before closing) runs to
 * end-of-string — a defined, safe outcome per the spike's own requirement,
 * rather than an unbounded or undefined one.
 */
function scanSubstitutionSpan(text, synBare, openIndex, kind) {
  const n = text.length;
  let i;
  let parenDepth;
  let inBacktick;
  if (kind === 'paren') { i = openIndex + 2; parenDepth = 1; inBacktick = false; }
  else { i = openIndex + 1; parenDepth = 0; inBacktick = true; }

  while (i < n) {
    if (!inBacktick && synBare[i] && text[i] === '(') { parenDepth++; i++; continue; }
    if (!inBacktick && parenDepth > 0 && synBare[i] && text[i] === ')') {
      parenDepth--;
      i++;
      if (parenDepth === 0 && kind === 'paren') return i;
      continue;
    }
    if (parenDepth === 0 && synBare[i] && text[i] === '`') {
      inBacktick = !inBacktick;
      i++;
      if (!inBacktick && kind === 'backtick') return i;
      continue;
    }
    i++;
  }
  return n; // unterminated — safe, defined outcome (module contract)
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

    if (!seenVerb && pieces.length > 0 && pieces[0].kind === 'word-part' && ASSIGNMENT_RE.test(pieces[0].text)) {
      tokens.push({ text: runText, kind: 'assignment' });
      continue; // an assignment prefix never itself counts as the verb
    }

    for (const piece of pieces) {
      if (piece.kind === 'substitution') {
        tokens.push({ text: piece.text, kind: 'substitution' });
      } else {
        tokens.push({ text: piece.text, kind: BRACE_GROUP_RE.test(piece.text) ? 'unresolved-brace' : 'word' });
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
