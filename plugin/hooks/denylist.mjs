#!/usr/bin/env node
/**
 * PreToolUse denylist hook (spec §7 trigger + §13 blast-radius; plan T4).
 *
 * A TARGETED backstop — NOT a general destructive-command sandbox. It matches a
 * fixed set of high-blast-radius shell patterns and nothing else: git history/
 * branch operations (force-push, protected-branch delete, hard-reset, clean -f,
 * filter-branch/-repo), `rm` recursive-force outside build/temp dirs, and
 * pipe-to-shell / eval-of-substitution RCE (see RULES). Anything not in that list
 * — including most ways to destroy data — passes through untouched.
 *
 * It FAILS OPEN by design: a matched command exits 2 (block; stderr shown to the
 * model), but a non-match, unknown input, or any internal error returns exit 0 so
 * a safety hook can never take the session down (AC-3.4). Treat it as a tripwire
 * for a few known-catastrophic commands, not a security boundary.
 */

// Component-anchored, and matched against ONE argument at a time (#446).
//
// Two halves of the same fix, because either alone leaves the other's bypass
// open — see safeRmTarget() below for the per-argument half.
//
// ANCHORING: each alternative must occupy a WHOLE path component of the
// argument, not merely appear as a substring of it. `dist` and `dist/` are
// safe; `distribution-of-secrets` is not, because "dist" there abuts "r"
// rather than a component boundary. Deliberately NOT `\b`/word-boundary: a
// hyphen is a non-word character, so a plain `\b` would still read "coverage"
// inside `coverage-notes-prod-db` as a whole word and let the exact bypass
// this ticket closes straight back in.
//
// The boundary is `/` ALONE, plus the argument's own start/end. Notably it is
// NOT a backslash, which an earlier draft of this fix included and the
// adversarial review rejected on two independent grounds, both correct:
// (1) on bash — the shell every rule in this file is written against — `\` is
// not a path separator at all, it is an ordinary filename byte, so treating
// it as component punctuation carves a fake "component" out of a single
// arbitrary filename (`customer-database\temp`, `.ssh\build`); and (2) the
// premise that a literal `\` only survives normalizeShellText() when the
// source doubled it is simply false — inside single quotes a backslash is
// literal and passes through untouched (this file's own AC-437.5 cases
// already depend on that), so `'temp\prod-secrets'` would have been waved
// through as safe. Excluding `\` costs only over-blocking an unquoted
// Windows-style path whose backslashes normalizeShellText() eats as escapes
// anyway (`C:\repo\dist` normalises to `C:repodist`) — the safe direction,
// and pinned by AC-446.5 so the choice is a decision rather than an accident.
//
// `$TMP`/`$TEMP` get no special-casing (AC.4): they are matched by the same
// component-anchored rule as every literal directory name, which already
// produces the right outcome for the one case that matters — bash itself
// resolves `$TMPDIR` to a DIFFERENT (and here, unset) variable than `$TMP`
// followed by a literal `DIR`, because env-var-name expansion consumes the
// maximal `[A-Za-z0-9_]*` run after the `$`. The component boundary here is a
// STRICTER right edge than bash's own variable-name boundary (it also rejects
// a same-token `-` suffix bash would resolve as literal data, e.g.
// `$TMP-backup`), which only ever narrows the safe set — and the one case
// AC.2 requires, `"$TMP/forge-test"`, has a `/` straight after `$TMP` and
// keeps matching.
const SAFE_RM_TARGET =
  /(?:^|\/)(?:node_modules|\.forge|dist|build|coverage|te?mp|\$TMP|\$TEMP|scratchpad)(?=$|\/)/i;

/**
 * Is EVERY delete target on this `rm` line a safe build/temp path?
 *
 * Anchoring the words was only half of #446. The exemption used to be one
 * boolean test of SAFE_RM_TARGETS against the whole command tail, so a single
 * safe-looking token ANYWHERE in the argument list exempted the entire
 * command — `rm -rf /secret/data dist` and `rm -rf /var/lib/db ~/.ssh
 * node_modules` both passed, with the real targets sitting right there in
 * plain sight. Anchoring alone does not touch that: `dist` is a perfectly
 * legitimate whole component, it just is not the argument that matters. The
 * decoy has to be defeated by asking the question PER ARGUMENT, so one safe
 * target can never vouch for an unsafe sibling. (Both were found by the
 * adversarial security review of the anchoring-only fix; both predate this
 * ticket — verified against `main` — but they are the same "a safe word
 * somewhere exempts the whole command" class #446 exists to close, so they
 * are closed here rather than left behind a fix that appears to have handled
 * them.)
 *
 * Splitting on whitespace also closes the sharpest reported variant, which
 * needed no visible second argument at all: normalizeShellText() emits an
 * inert SPACE for any decoded control byte, so `$'/etc/shadow-backup\x00
 * scratchpad'` — one single-quoted argument, in which a real bash session
 * drops the embedded NUL byte and fuses everything around it into that SAME
 * one argument, rather than truncating anything away — normalises to two
 * tokens here. Under the old whole-string test the hidden `scratchpad`
 * exempted the line; split per token, `/etc/shadow-backup` is judged on its
 * own and blocks. Treating the decoded NUL's stand-in space as a token
 * separator over-approximates (real bash keeps the whole quoted string as
 * ONE argument, byte dropped, rest fused) in the BLOCKING direction, which is
 * the right way to be wrong about a byte no legitimate path contains.
 *
 * Flag tokens are skipped, not judged: they are not delete targets, and
 * `--force` must not be mistaken for a path. A line with NO target token left
 * is treated as unsafe — that keeps the old outcome for a bare `rm -rf`, and
 * "nothing recognisable to vouch for" should never read as "safe".
 *
 * POSIX `--` end-of-options (#450, AC-450.*): a bare `--` token tells the
 * shell/utility that every token AFTER it is a filename, never a flag, even
 * one that starts with `-`. Verified against real bash (`argv rm -rf --
 * -prod-secrets dist`, printed with one arg per line): `--` and
 * `-prod-secrets` both arrive as their own literal argv entries, unmangled.
 * The pre-fix filter here did not know that — it dropped every `-`-leading
 * token regardless of position, so `-prod-secrets` vanished from judgement
 * and the decoy `dist` sitting after it vouched for the whole line. The `--`
 * token itself is dropped (it is punctuation, not a path); once seen, every
 * later token is a target unconditionally, while tokens BEFORE it are still
 * flag-filtered exactly as before (AC-450.3) — this only changes what counts
 * as a target after the marker, nothing about flag parsing ahead of it.
 *
 * The split is on bash's OWN default IFS — space, tab, newline — and
 * deliberately not on JavaScript's `\s`, which is a strictly wider class. That
 * gap is not cosmetic: `\s` also matches NBSP, vertical tab, form feed and the
 * Unicode spaces, none of which bash word-splits on. Splitting a token there
 * cuts ONE bash argument into several, and if each fragment happens to look
 * like a safe word the real target escapes judgement entirely — `rm -rf
 * dist<NBSP>build` deletes a single file named `dist<NBSP>build`, which is
 * neither `dist` nor `build`, yet `\s` splitting saw two safe components and
 * exempted the line. Verified against this platform's bash by printing the
 * expanded argv: NBSP, VT and FF all arrive INSIDE one argument, while a raw
 * tab does separate. Carriage returns need no case here — normalizeShellText()
 * strips them before any rule runs.
 */
function safeRmTarget(rest) {
  let endOfOptions = false;
  const targets = rest
    .split(/[ \t\n]+/)
    .slice(1)
    .filter((t) => {
      if (!t) return false;
      if (endOfOptions) return true;
      if (t === '--') {
        endOfOptions = true;
        return false;
      }
      return !t.startsWith('-');
    });
  if (targets.length === 0) return false;
  return targets.every((t) => SAFE_RM_TARGET.test(t));
}
const PROTECTED_BRANCHES = /\b(main|master|staging|production)\b/;

