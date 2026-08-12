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

const SAFE_RM_TARGETS = /(node_modules|\.forge|dist|build|coverage|te?mp|\$TMP|\$TEMP|scratchpad)/i;
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
 *     A `$` anywhere else is untouched, so `$TMP` still matches SAFE_RM_TARGETS
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

function normalizeShellText(rawCommand) {
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
  const command = rawCommand.replace(/\r/g, '');
  let out = '';
  let quote = null;    // the active quote character, or null
  let ansiC = false;   // the active single-quote region was opened as `$'…'`
  let litDollar = false; // the `$` just emitted came from `\$`, so it is DATA
  // A separator that survived escaping/quoting is inert as a separator, so
  // emit a space rather than the character itself — splitSegments() is blind
  // to quoting and would otherwise split the command around it.
  const emit = (ch) => { out += SEPARATOR_CHARS.test(ch) ? ' ' : ch; };
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
    if (!Number.isInteger(code) || code < 0x20 || code > 0x7e) { out += ' '; return; }
    emit(String.fromCharCode(code));
  };
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    const next = command[i + 1];
    if (quote === null) {
      if (ch === '\\') {
        // Drop the backslash, consume AND emit what it escaped, so an escaped
        // quote can never be mistaken for a quoting delimiter.
        if (next !== undefined) { emitEscaped(next); litDollar = next === '$'; i++; } else litDollar = false;
        continue;
      }
      if (ch === '"' || ch === "'") {
        // `$'…'` / `$"…"`: a PRECEDING `$` is quoting syntax, not data — unless
        // it was itself escaped (`\$'…'`), in which case it is a literal `$`
        // and the quotes that follow are ordinary.
        const introducer = out.endsWith('$') && !litDollar;
        ansiC = introducer && ch === "'";
        if (introducer) out = out.slice(0, -1);
        quote = ch;
        litDollar = false;
        continue;
      }
      out += ch;
      litDollar = false;
      continue;
    }
    if (ch === quote) { quote = null; ansiC = false; continue; }
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
  return out;
}

/** An INNERMOST brace group — no nested braces, so recursion handles the rest. */
const INNER_BRACE_GROUP = /\{([^{}]*)\}/g;
/** `{a..e}` / `{1..9}`: bash expands a SEQUENCE with no comma anywhere. */
const CHAR_RANGE = /^([A-Za-z])\.\.([A-Za-z])$/;
const NUM_RANGE = /^(-?\d{1,7})\.\.(-?\d{1,7})$/;
/** Hard cap on generated words, so a nested `{a,b}{a,b}…` cannot blow up. */
const BRACE_BUDGET = 32;
/** Cap on one range's length; `{1..100000}` must not materialise. */
const RANGE_CAP = 64;

/**
 * The alternatives a brace group expands to, or null if bash would leave it
 * alone. Comma form OR range form — the range form matters because it needs no
 * comma at all, so a comma-only check misses it entirely: `--forc{d..e}` really
 * does hand git `--force` (verified against both shells here), and `-{e..f}`
 * really does hand it `-f`.
 *
 * Returning null for everything else is what keeps `-f query='mutation{...}'`
 * — an ordinary `gh api` argument that #85 already pins — literal, exactly as
 * bash leaves it.
 */
function braceAlternatives(body) {
  if (body.includes(',')) return body.split(',');
  const chars = CHAR_RANGE.exec(body);
  if (chars) {
    const from = chars[1].codePointAt(0);
    const to = chars[2].codePointAt(0);
    const step = from <= to ? 1 : -1;
    const out = [];
    for (let c = from; out.length < RANGE_CAP; c += step) {
      out.push(String.fromCharCode(c));
      if (c === to) break;
    }
    return out;
  }
  const nums = NUM_RANGE.exec(body);
  if (nums) {
    const from = Number(nums[1]);
    const to = Number(nums[2]);
    const step = from <= to ? 1 : -1;
    const out = [];
    for (let n = from; out.length < RANGE_CAP; n += step) {
      out.push(String(n));
      if (n === to) break;
    }
    return out;
  }
  return null;
}

/**
 * Expand ONE word's brace groups into the words bash would produce, e.g.
 * `--forc{e,}` -> `--force --forc`.
 *
 * The budget is divided EVENLY across a group's alternatives rather than
 * consumed first-come-first-served, and that detail is load-bearing: a
 * first-come budget lets an attacker starve the expander deliberately. Pad a
 * group with cheap alternatives ahead of the dangerous one — bash still
 * delivers the dangerous one as a real standalone argument — and a
 * first-come budget runs out before generating it. Splitting the budget
 * guarantees every alternative is represented by at least one word, so no
 * alternative's text can be dropped no matter where it sits or how many
 * precede it. Depth is bounded implicitly: each level divides the budget, so
 * nesting stops expanding once a branch's share reaches one.
 */