/**
 * Collect every single-dash SHORT flag cluster in a command into one string of
 * letters (and, when `alnum`, digits) — e.g. "git push -uf origin main" -> "uf".
 * The `(?:^|\s)-` anchor keeps GNU/git long `--flag` (double dash) and mid-word
 * dashes (`feat-f`, a branch name that happens to contain "-f") out of the
 * cluster, so neither can spoof nor dodge a short flag. `alnum` widens the class
 * to digits for git's own numeric short flags (`-4`/`-6`) that bundle with a
 * boolean (`-4f` really forces, see force-push); `rm` has no numeric short
 * flags, so recursive-delete keeps the narrower alpha-only class.
 *
 * Extracted (#437 AC.4) from force-push and recursive-delete, which had each
 * hand-rolled this same regex separately; env-branch-delete now reuses it too.
 */
function shortFlagCluster(command, { alnum = false } = {}) {
  const charClass = alnum ? '[a-zA-Z0-9]' : '[a-zA-Z]';
  return (command.match(new RegExp(`(?:^|\\s)-(${charClass}+)`, 'g')) || []).join('');
}

/**
 * DETECT, DON'T ENUMERATE (#448). Brace expansion can complete a flag the
 * command text never spells — `--forc{e,}` -> `--force`, `-r{f,}` -> `-rf`,
 * `-{D,}` -> `-D`, `{--force,}` -> `--force`, and ranges need no comma at all
 * (`--forc{d..e}` -> `--force`, `-{e..f}` -> `-f`, a step range too:
 * `--f{o..o..1}rce` -> `--force`). An earlier implementation tried to
 * correctly EXPAND every brace form and match the result; five adversarial
 * review rounds found eight defects in it (stack overflow on a 20k-deep
 * single-element range, budget starvation, a coverage gap past ~log2(budget)
 * groups, empty-alternative gluing, pool exhaustion that let a real
 * force-push through, and — the one that ended the approach — a 74-byte
 * input expanding to ~188KB that drove the EXISTING `\bgit\b…\bVERB\b` rules
 * into quadratic backtracking, 4.65s through the real hook entry point
 * against agy's 10s fail-open timeout). Triage's design call: refuse to
 * certify a command safe if brace-group syntax sits in a flag-shaped token,
 * WITHOUT ever generating what it would expand to. No candidate is
 * generated, stored or counted, so none of those eight bugs has an
 * equivalent surface here — there is no generation/consumption sequencing
 * left to get wrong, and cost is a linear scan of text that is never larger
 * than the command itself (unlike the expand-first approach, which had to
 * bound something that grows with the text it produces).
 *
 * Scoped to a single whitespace-delimited TOKEN at a time — brace expansion
 * only ever combines with the token it sits inside, never across a real
 * space — and, within a token, to exactly the question "could this token's
 * FIRST character, after expansion, be `-` or `+`":
 *
 *  - If the token itself already starts with `-`/`+` (`--forc{e,}`,
 *    `-r{f,}`, `-{D,}`, `+{main,}`), that leading character survives
 *    whatever the brace group(s) elsewhere in the token resolve to — a
 *    prefix before the first `{` is literal text, untouched by expansion —
 *    so the token is ALREADY flag-shaped and any brace-group syntax
 *    anywhere in it is enough to refuse, without asking which alternative
 *    would actually be chosen.
 *  - If the token instead STARTS with `{` (`{--force,}`), the token's own
 *    first character is undetermined until that leading group resolves, so
 *    the question becomes "does any comma-separated alternative in that
 *    FIRST group start with `-`/`+`" — checked by a flat split on ONE
 *    already-isolated brace group's content, never a cross-product, never
 *    recursive into a NESTED brace (this file doesn't attempt to parse
 *    those, on the safe over-block side: a token whose leading group can't
 *    be closed, or a comma/range this can't resolve, still fails the "does
 *    an alternative start with -/+" test and is left unflagged by this
 *    function alone — genuinely dangerous nested/malformed shapes are still
 *    caught by the literal flag checks these rules already run). A brace
 *    group LATER in a `{`-leading token cannot change the token's own first
 *    character, so only the first group needs inspecting.
 *
 * Deliberately conservative, matching this file's own stated safe direction
 * (over-block, not under-block): a flag-shaped token with brace-group syntax
 * refuses the command whether or not the alternatives it could expand to
 * would actually be dangerous (`rm -{v,}` — a doubled, harmless -v either
 * way — now blocks too). Resolving that would mean classifying which
 * alternative wins, which is exactly the approach five review rounds
 * rejected.
 *
 * This is what keeps AC-448.4's false positives out, and it is a SCOPE
 * check, not a leniency exception: `query='mutation{...}'` normalises (quote
 * chars stripped, #437/#473) to a token starting with `q`; a `feat/{a,b}`
 * branch-name argument starts with `f`; a `node_modules/{a,b}` rm target
 * starts with `n`; a brace-bearing word inside a commit message value starts
 * with whatever ordinary letter the message does. None of those tokens
 * starts with `-`, `+` or `{`, so none of them is ever examined for brace
 * syntax at all — the scope check runs BEFORE the brace check, not after.
 *
 * Reads the SAME per-segment text every rule already reads (`c`, produced by
 * normalizeShellText() ahead of this call) — a scan behind that existing
 * output, never a parallel scan of raw text (AC-448.6).
 */
function hasFlagBrace(command) {
  for (const token of command.split(/[ \t\n]+/)) {
    if (!token || token.indexOf('{') === -1) continue;
    const first = token[0];
    if (first === '-' || first === '+') {
      if (tokenHasBraceGroup(token)) return true;
      continue;
    }
    if (first === '{') {
      const inner = firstBraceGroupContent(token);
      if (inner !== null && innerHasFlagAlternative(inner)) return true;
    }
  }
  return false;
}

/**
 * Does `token` contain at least one `{…}` pair (no nesting attempted — see
 * the function-level comment above) whose content is brace-GROUP syntax, not
 * merely a pair of braces: a comma list or a `..` range/step-range, the two
 * ways bash brace expansion actually activates. Found by advancing a cursor
 * strictly forward past each closed pair with `indexOf` — never a
 * backtracking regex — so the whole scan is a single linear pass over the
 * token regardless of how many groups it contains or how long any one
 * group's content is (AC-448.2). A regex shaped like
 * `\{[^{}]*(?:,|\.\.)[^{}]*\}` looks equivalent but is NOT: on a token that
 * opens a brace and never closes it, densely packed with commas, the two
 * `[^{}]*` runs either side of the alternation can each anchor at every
 * comma in turn, which is the classic quadratic-backtracking shape this
 * file's own #452 history exists to avoid repeating (AC-448.3).
 */
function tokenHasBraceGroup(token) {
  let i = 0;
  for (;;) {
    const open = token.indexOf('{', i);
    if (open === -1) return false;
    const close = token.indexOf('}', open + 1);
    if (close === -1) return false; // unterminated: nothing left to close, nothing more to find
    const inner = token.slice(open + 1, close);
    if (inner.indexOf(',') !== -1 || inner.indexOf('..') !== -1) return true;
    i = close + 1; // strictly forward — total work across all iterations is O(token length)
  }
}

/** The content of the FIRST `{…}` pair in a token known to start with `{`. */
function firstBraceGroupContent(token) {
  const close = token.indexOf('}', 1);
  return close === -1 ? null : token.slice(1, close);
}

/**
 * Does any top-level comma-separated alternative inside one already-isolated
 * brace group's content start with `-`/`+`? For a range/step-range (no
 * comma at all — `d..e`, `o..o..1`), the single "alternative" is the whole
 * content, so its own leading character is the one that matters. Only ever
 * called on ONE group's content, never recursed into a nested `{`, never
 * cross-referenced against a later group — see the function-level comment
 * above for why that is enough.
 */
function innerHasFlagAlternative(inner) {
  if (inner.indexOf(',') === -1) {
    return inner.indexOf('..') !== -1 && (inner[0] === '-' || inner[0] === '+');
  }
  return inner.split(',').some((alt) => alt[0] === '-' || alt[0] === '+');
}

/**
 * Build the regex source for a long flag AND every unambiguous abbreviation of
 * it that git's parse-options accepts, e.g. abbrev('mirror', 1) yields
 * `m(?:i(?:r(?:r(?:o(?:r)?)?)?)?)?` — matching --m/--mi/--mir/--mirr/--mirro/
 * --mirror. `minLen` is the SHORTEST prefix that is unambiguous for that flag
 * on that specific git subcommand. Every value used below was determined
 * empirically against real git 2.55, not guessed: git refuses a prefix that
 * could mean two options ("error: ambiguous option"), so the boundary differs
 * per verb depending on which sibling flags that verb happens to have.
 */
function abbrev(word, minLen) {
  let tail = '';
  for (let i = word.length - 1; i >= minLen; i--) tail = `(?:${word[i]}${tail})?`;
  return word.slice(0, minLen) + tail;
}

/**
 * A long flag as a whole token: `--<flag-or-unambiguous-abbreviation>` at a
 * token start, not followed by further word characters or a hyphen. That
 * trailing `(?![\w-])` is what stops an abbreviation pattern from firing on a
 * LONGER, different flag that merely shares its prefix — `--m…` must not match
 * `--max-count`, and a `--force` pattern must not match `--force-with-lease`.
 */
const longFlag = (word, minLen) => new RegExp(`(?:^|\\s)--${abbrev(word, minLen)}(?![\\w-])`);

// Empirically-verified shortest unambiguous prefixes (git 2.55):
//   git push --mirror   -> `--m`    (no other push long option starts with "m")
//   git push --delete   -> `--de`   (`--d` is ambiguous with --dry-run)
//   git branch --delete -> `--d`    (the only branch long option starting "d")
//   git branch --force  -> `--forc` (`--fo` is ambiguous with --format)
// Deliberately ABSENT, and not an oversight: `git push --force`. Every prefix
// shorter than the full word is ambiguous with --force-with-lease /
// --force-if-includes and git rejects it outright, so the existing literal
// `--force` match is already complete for that flag — and keeps its negative
// lookahead so the two sanctioned safe idioms stay unblocked (#429).
const PUSH_MIRROR = longFlag('mirror', 1);
const PUSH_DELETE = longFlag('delete', 2);
const BRANCH_DELETE = longFlag('delete', 1);
const BRANCH_FORCE = longFlag('force', 4);
//   git reset --hard    -> `--h`    (the only reset long option starting "h")
const HARD_RESET = longFlag('hard', 1);

/** Separators splitSegments() divides on — see neutralisation note below. */
const SEPARATOR_CHARS = /[;|&\n]/;

/**
 * Undo the shell's own quoting/escaping before matching (#437, both rounds of
 * the adversarial security review).
 *
 * Every rule in this file is a TEXT match against the command line, but a
 * shell removes quotes and escapes before the target program ever sees its
 * argv. `git push -"f" origin main`, `git push -\f origin main` and
 * `git push $'-f' origin main` all deliver the identical `-f` to git, while
 * each defeats a purely literal, dash-anchored pattern. That made quoting or
 * escaping ONE character of a flag token a universal bypass of the WHOLE
 * denylist — not a gap in any single rule — and it defeated the two rules #437
 * set out to harden exactly as completely as the pre-existing ones.
 *
 * Three normalisations, each closing one reported bypass class:
 *
 *  1. **Quote characters are removed** (`-"f"` -> `-f`).
 *  2. **Backslashes are removed** (`-\f` -> `-f`, `-\-hard` -> `--hard`), and
 *     the `$` introducing ANSI-C/locale quoting is dropped so `$'-f'` -> `-f`.
 *     A `$` anywhere else is untouched, so `$TMP` still matches SAFE_RM_TARGET
 *     and `$(` still trips `eval-exec`.
 *  3. **Shell separators found INSIDE a quoted region become spaces.**
 *     `splitSegments()` is not quote-aware, so a separator hidden in a quoted
 *     argument would otherwise fragment the command around it and carry the
 *     verb into a different segment than its flag — e.g. a quoted `;` between
 *     `git branch` and `-D` splits them apart, and neither half matches on its
 *     own. (That fragmentation PREDATES this change — verified against this
 *     branch's first commit — but it is the same bypass class, so it is closed
 *     here rather than left. Separators OUTSIDE quotes are untouched, so real
 *     chained commands still split exactly as before, which is what keeps #85's
 *     false-positive fix working.)
 *
 * Backticks are deliberately PRESERVED throughout: `eval-exec`'s SUBSTITUTION
 * test matches on them, so stripping those would trade one bypass for another.
 *
 * An escape MUST consume the character it escapes. Dropping a backslash while
 * letting the next character be re-read independently is not a harmless
 * simplification: an unquoted `\"` would then open a PHANTOM quote region, a
 * later genuine quote would be misread as closing it, and the flipped parity
 * would leave a real quoted separator un-neutralised — silently reopening the
 * very fragmentation bypass (3) closes. That regression was caught in review;
 * the lookahead below is what prevents it, so keep the two-character step.
 *
 * Bash's own escaping rules are followed rather than approximated, because
 * both directions of error are costly here. Outside quotes a backslash escapes
 * the next character. Inside DOUBLE quotes it is special only before
 * `$ ` + "`" + ` " \` or a newline. Inside ordinary SINGLE quotes it has no
 * special meaning at all and is a literal character — treating it as an escape
 * there would over-match (`'-\D'` is one inert literal argument to git, not a
 * branch delete).
 *
 * `$'…'` (ANSI-C quoting) is its OWN mode and the sharpest edge of the three.
 * Dropping its backslashes without DECODING them is not enough: bash expands
 * `$'\x2df'` to `-f`, `$'\055D'` to `-D`, `$'\x2d\x2dhard'` to `--hard`. An
 * attacker can spell any flag, or any whole word, as hex or octal bytes, so a
 * normaliser that only handles `$'-f'` (where the content is already literal)
 * closes almost none of the surface.
 *
 * SCOPE OF THE DECODER, stated narrowly because earlier drafts of this comment
 * three times claimed more than the code delivered: the goal is not to
 * reproduce bash. It is to recover the PRINTABLE ASCII a flag could be spelled
 * with. Every decoded escape — hex, unicode, octal, `\c`, the named single
 * characters, and the unrecognised passthrough — is emitted only via
 * `emitCodePoint()`, which keeps a character solely if it is printable ASCII
 * and emits an inert space otherwise. Control bytes, out-of-range values and
 * astral code points cannot spell `-`, a letter or a digit, so collapsing them
 * to one inert outcome is safe and removes range-checking and unicode edge
 * cases as separate things to get right.
 *
 * What that does NOT remove, and what actually bit this file repeatedly: how
 * far each escape's lookahead may CONSUME. Getting the value right is easy;
 * getting the terminator right is where the bugs were. The hex/octal forms are
 * bounded by digit classes, which can never match a quote character, so they
 * cannot run past the end of their region. `\c` takes an ARBITRARY operand, so
 * it has no such natural bound — and guarding it case by case lost twice. It
 * is fixed below by not looking ahead at all, which is why no branch in this
 * function now has an unbounded lookahead.
 */

/** Single-character ANSI-C escapes bash decodes inside `$'…'`. */
const ANSI_C_ESCAPES = {
  a: '\x07', b: '\b', e: '\x1b', E: '\x1b', f: '\f', n: '\n',
  r: '\r', t: '\t', v: '\v', '\\': '\\', "'": "'", '"': '"', '?': '?',
};