function expandBraces(word, budget = BRACE_BUDGET) {
  if (budget <= 1 || !word.includes('{')) return [word];
  INNER_BRACE_GROUP.lastIndex = 0;
  let m;
  while ((m = INNER_BRACE_GROUP.exec(word)) !== null) {
    const alts = braceAlternatives(m[1]);
    if (alts === null) continue; // literal group (e.g. `{...}`), keep scanning
    const pre = word.slice(0, m.index);
    const post = word.slice(m.index + m[0].length);
    const share = Math.max(1, Math.floor(budget / alts.length));
    const out = [];
    for (const alt of alts) out.push(...expandBraces(pre + alt + post, share));
    return out.length > 0 ? out : [word];
  }
  return [word];
}

/**
 * Apply brace expansion across a normalised command (#437, found while
 * sweeping for further places this file's view of a command diverges from the
 * argv the shell really delivers — the question that produced the last several
 * findings).
 *
 * Why it is needed: brace expansion can COMPLETE a flag the text never spells.
 * `git push --forc{e,} origin main` hands git a real `--force`, and
 * `rm -r{f,} /opt/danger` a real `-rf`, while the literal text contains
 * neither — verified against both shells on this machine.
 *
 * Why it is a SEPARATE pass, deliberately: every previous bug on this branch
 * came from adding cases to the quote/escape state machine, where a mistake
 * desynchronises everything after it. This runs afterwards, over the finished
 * text, and cannot affect that machine at all. The cost of that choice is that
 * it no longer knows what was quoted, so a QUOTED brace group — literal to
 * bash — is expanded here too. That over-matches, which is the safe direction
 * and consistent with how this file already treats quoted mentions.
 *
 * `\S+` preserves every whitespace character exactly, including the newlines
 * and separators splitSegments() relies on; only the non-whitespace runs are
 * rewritten.
 */
function expandBraceWords(text) {
  if (!text.includes('{')) return text; // the overwhelmingly common case
  return text.replace(/\S+/g, (word) => expandBraces(word).join(' '));
}

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
      return /f/.test(shortFlagCluster(c, { alnum: true }));
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
      }
      if (/\bgit branch\b/.test(c)) {
        const cluster = shortFlagCluster(c, { alnum: true });
        if (/D/.test(cluster)) return true; // -D, incl. bundled (-Dq / -qD), IS delete+force
        const hasForce = /f/.test(cluster) || BRANCH_FORCE.test(c);
        const hasDelete = /d/.test(cluster) || BRANCH_DELETE.test(c);
        if (hasForce && hasDelete) return true;
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
    test: (c) => /\bgit\b[^\n]*\breset\b[^\n]*(?:^|\s)--h(?:a(?:r(?:d)?)?)?\b/.test(c),
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
    test: (c) => {
      if (!/\brm\b/.test(c)) return false;
      // Collect single-dash SHORT flag clusters (e.g. -rf, -Rf) via the shared
      // helper. Deliberately alpha-only (default) where force-push above passes
      // `alnum: true`: git has numeric short flags (`-4`) that can bundle with
      // `-f`, `rm` has none, so widening here would buy nothing.
      const shortFlags = shortFlagCluster(c);
      // Recursive via short -r/-R OR the long --recursive; force via short -f OR
      // long --force. Both required (AC-312.1), in any order.
      const recursive = /[rR]/.test(shortFlags) || /\B--recursive\b/.test(c);
      const force = /f/.test(shortFlags) || /\B--force\b/.test(c);
      if (!recursive || !force) return false;
      const rest = c.slice(c.indexOf('rm'));
      return !SAFE_RM_TARGETS.test(rest);
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
  // Then expand brace groups, which can COMPLETE a flag the literal text never
  // spells (`--forc{e,}` reaches git as `--force`). Deliberately a separate,
  // later pass over the finished text rather than another case inside the
  // state machine above — see expandBraceWords().
  const normalized = expandBraceWords(normalizeShellText(command));
  const segs = segments(normalized);
  for (const rule of RULES) {
    // scope:'full' rules test the whole command (pipe-to-shell hides in the pipe
    // that segments() splits on); all others test each split sub-command.
    const hit = rule.scope === 'full' ? rule.test(normalized) : segs.some((seg) => rule.test(seg));
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