/**
 * Returns `{ text, spacedText }` — TWO readings of the same command, but
 * built from exactly ONE scan (#452 v2; see the long history below for why a
 * v1 that ran TWO independent scans was rejected by adversarial review).
 *
 * `text` is the canonical parse: quotes stripped, escapes resolved, and a raw
 * NUL byte DELETED — bash's own real behaviour (a persistent session drops
 * the byte before its parser ever runs). Node's child_process throws on an
 * embedded NUL before the command ever runs, too — NOT truncation under
 * either concrete path. Every rule reads `text` (via `segments()`) as its
 * primary/only view.
 *
 * `spacedText` is `text` with one inert SPACE re-inserted at every position a
 * raw NUL was dropped — needed ONLY by `recursive-delete`'s own
 * `safeRmTarget()` target-parsing, to keep closing #446's target-path splice
 * (`/prod-secrets<NUL>/scratchpad` must judge as TWO tokens, not one fused
 * path ending in the safe word `scratchpad`) without reopening the
 * flag-cluster class this ticket exists to close (`-r<NUL>f` must still read
 * as a bundled `-rf`). `spacedText` is built by INSERTING characters into the
 * ALREADY-FINAL `text`, never by re-scanning the raw command a second time —
 * which is what guarantees `segments(text)` and `segments(spacedText)` always
 * have the same length and order (AC-452.5): inserting a character that is
 * never one of `;|&\n` cannot create or remove a split point, for ANY input,
 * not merely the ones this file's own tests happen to try.
 *
 * ## Why v1 (two independent normalizeShellText() scans, one with NUL mapped
 * to a space, one with it deleted) was wrong, not merely imprecise
 *
 * v1 ran the WHOLE quote/escape scan twice, from raw text, differing only in
 * what a NUL substitutes to BEFORE the scan starts. That is unsound whenever
 * a backslash sits directly before a NUL: which character the backslash
 * escapes depends on what follows the NUL in EACH pre-substituted text, so
 * the two scans can reach genuinely different quote/escape states — not just
 * different rendered bytes — and diverge on how many REAL segments the
 * command splits into. Two independent adversarial reviews (forge:reviewer,
 * forge:security) each found a live bypass this way, via two different
 * triggers: a NUL directly after a backslash and directly before a `;`
 * (backslash escapes the substituted-space in the space view, leaving the
 * `;` bare and splitting; backslash escapes the `;` itself in the deleted
 * view, since the vanished NUL leaves it directly adjacent, neutralising it
 * and NOT splitting), and a NUL directly between `$` and `'` (breaks the
 * `$'…'` ANSI-C-quote-open adjacency in the space view only, so the same
 * text closes a quote in one scan and keeps it open in the other). Both
 * desynced `segments()`'s length between the two views, and `check()`'s
 * `recursive-delete` dispatch — the one rule that cross-indexes the two
 * arrays to read the SAME segment two ways — silently fell back to the
 * WRONG (still flag-cluster-broken) text once the arrays ran out of step,
 * reopening exactly the bypass #452 exists to close.
 *
 * v2 (this version) cannot have that failure mode: there is only ONE scan,
 * so there is only ONE segmentation, full stop — `spacedText` is derived
 * from `text` AFTER segmentation-relevant structure is already fully
 * decided, as a pure textual insertion that cannot touch it.
 *
 * ## What "the scan treats a raw NUL as invisible" means concretely
 *
 * A raw NUL byte is dropped wherever it would otherwise become ordinary
 * output data (recorded as a `nulMarkers` position instead), AND a backslash
 * immediately before one or more raw NULs reaches THROUGH all of them to
 * escape the first real byte that follows — exactly what happens to a
 * PERSISTENT BASH SESSION fed this byte over stdin, since its input layer
 * drops an embedded NUL before its own command-line parser (the one that
 * resolves backslash-escaping) ever sees the stream; the backslash was never
 * looking at "a NUL", from that parser's point of view, at all. This is
 * implemented only where it can affect SEGMENTATION — the unquoted branch's
 * generic backslash-escapes-the-next-character rule, since that is the only
 * place a backslash can consume a `;|&\n` separator as its target. The
 * double-quote branch (backslash special only before a fixed set of
 * characters) and the ANSI-C `$'…'` decode branch (hex/octal/named escapes,
 * which require SPECIFIC literal characters immediately after the backslash,
 * not "whatever comes next") are deliberately left unchanged: a NUL
 * interposed there produces at worst one stray literal backslash character
 * or a missed decode (both pre-existing on `main` too, since #446 already
 * pre-substitutes NUL before this same scan runs) — inert for rule-matching
 * (never a letter, never a separator, and any decoded escape value still
 * routes through `emitCodePoint()`'s own printable-ASCII-or-space collapse)
 * — not a segmentation risk, and out of this ticket's bounded scope.
 */
export function normalizeShellText(rawCommand) {
  // Carriage returns go FIRST, before any other rule looks at the text.
  // Verified on this platform's own bash (both the Cygwin and the
  // Git-for-Windows/MSYS2 builds): a bare CR is stripped mid-token (`a\rb`
  // arrives as `ab`), and consequently `\<CR><LF>` is a line continuation
  // exactly as `\<LF>` is. Windows editors write CRLF by default, so a command
  // wrapped over two lines and saved normally hit this — the same
  // split-instead-of-join miss the newline rule below exists to prevent, via
  // the platform's default line ending. Handling it here rather than adding a
  // CRLF case to every rule keeps it to one line and cannot be forgotten by
  // the next branch someone adds.
  //
  // A Linux bash keeps a literal CR instead. Stripping it there can only JOIN
  // tokens the shell would have kept apart, i.e. match more, never less — the
  // safe direction — and a CR cannot spell part of a flag either way.
  //
  // A raw NUL is handled INSIDE the main scan below (not here), because
  // whether a backslash escapes a NUL or reaches through it to whatever
  // follows can only be decided correctly while walking the text once — see
  // the function-level comment above.
  const command = rawCommand.replace(/\r/g, '');
  // Output is accumulated as single-character CHUNKS and joined once at the
  // end, rather than appended onto a growing string.
  //
  // This is not a micro-optimisation, it is the difference between linear and
  // quadratic. The `$'…'` rule below has to know whether the output currently
  // ends in `$`, and it has to be able to take that `$` back off. Asking a
  // string being built by `+=` a question about its contents forces the engine
  // to flatten it, and doing that once per quote character turns the whole
  // scan quadratic: an ordinary quote-heavy command (a long JSON payload in a
  // `curl -d`, say) measured seven seconds at 600KB and thirty-two at 1.2MB.
  // On a hook that runs on every single Bash call, with agy's fail-open
  // timeout at ten seconds (#428), that is a hang, not a slowdown — and it is
  // the same failure class that got brace expansion cut from this ticket, so
  // it does not get to ship in the part that stays.
  //
  // With chunks, appending is O(1), the "ends with `$`" question is answered
  // by a tracked boolean, and taking that `$` back off is a pop.
  const parts = [];
  // Output-position markers (#452 v2) — one per raw NUL byte dropped from
  // ordinary output, recorded as `parts.length` at the moment of the drop.
  // Used AFTER the scan finishes to build `spacedText` by pure insertion; see
  // the function-level comment above for why that ordering is what makes the
  // two readings provably segment identically.
  const nulMarkers = [];
  let endsDollar = false; // does the output currently end with `$`?
  let quote = null;    // the active quote character, or null
  let ansiC = false;   // the active single-quote region was opened as `$'…'`
  let litDollar = false; // the `$` just emitted came from `\$`, so it is DATA
  /** Append one character, keeping `endsDollar` true to the output. */
  const push = (ch) => { parts.push(ch); endsDollar = ch === '$'; };
  // A separator that survived escaping/quoting is inert as a separator, so
  // emit a space rather than the character itself — splitSegments() is blind
  // to quoting and would otherwise split the command around it.
  const emit = (ch) => push(SEPARATOR_CHARS.test(ch) ? ' ' : ch);
  // An ESCAPED character, i.e. one that appeared after a backslash. Almost all
  // of them are just data and go through emit() — but a backslash-NEWLINE is
  // bash's LINE CONTINUATION, and bash deletes BOTH bytes with no replacement,
  // joining the words on either side into ONE token. Substituting a space (as
  // emit() does for every other separator, correctly, since bash keeps those as
  // literal data) would SPLIT that token instead, so `--for\<newline>ce` would
  // normalise to `--for ce` while bash hands git a clean `--force`. That is a
  // silent miss on an entirely mundane construct — a long command wrapped over
  // several lines — not an adversarial one, which is what makes it worth the
  // special case.
  const emitEscaped = (ch) => { if (ch !== '\n') emit(ch); };
  // Every DECODED escape lands here. Anything that isn't printable ASCII
  // becomes an inert space: it cannot spell a flag, and it keeps this total —
  // String.fromCodePoint throws above U+10FFFF and `$'\UFFFFFFFF'` is
  // reachable input, while check() must never throw (AC-3.4).
  const emitCodePoint = (code) => {
    if (!Number.isInteger(code) || code < 0x20 || code > 0x7e) { push(' '); return; }
    emit(String.fromCharCode(code));
  };
  // Starting at index `j`, record a marker (and skip) every consecutive raw
  // NUL byte, then return the index of the first non-NUL character (or
  // `command.length` at end of input). This is how an unquoted backslash
  // "reaches through" a run of NULs to its real escape target — see the
  // function-level comment above for why that matches what a persistent bash
  // session actually does with this byte.
  const skipNuls = (j) => {
    while (command[j] === '\0') { nulMarkers.push(parts.length); j++; }
    return j;
  };
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    const next = command[i + 1];
    if (quote === null) {
      if (ch === '\0') {
        // A raw NUL is invisible to bash's own parser (dropped before it ever
        // runs) — delete it from the canonical output, marking its position
        // for the `spacedText` reconstruction (#452 v2).
        nulMarkers.push(parts.length);
        continue;
      }
      if (ch === '\\') {
        // Drop the backslash, consume AND emit what it escaped, so an escaped
        // quote can never be mistaken for a quoting delimiter. The target is
        // found by SKIPPING any raw NULs first (#452 v2) — a backslash
        // reaches THROUGH them to whichever real byte follows, exactly as it
        // would for a persistent bash session that never saw the dropped
        // byte(s) at all; each skipped NUL still gets its own marker.
        const j = skipNuls(i + 1);
        const target = command[j];
        // Advance PAST the skipped run either way (#452 v2 fix-wave, minor
        // finding): if the run reaches end-of-input with no real target,
        // `target` is undefined and there is nothing to escape — but `i`
        // must still land at `j - 1` so the loop's own `i++` resumes AFTER
        // the run, not on its first byte again. Leaving `i` unmoved here let
        // the top-level `ch === '\0'` case re-visit and double-mark the same
        // trailing NULs (harmless — the extra markers only add inert
        // trailing whitespace `segments()` trims away — but not what this
        // function documents: one marker per NUL).
        if (target !== undefined) { emitEscaped(target); litDollar = target === '$'; i = j; } else { litDollar = false; i = j - 1; }
        continue;
      }
      if (ch === '"' || ch === "'") {
        // `$'…'` / `$"…"`: a PRECEDING `$` is quoting syntax, not data — unless
        // it was itself escaped (`\$'…'`), in which case it is a literal `$`
        // and the quotes that follow are ordinary.
        const introducer = endsDollar && !litDollar;
        ansiC = introducer && ch === "'";
        if (introducer) {
          const oldLen = parts.length;
          parts.pop(); // drop the `$`: it was quoting syntax, not data
          endsDollar = parts[parts.length - 1] === '$';
          // A marker recorded for a NUL sitting between that `$` and this
          // quote char (e.g. `$<NUL>'`) was stamped with `oldLen` — the
          // output position immediately AFTER the `$`, which the pop() above
          // just deleted (#452 v2 fix-wave, security finding). Retroactively
          // rebase every such trailing marker down by one so it still points
          // at "immediately after whatever now precedes it", instead of
          // going stale and, worse, LARGER than a marker recorded moments
          // later at the (now shorter) `parts.length` — nulMarkers must stay
          // non-decreasing for the linear spacedText build below to be
          // correct. Markers are recorded in scan order, so any affected by
          // THIS pop are necessarily the most recent (a trailing run).
          for (let k = nulMarkers.length - 1; k >= 0 && nulMarkers[k] === oldLen; k--) nulMarkers[k] = parts.length;
        }
        quote = ch;
        litDollar = false;
        continue;
      }
      push(ch);
      litDollar = false;
      continue;
    }
    if (ch === quote) {
      // A `$` cannot carry forward as syntax-relevant across a completed
      // quote region: if the region's LAST emitted character happened to be a
      // literal `$` (e.g. `'$'`), `endsDollar` would otherwise still read
      // true here, and an immediately adjacent quote (`'$''-D'` — bash
      // concatenates adjacent quoted segments into one argument, a real idiom
      // for splicing a literal `$` next to more text) would be misread as
      // `$'…'` ANSI-C syntax introduced by that stale `$`, when the `$` was
      // just ordinary data from the quote that already closed (#437,
      // adversarial review round 3). Resetting both flags on close removes
      // the false signal at its source rather than guarding every call site
      // that opens a quote.
      quote = null;
      ansiC = false;
      endsDollar = false;
      litDollar = false;
      continue;
    }
    if (ch === '\0') {
      // Same treatment as the unquoted case above: invisible to bash's
      // parser, deleted from canonical output, marker recorded (#452 v2).
      nulMarkers.push(parts.length);
      continue;
    }
    if (ch === '\\' && next !== undefined) {
      if (ansiC) {
        // \xHH / \uHHHH / \UHHHHHHHH — hex byte or code point. The digit caps
        // are bash's own, and they matter: `\x` takes at most TWO digits, so
        // `$'\x2df'` is `-` followed by a literal `f` (i.e. `-f`), not a
        // three-digit hex escape that would swallow the flag letter.
        const hex = /^(?:x([0-9a-fA-F]{1,2})|u([0-9a-fA-F]{1,4})|U([0-9a-fA-F]{1,8}))/.exec(command.slice(i + 1));
        if (hex) {
          const digits = hex[1] ?? hex[2] ?? hex[3];
          emitCodePoint(parseInt(digits, 16));
          i += 1 + digits.length;
          continue;
        }
        // \NNN — octal. Masked to a byte, as bash does: `$'\455'` is `-`.
        const oct = /^[0-7]{1,3}/.exec(command.slice(i + 1));
        if (oct) {
          emitCodePoint(parseInt(oct[0], 8) & 0xff);
          i += oct[0].length;
          continue;
        }
        // \cX — Control-X. This branch consumes NOTHING beyond `\c` itself,
        // and that is the entire point.
        //
        // `\c` is the only escape here taking an ARBITRARY operand, so it is
        // the only one whose lookahead can reach past this region's
        // terminator. Two successive review rounds found real bypasses there:
        // first `\c` eating the closing quote outright, then — after a guard
        // was added for exactly that — `\c` eating a BACKSLASH that was itself
        // protecting the closing quote, again closing the region a character
        // early and desyncing quote state for the whole rest of the line.
        // Guarding case by case was losing: bash resolves the terminator in a
        // pass SEPARATE from decoding, and a single-pass scanner cannot mirror
        // that by accumulating exceptions.
        //
        // So this does not look ahead at all. `\cX` always evaluates to a
        // CONTROL byte, and every control byte is inert here anyway (see
        // emitCodePoint) — the operand's value cannot change the outcome.
        // Leaving it unconsumed costs nothing and lets the main loop dispatch
        // it normally, so the terminator is found by the same audited path as
        // everywhere else. That removes the bug class rather than enumerating
        // its instances. The cost is a slight over-match (`$'\cA'` leaves a
        // stray `A`), which is the safe direction and cannot spell a flag.
        if (next === 'c') {
          emitCodePoint(0x5c); emitCodePoint(0x63); // inert, per emitCodePoint
          i++;
          continue;
        }
        const simple = ANSI_C_ESCAPES[next];
        if (simple === undefined) {
          // An UNRECOGNISED escape keeps BOTH characters in bash (`$'\z'` is a
          // literal backslash-z), so preserve rather than silently drop the
          // backslash — dropping it invents a character the shell never made.
          emitCodePoint(0x5c);
          emitCodePoint(next.codePointAt(0));
        } else {
          emitCodePoint(simple.codePointAt(0));
        }
        i++;
        continue;
      }
      // Inside double quotes a backslash is an escape only for this small set;
      // inside ordinary single quotes it is always literal. Note the newline is
      // IN that set: line continuation is honoured inside double quotes too, so
      // this needs the same word-joining treatment as the unquoted branch.
      if (quote === '"' && /["$`\\\n]/.test(next)) {
        emitEscaped(next);
        i++;
        continue;
      }
    }
    emit(ch);
  }
  const text = parts.join('');
  // `spacedText`: insert one space at every recorded marker position, in a
  // single linear pass (never repeated slicing — same O(n²) trap this file's
  // own chunked-`parts` design exists to avoid, see the comment above). Pure
  // insertion into the ALREADY-FINAL `text`, never a second parse — see the
  // function-level comment above for why that is what makes the two texts
  // provably segment identically.
  //
  // ONE marker position needs adjusting first (#452 v2 fix-wave, critical
  // finding): `segments()` treats `&&` as a single TWO-character separator
  // with NO single-character fallback — unlike `||`, where a lone `|` is
  // ALSO independently in the single-char separator class `[;|\n]`, so
  // splitting `||` into `| |` still produces the same final segment count
  // (the extra empty piece between the two now-separate matches is trimmed
  // and filtered by `segments()`, converging back to the original count). A
  // marker landing BETWEEN the two `&` characters has no such fallback:
  // inserting a space there turns an intact `&&` (one split point in `text`)
  // into `& &` (ZERO split points in `spacedText`, since a lone `&` matches
  // neither alternative), silently DROPPING a split rather than adding a
  // filtered-away extra one — which shifts every later segment's index out
  // from under `spacedText`'s array relative to `text`'s, handing
  // `recursive-delete` an unrelated, attacker-chosen LATER segment as its
  // `cSpaced` argument instead of merely a shorter/misordered array (the
  // failure mode confirmed by adversarial security review). Fixed by
  // pushing any such marker forward past the WHOLE run of `&` characters —
  // never inserting a space where it could split one of them apart — so the
  // extra space lands harmlessly just after the operator instead.
  //
  // A SECOND position needs the same treatment, found by a follow-up
  // adversarial pass: `recursive-delete`'s own `safeRmTarget()` reads
  // `spacedText` (not `segments()`) and does its OWN exact-string match,
  // `t === '--'` (POSIX end-of-options, #450), against `spacedText`'s
  // whitespace-split tokens. A marker landing between the two `-` characters
  // of a standalone `--` token splits it into `- -`, so that match never
  // fires, `endOfOptions` never latches, and the real dash-led target right
  // after it gets misread as a bare flag and filtered out of judgement —
  // the same failure shape as the `&&` case, in a different consumer.
  //
  // UNLIKE `&&`, this one must be scoped to a STANDALONE token — bounded by
  // IFS whitespace (or string start/end) on BOTH sides — not any run of `-`
  // characters wherever it appears. `&&` is safe to push past unconditionally
  // because `segments()` only ever MERGES two would-be segments into one
  // (over-merging is this file's own stated safe direction: a destructive
  // command is still fully contained in whichever segment it ends up in).
  // A blanket dash-run push does not have that safety net: pushing a marker
  // past an ARBITRARY `--` inside a longer word (`prod<NUL>-secrets` is not
  // `prod--secrets` unless the run happens to canonicalise to two dashes,
  // but e.g. `temp--data` legitimately contains one) would instead SPLIT one
  // real target into two pieces at a position `safeRmTarget()` never asked
  // for, and the piece that happens to start with `-` gets filtered OUT of
  // judgement entirely by the very same flag-skipping this rule relies on —
  // trading the bypass being closed here for a new one that drops a target
  // from judgement instead of merely re-segmenting harmlessly. Restricting
  // to a whitespace-bounded `--` token matches EXACTLY what
  // `safeRmTarget()`'s own IFS split would treat as one piece, so nothing
  // outside that exact shape is touched.
  const isIfsBoundary = (ch) => ch === undefined || ch === ' ' || ch === '\t' || ch === '\n';
  // `ampRunEnd[p]` answers "where would the `&`-run walk starting at `p`
  // stop?" in O(1) — precomputed with ONE backward linear pass rather than
  // walked per marker (adversarial review, performance finding): a per-marker
  // `while` walk is O(run length) each, so a command with many NULs inside
  // ONE long run of `&` characters was O(n²) overall — measured at ~10s for
  // an 80KB input, exceeding agy's own documented fail-open timeout (#428)
  // and reopening the exact hang-vs-bypass tradeoff this file's chunked-parts
  // design (see the O(1)-append comment above) already had to solve once.
  // `ampRunEnd[p] = p` when `p` isn't inside a run boundary; otherwise it
  // equals whatever the NEXT position's answer is — computed back-to-front
  // so each position is visited exactly once.
  const ampRunEnd = new Array(text.length + 1);
  ampRunEnd[text.length] = text.length;
  for (let p = text.length - 1; p >= 0; p--) {
    ampRunEnd[p] = (text[p - 1] === '&' && text[p] === '&') ? ampRunEnd[p + 1] : p;
  }
  const adjustedMarkers = nulMarkers.map((p) => {
    let pos = ampRunEnd[p];
    if (text[pos - 1] === '-' && text[pos] === '-' && isIfsBoundary(text[pos - 2]) && isIfsBoundary(text[pos + 1])) pos++;
    return pos;
  });
  let spacedText = text;
  if (adjustedMarkers.length > 0) {
    const spacedParts = [];
    let mi = 0;
    for (let p = 0; p <= text.length; p++) {
      while (mi < adjustedMarkers.length && adjustedMarkers[mi] === p) { spacedParts.push(' '); mi++; }
      if (p < text.length) spacedParts.push(text[p]);
    }
    spacedText = spacedParts.join('');
  }
  return { text, spacedText };
}

// Every rule's `test()` reads `text` (the canonical parse — quotes stripped,
// escapes resolved, a raw NUL byte deleted) as its segment argument (#452
// v2). Only `recursive-delete` reads a SECOND argument, `spacedText`'s
// corresponding segment, for its own target-parsing (see its own comment
// below) — every other rule ignores the second argument entirely.
export const RULES = [
  {
    name: 'force-push',
    // git has FOUR documented ways to force-update a published ref, and this
    // rule historically matched only the first two spellings (#429). Each of
    // the others was a real forced push that slipped through — and, once the
    // #429 allowlist began granting `allow` to anything starting `git push `,
    // slipped through *silently*. All four:
    //   1. long   `--force`      (but NOT --force-with-lease/--force-if-includes,
    //                             the sanctioned safer idioms)
    //   2. short  `-f`, INCLUDING bundled clusters — git's parse-options bundles
    //             short booleans the way `git commit -am` does, so `git push -uf`
    //             forces just as much as `-f`
    //   3. `--mirror` — force-updates EVERY ref under refs/ and DELETES remote
    //             refs absent locally; strictly worse than a single --force
    //   4. a leading `+` on the refspec (`git push origin +main`, `+src:dst`) —
    //             documented force syntax, previously caught only by accident
    //             when a protected-branch name happened to appear (env-branch-
    //             delete's `:` + PROTECTED_BRANCHES), so `+trunk:trunk` sailed past
    // Short-flag collection uses the same technique as recursive-delete below:
    // the `(?:^|\s)-` anchor keeps long `--force-*` flags and mid-word dashes
    // (`feat-f`) out of the cluster so neither can spoof (or dodge) a short flag.
    test: (c) => {
      if (!/\bgit\b[^\n]*\bpush\b/.test(c)) return false;
      if (/\s--force\b(?!-with-lease|-if-includes)/.test(c)) return true;
      // --mirror IS abbreviable (unlike --force above): `git push --mir` really
      // does mirror — verified against live git, it pushed every branch AND tag
      // with no refspec given. Matching only the full spelling left the exact
      // abbreviation class #429 identified as unclosable-by-enumeration wide
      // open in the very rule #429 hardened (#437, adversarial review).
      if (PUSH_MIRROR.test(c)) return true;
      if (/(?:^|\s)\+\S/.test(c)) return true;
      // Alphanumeric, not alpha-only: `git push -4f` bundles the IPv4 flag with
      // -f and really does force-update (verified against live git), but an
      // [a-zA-Z]-only cluster scan misses it because the digit breaks the run.
      if (/f/.test(shortFlagCluster(c, { alnum: true }))) return true;
      // #448: brace expansion can complete --force/-f/--mirror/+refspec from
      // text none of the checks above would ever match literally — detect
      // the brace, don't try to resolve it (see hasFlagBrace()).
      return hasFlagBrace(c);
    },
    msg: 'git push force-update (--force, bundled -f, --mirror, or a +refspec) rewrites published history',
  },
  {
    name: 'env-branch-delete',
    // `git push` accepts `-d` as the literal short form of `--delete` (`git push
    // -h`); the old regex checked only `--delete` and a bare `:` refspec, so
    // `git push -d origin main` — a real, immediate remote branch delete —
    // wasn't just a spelling gap, it slipped past denylist AND force-push both
    // (#437). `git branch` accepts `-D`, or the equivalent `-d`+`-f` pairing in
    // ANY spelling/order/bundling (short `-fd`/`-df`, long `--delete --force` /
    // `--force --delete`, a long/short mix, or `-D` itself bundled with another
    // short flag like `-Dq`/`-qD`) — verified empirically against git 2.55:
    // `git branch -fd <unmerged>` and `git branch --delete --force <unmerged>`
    // both force-delete exactly like `-D`, and the old regex matched only the
    // literal, unbundled `-D` token. Long-form ABBREVIATIONS are covered too,
    // at each verb's own empirically-measured ambiguity boundary (see the
    // longFlag/abbrev constants above): `git push --de`, `git branch --d`, and
    // `git branch --forc` are all accepted by real git and now all match.
    test: (c) => {
      if (!PROTECTED_BRANCHES.test(c)) return false;
      if (/\bgit\b[^\n]*\bpush\b/.test(c)) {
        if (PUSH_DELETE.test(c) || /:/.test(c)) return true;
        if (/d/.test(shortFlagCluster(c, { alnum: true }))) return true;
        // #448: e.g. `git push -{d,} origin main` on a protected branch.
        if (hasFlagBrace(c)) return true;
      }
      if (/\bgit branch\b/.test(c)) {
        const cluster = shortFlagCluster(c, { alnum: true });
        if (/D/.test(cluster)) return true; // -D, incl. bundled (-Dq / -qD), IS delete+force
        const hasForce = /f/.test(cluster) || BRANCH_FORCE.test(c);
        const hasDelete = /d/.test(cluster) || BRANCH_DELETE.test(c);
        if (hasForce && hasDelete) return true;
        // #448: e.g. `git branch -{D,} main` — brace-completed -D/-d/-f.
        if (hasFlagBrace(c)) return true;
      }
      return false;
    },
    msg: 'deleting main/environment branches is never agent work',
  },
  {
    name: 'hard-reset',
    // `git reset`'s own long-option set (`git reset -h`, verified against git
    // 2.55) has exactly ONE option starting with "h" — --hard — so --h/--ha/
    // --har/--hard are all UNAMBIGUOUS abbreviations git itself accepts (parse-
    // options prefix matching, the same rule that makes `git push --mir` mean
    // `--mirror`, #429). The old regex additionally required --hard immediately
    // after `reset` with only whitespace between them, so `git reset --quiet
    // --hard` — an equally irrecoverable hard reset — slipped through because
    // --quiet sat in the way (#437). Fixed on both axes: "reset" may be followed
    // by any other flags in any order before --hard appears, AND any
    // unambiguous prefix of --hard matches, not just the full spelling.
    //
    // Rebuilt on the same abbrev()/longFlag() helpers as the other three
    // rules (#437 review, minor finding): this used to hand-roll its own
    // `--h(?:a(?:r(?:d)?)?)?\b` instead of reusing them, the exact duplication
    // AC.4 otherwise consolidated. Two small, both SAFE-direction deltas from
    // the old regex, found by re-review and stated precisely rather than
    // claimed away: (1) `\b` vs. `longFlag`'s `(?![\w-])` diverge on a
    // hyphen-continued, non-existent flag like `--hard-core` — the old regex
    // blocked it, this one doesn't, but no real `git reset` flag starts with
    // "hard-", so nothing that actually resets anything stops being caught;
    // (2) splitting into two ANDed regexes drops the old requirement that
    // `--hard` appear textually AFTER `reset`, so `git --hard reset` now also
    // matches, which is strictly MORE caught, never less.
    // #448: `git reset --h{a,}rd` etc. — brace-completed --hard.
    test: (c) => /\bgit\b[^\n]*\breset\b/.test(c) && (HARD_RESET.test(c) || hasFlagBrace(c)),
    msg: 'git reset --hard discards work irrecoverably',
  },
  {
    name: 'git-clean-force',
    // Audited for the #437 adjacency/spelling class: NOT anchored to be
    // adjacent to `clean` (the `[^\n]*` already spans any other flags in any
    // order — `git clean -n -f`, `git clean --interactive --force` both match
    // today), and `-[a-zA-Z]*f` already matches any bundled short cluster ending
    // in `f` (`-xdf`, `-df`) AND the long `--force` (its own "0 letters between
    // the dash and a literal f" case fires immediately on `--f...`, so any
    // prefix of --force matches too, not just the full word). No reordering,
    // bundling, or abbreviation gap found; left unchanged.
    test: (c) => /\bgit\b[^\n]*\bclean\b[^\n]*-[a-zA-Z]*f/.test(c),
    msg: 'git clean -f deletes untracked files irrecoverably',
  },
  {
    name: 'history-rewrite',
    // Audited for the #437 class: filter-branch/filter-repo are SUBCOMMAND/
    // binary names, not flags — git does not abbreviate those, so there is no
    // abbreviation surface here the way there is for a flag like --hard. Left
    // unchanged; `git-filter-repo --path x` (the standalone-binary invocation
    // form, no `git ` prefix word) is already caught because the hyphen in
    // "git-filter-repo" is a non-word char, so `\bgit\b` still matches "git" as
    // a whole word inside it.
    test: (c) => /\bgit\b[^\n]*\b(filter-branch|filter-repo)\b/.test(c),
    msg: 'history rewriting is escalation-only (secrets are scrubbed by rotation, not rewrites — spec §4 respond)',
  },
  {
    name: 'recursive-delete',
    // The one rule reading `spacedText` as well as `text` (#452 v2): `c` (the
    // canonical, NUL-deleted segment — same argument every other rule reads)
    // drives flag-cluster detection, so `-r<NUL>f` still collects as a
    // bundled `rf` the way a real shell's dropped-byte behaviour would hand
    // `rm` the intact `-rf`. `cSpaced` — that SAME segment's spacedText
    // reading — drives target parsing ONLY, so #446's target-splice fix
    // (`/prod-secrets<NUL>/scratchpad` judged as two tokens, not one fused
    // path ending in the safe word `scratchpad`) keeps working unchanged;
    // AC-446.6's pinned tests need no edits.
    test: (c, cSpaced) => {
      if (!/\brm\b/.test(c)) return false;
      // Collect single-dash SHORT flag clusters (e.g. -rf, -Rf) via the shared
      // helper. Deliberately alpha-only (default) where force-push above
      // passes `alnum: true`: git has numeric short flags (`-4`) that can
      // bundle with `-f`, `rm` has none, so widening here would buy nothing.
      const shortFlags = shortFlagCluster(c);
      // Recursive via short -r/-R OR the long --recursive; force via short -f OR
      // long --force. Both required (AC-312.1), in any order.
      const recursive = /[rR]/.test(shortFlags) || /\B--recursive\b/.test(c);
      const force = /f/.test(shortFlags) || /\B--force\b/.test(c);
      // #448: a brace-group in a flag-shaped token (e.g. `-r{f,}`, `--forc{e,}`)
      // could complete EITHER requirement without spelling it literally, and
      // detect-and-refuse does not classify which one — so its presence
      // satisfies whichever of the two isn't already literally satisfied,
      // rather than requiring both to already be true before it is even
      // consulted. A command with no brace at all falls straight through to
      // the pre-existing literal-only check, unchanged.
      const braceFlag = hasFlagBrace(c);
      if (!(recursive || braceFlag) || !(force || braceFlag)) return false;
      const rest = cSpaced.slice(cSpaced.indexOf('rm'));
      // EVERY target must be safe, not merely one of them (#446) — see
      // safeRmTarget(): a single safe-looking decoy argument used to exempt
      // the whole command, however many real targets sat beside it.
      return !safeRmTarget(rest);
    },
    msg: 'rm -rf (incl. --recursive --force) outside build/temp dirs',
  },
  // The two rules below run against the FULL command string (scope: 'full'), NOT
  // per-segment — segments() deliberately splits on the pipe, which is exactly the
  // separator a pipe-to-shell RCE hides behind. Splitting can't defeat a full-string
  // match. Both are anchored to the interpreter/substitution consuming the payload so
  // benign pipelines (grep | wc -l, cat | base64) do not trip them (#311).
  {
    name: 'pipe-to-shell',
    scope: 'full',
    test: (c) => PIPE_INTO_INTERP.test(c) && FETCH_OR_DECODE.test(c),
    msg: 'piping a downloaded or decoded payload into a shell interpreter is remote code execution',
  },
  {
    name: 'eval-exec',
    scope: 'full',
    test: (c) => /\beval\b/.test(c) && SUBSTITUTION.test(c),
    msg: 'eval of a command-substitution or decoded payload executes untrusted code',
  },
];

// A pipe whose CONSUMING command is a shell interpreter: `… | sh`, `… | sudo bash`,
// `… | /bin/zsh -s`. Anchored to the interpreter directly after the pipe so an
// unrelated `.sh` filename later in the line (`… | tee notes.sh`) is not a match.
const PIPE_INTO_INTERP = /\|\s*(?:sudo\s+)?(?:\S*\/)?(?:sh|bash|zsh|dash|ash|ksh)\b/;
// The upstream half: a network downloader OR a decoder feeding that interpreter.
const FETCH_OR_DECODE = /\b(?:curl|wget|fetch|base64)\b/;
// Command-substitution / backtick payload that eval would execute untrusted.
const SUBSTITUTION = /\$\(|`/;

/**
 * Split a command line into sub-commands on shell separators (&& || ; | newline)
 * so each rule tests ONE sub-command, not the whole string. Without this a benign
 * chained call false-positives — e.g. `git push … && gh api graphql -f query=…`
 * tripped force-push because `git push` and an unrelated `-f` were both present
 * somewhere in the string (#85). Over-splitting is safe: a destructive command is
 * still fully contained in its own segment.
 *
 * The splitter itself lives in one shared module (#320) so this copy and the
 * capture hook's copy can't drift; re-exported here under the historical `segments`
 * name that tests and importers already depend on.
 */
export { splitSegments as segments } from '../scripts/lib/shell-split.mjs';
import { splitSegments as segments } from '../scripts/lib/shell-split.mjs';
// The escalate message is single-sourced (#321) so this hook and the agy deny shim
// cannot drift the wording again; both import escalateMessage() with zero side effects.
import { escalateMessage } from '../scripts/lib/escalate-msg.mjs';

export function check(command) {
  if (typeof command !== 'string' || command.length === 0) return { blocked: false };
  // Undo shell quoting/escaping BEFORE matching, so a quoted or backslash-
  // escaped flag token can't hide a destructive spelling from every rule at
  // once (#437). This runs ahead of the split on purpose: it also neutralises
  // separators sitting inside quotes, which is what stops a quoted `;` from
  // fragmenting a command away from its own flag.
  //
  // Guarded, falling back to the RAW command, because the alternative to this
  // fallback is not "a smaller match" but NO match at all: check() is
  // documented never to throw, handle() does not wrap it, and the agy shim
  // imports it directly — so a throw would escape uncaught and the
  // process-level fail-open would let the command run unchecked. That is
  // strictly worse than any spelling bypass, since it needs nothing hidden.
  // The raw text still runs through every rule, so a literally-spelled
  // destructive command still blocks. normalizeShellText() is a single linear
  // scan with no recursion, so this should be unreachable — but "should be
  // unreachable" is exactly the reasoning that failed twice on this branch,
  // and the guard costs nothing.
  let text, spacedText;
  try {
    ({ text, spacedText } = normalizeShellText(command));
  } catch {
    text = command;
    spacedText = command;
  }
  const segs = segments(text);
  // `segsSpaced` is PROVABLY the same length/order as `segs` — spacedText is
  // built from text by pure character insertion at positions that are never
  // one of the `;|&\n` separators segments() splits on (#452 v2; see
  // normalizeShellText()'s function-level comment for the full argument, and
  // the AC-452.5 regression test for empirical pins). The `?? seg` fallback
  // below is therefore defensive only, never load-bearing.
  const segsSpaced = segments(spacedText);
  for (const rule of RULES) {
    // scope:'full' rules test the whole command (pipe-to-shell hides in the pipe
    // that segments() splits on); all others test each split sub-command. Every
    // rule's test() gets `text`'s segment as its first argument and the
    // corresponding `spacedText` segment as its second — only `recursive-delete`
    // reads the second at all (its own target-parsing, see its own comment).
    const hit = rule.scope === 'full'
      ? rule.test(text, spacedText)
      : segs.some((seg, i) => rule.test(seg, segsSpaced[i] ?? seg));
    if (hit) return { blocked: true, rule: rule.name, msg: rule.msg };
  }
  return { blocked: false };
}

/** Verdict + journal in one testable place; a journal failure never changes the verdict. */
export async function handle(payload, appendFn) {
  if (payload?.tool_name !== 'Bash') return { code: 0 };
  const cmd = payload.tool_input?.command ?? '';
  const res = check(cmd);
  if (!res.blocked) return { code: 0 };
  try {
    // learning-loop evidence (spec §8)
    await appendFn(payload.cwd ?? process.cwd(), 'blocked-edit', { tool: 'Bash', cmd: cmd.slice(0, 300), rule: res.rule });
  } catch { /* still block below */ }
  return {
    code: 2,
    message: escalateMessage(res.rule, res.msg),
  };
}

async function main() {
  let raw = '';
  for await (const chunk of process.stdin) raw += chunk;
  const { append } = await import('../scripts/lib/journal.mjs');
  const res = await handle(JSON.parse(raw), append);
  if (res.message) process.stderr.write(res.message);
  return res.code;
}

// Self-exec guard is ANCHORED to the basename (AC-289.3): only fire main() when
// THIS file is the entry point. The old `/denylist\.mjs$/` was unanchored and
// re-fired on import from any `*denylist.mjs` importer, consuming its stdin — the
// agy PreToolUse shim depends on importing check() with zero side effects.
const isHookRun = process.argv[1] && /(^|[\\/])denylist\.mjs$/.test(process.argv[1]);
if (isHookRun) main().then((code) => process.exit(code)).catch(() => process.exit(0)); // fail open
