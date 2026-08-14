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
 * The sentinel character `guardedText` substitutes for a PROTECTED (quoted
 * or escaped) whitespace/`$`/`(`/`)`/backtick — see `normalizeShellText()`'s
 * own comment on `guardedText`. Shared as a named constant (rather than an
 * inline literal in two places) so `beforeEndOfOptions()`'s masking and
 * `recursive-delete`'s own "is this segment even safe to trust the
 * end-of-options parse on at all" gate (see that rule's comment, #454 fix
 * wave 6) can never drift to different characters.
 */
const GUARD_SENTINEL = '\x01';

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
 * The portion of a command BEFORE a bare `--` token (#454, AC-454.5).
 *
 * POSIX end-of-options means every token after a standalone `--` is a
 * filename, never a flag, no matter how flag-like it looks — `rm -- -rf
 * target` deletes a literal file named "-rf" (non-recursively, non-forcibly),
 * it does not enable `-r`/`-f`. `recursive-delete`'s flag detection
 * (`shortFlagCluster()` and the `--recursive`/`--force` regexes) used to scan
 * the WHOLE segment, so a flag-shaped token planted after `--` still tripped
 * them and over-blocked a command that, read as real argv, does nothing
 * dangerous. This mirrors `safeRmTarget()`'s own `--` handling for the TARGET
 * half of the same rule (#450) — same marker, same bash-IFS token split
 * (space/tab/newline, not JS's wider `\s`; see that function's longer note on
 * why), applied to the flag half instead. Everything from the marker onward
 * is dropped; a command with no `--` at all is returned unchanged.
 *
 * NESTING-AWARE, and not by accident: the full-branch adversarial review of
 * the first version of this function found a real bypass, not a cosmetic
 * one. A flat whitespace-token scan cannot tell a TOP-LEVEL `--` from one
 * sitting inside a command substitution — `rm $(cat -- flagfile) -rf
 * /important-template-configs` puts a `--` that belongs entirely to the
 * INNER `cat` invocation before the real `-rf`, which is genuinely never
 * end-of-options for `rm` at all. The flat scan cut the string right after
 * that inner `--`, before the real `-rf` it was supposed to see, and the
 * rule returned not-blocked for a live, dangerous `rm -rf`. Verified: `main`
 * (pre-this-fix) correctly blocks `rm $(cat -- flagfile) -rf
 * /important-template-configs` and `` rm `cat -- flagfile` -rf
 * /important-template-configs ``; the flat-scan version of this function
 * wrongly allowed both.
 *
 * Fixed by tracking `$(...)`/backtick nesting depth (the same substitution
 * forms `eval-exec`'s own SUBSTITUTION regex already treats as one unit) and
 * only recognising a `--` as the end-of-options marker at depth 0. Consumed
 * depth changes take priority over the marker check on the very same
 * character position, so a `--` that starts exactly where `$(`/`` ` `` closes
 * is still read as inside. Ambiguity always resolves toward STILL scanning
 * for flags past the point in doubt (an unterminated `$(` with no matching
 * `)` never returns to depth 0, so the marker search simply finds nothing
 * and the whole command is returned unchanged) — the safe direction for a
 * denylist that fails open, never the direction that could hide a flag.
 *
 * `guarded` (#454 AC-454.5, second fix wave) is `command`'s own segment of
 * `guardedText` — the SAME text, character-for-character, except a
 * PROTECTED character (one that came from inside a quote or an escape, per
 * `normalizeShellText()`'s `bare` tracking) is replaced by a sentinel
 * wherever it is one this function treats as syntactically meaningful:
 * whitespace, `$`, `(`, `)`, and `` ` ``. The boundary checks AND the
 * nesting-depth tracker below both read `guarded`, not `command` — see
 * `guardedText`'s own comment for the full whitespace-boundary finding this
 * closes (`rm 'X --' -rf /important-template-configs`, a quoted space
 * mistaken for a real separator).
 *
 * The nesting tracker reading `guarded` too is itself a fix-wave finding, not
 * part of the original design: a full-branch adversarial re-review found
 * that counting `$(`/`)`/`` ` `` on raw `command` — even after `guarded` was
 * introduced for the whitespace check — still had a bypass, because a
 * close-paren or backtick that originated INSIDE A QUOTE (ordinary literal
 * data passed as an argument to the INNER command, e.g. `cat`'s own quoted
 * `')'` argument) is indistinguishable from a genuine syntactic one once
 * `normalizeShellText()` has already stripped the quote characters. That let
 * `rm $(cat ')' -- flagfile) -rf /important-secrets` prematurely decrement
 * `parenDepth` back to 0 at the quoted `)`, misreading the INNER command's
 * own `--` as the outer `rm`'s end-of-options marker and truncating flag
 * detection before the real, live `-rf` — verified to reproduce (`main`
 * blocks it; this function's `guarded`-for-whitespace-only version wrongly
 * allowed it). Masking a PROTECTED `$`/`(`/`)`/`` ` `` is the correct model,
 * not merely a defensive widening: single quotes suppress `$(...)`
 * expansion entirely in real bash (that content is genuinely inert data,
 * never substitution syntax), and `normalizeShellText()`'s own quote
 * tracking already runs uniformly through `$(...)`'s content since it has no
 * concept of substitution grouping — so a quote opened inside `$(...)` (as
 * `cat`'s own argument quoting) is tracked exactly the same way, and
 * `bare[i]` is already correct for it with no new tracking needed.
 *
 * The `--`-vs-`ch==='-'` hyphen check itself still reads `command`, not
 * `guarded`: hyphens are never masked, since a QUOTED flag is still a real
 * flag to the invoked program (see `guardedText`'s comment) and masking one
 * would trade this false negative for a different one.
 *
 * Depth counts EVERY bare `(`, not only one immediately preceded by `$`
 * (fifth fix-wave finding, full-branch adversarial re-review): the earlier
 * `$(`-only version incremented depth solely on a genuine command-
 * substitution open, but decremented on ANY `)` at depth > 0 regardless of
 * which `(` it structurally closed — so a bare paren construct nested
 * INSIDE an outer `$(...)`/backtick region (a subshell `(cmd)`, or process
 * substitution `<(cmd)`/`>(cmd)`, neither preceded by `$`) was never counted
 * going in, but its matching `)` still decremented the counter coming out,
 * returning `parenDepth` to 0 one level too shallow while genuinely still
 * inside the outer substitution. `rm $(cat <(true) -- ) -rf
 * /important-secrets` exploited exactly this: the inner `<(true)`'s own `)`
 * wrongly zeroed the depth, so the `--` right after it (still, per real
 * bash, inside the outer `$(...)`) was misread as the real end-of-options
 * marker — truncating flag detection before the real, live `-rf`. Verified
 * against real bash (`set -x`) that the whole `$(...)` here expands to
 * nothing (the inner process substitution produces empty output), so the
 * ACTUAL argv reaching `rm` is `-rf /important-secrets` — a genuine
 * recursive-force delete. `main` blocks it; the `$(`-only version of this
 * function did not. Counting every bare `(` uniformly — regardless of what
 * introduces it — is the correct model: a `--` inside ANY nested
 * parenthetical construct belongs to whatever that construct is, never to
 * the outer command, so the specific syntax that opened the parenthesis is
 * irrelevant to this function's one question ("has every nested region
 * closed yet?").
 */
function beforeEndOfOptions(command, guarded) {
  let parenDepth = 0;
  let inBacktick = false;
  const n = command.length;
  for (let i = 0; i < n; i++) {
    const gch = guarded[i];
    // ANY bare '(' counts, not only one preceded by '$' — see the function
    // comment's fix-wave-5 note for why requiring a preceding '$' was itself
    // the bug.
    if (!inBacktick && gch === '(') {
      parenDepth++;
      continue;
    }
    if (!inBacktick && parenDepth > 0 && gch === ')') {
      parenDepth--;
      continue;
    }
    if (parenDepth === 0 && gch === '`') {
      inBacktick = !inBacktick;
      continue;
    }
    if (parenDepth === 0 && !inBacktick && command[i] === '-' && command[i + 1] === '-') {
      const beforeOk = i === 0 || /[ \t\n]/.test(guarded[i - 1]);
      const afterIdx = i + 2;
      const afterOk = afterIdx >= n || /[ \t\n]/.test(guarded[afterIdx] ?? '');
      if (beforeOk && afterOk) return command.slice(0, i);
    }
  }
  return command;
}

/**
 * Delete every SUBSTITUTION span (`$(...)` or `` `...` ``, including its own
 * delimiters) from every IFS-whitespace-bounded WORD of `command` — always,
 * regardless of what the word's surviving literal characters turn out to
 * spell. Built on the same depth-tracking TECHNIQUE as `beforeEndOfOptions()`
 * above (#454's precedent — deliberately NOT the argv-tokenizer module's flat
 * `Token` shape (see `plugin/scripts/lib/`), whose own NON-GOALS comment
 * already says cannot represent this; see #459's own triage trail), but NOT
 * fed `guardedText` itself — see the `guarded` parameter note below and
 * `substGuardedText`'s own comment in `normalizeShellText()` for why a
 * SEPARATE masking was required.
 *
 * `guarded` MUST be `substGuardedText`'s segment, not `guardedText`'s
 * (adversarial finding, fix wave 1): `guardedText` masks a quoted
 * `$`/`(`/`)`/backtick identically regardless of quote TYPE, which is right
 * for `beforeEndOfOptions()`'s question but wrong for this one — real bash
 * still expands `$(...)`/backtick syntax inside DOUBLE quotes (only
 * word-splitting of the result is suppressed), so `rm "-r$(true)f"
 * /prod-secrets` is exactly as dangerous as the unquoted spelling, yet an
 * early version of this function fed `guardedText` and missed it: the masked
 * `$`/`(`/`)` were invisible to the depth-tracker below, so the substitution
 * was never recognised as one at all and the ORIGINAL #459 bypass reopened
 * behind the most mundane possible evasion — quoting the flag. Verified
 * fixed once callers switched to `substGuardedText`.
 *
 * Closes BOTH edges of the same `shortFlagCluster()` flaw at once (#459
 * absorbs #495), because they are the same root cause read two ways:
 * `shortFlagCluster()` (and the specific literal `--force`/`--recursive`/
 * `+refspec`/`longFlag()`-built regexes this ticket's own AC.1 names —
 * `force-push`'s `--force`/`--mirror`, `env-branch-delete`'s
 * `PUSH_DELETE`/`BRANCH_DELETE`/`BRANCH_FORCE`, `recursive-delete`'s
 * `--recursive`/`--force`, `git-clean-force`'s inline `-f` regex) assume a
 * flag word is bounded by real whitespace and made of letters only, when
 * real bash word-splitting only cares about IFS whitespace — anything
 * glued together (letters, one or more substitutions, in any combination
 * or order) is ONE word, and a real shell hands the invoked program that
 * word fully assembled, substitutions expanded. NOT every `longFlag()`
 * consumer in this file is wired to this function — `hard-reset`'s
 * `HARD_RESET` is the same helper family but outside AC.1's own named
 * scope (it is not a `shortFlagCluster()` consumer); tracked separately,
 * not silently left unaddressed — see the ticket trail.
 *
 * - **#459 (mid-word):** `-r$(true)f` — a substitution breaks the letter run
 *   the flat regex needs to be contiguous. Deleting the span merges the
 *   letters either side back into `-rf`, exactly as a real shell would if
 *   the substitution expands to nothing (`true`'s stdout, or any other
 *   deterministically-empty spelling an attacker controls) — the ONLY
 *   assumption this function makes about a substitution's unknown output,
 *   and the conservative one: it is also the shape that preserves valid
 *   flag syntax, i.e. the shape an attacker needs for the bypass to work at
 *   all, so assuming it is never a missed catch, only ever a (harmless)
 *   over-match if the true output turns out non-empty — a case GNU
 *   getopt-style parsers reject outright as an invalid option anyway (see
 *   the docstring on the affected rules for detail), never a silent escape.
 * - **#495 (adjacent):** `$(true)-rf` — the flag never even reaches
 *   `shortFlagCluster()`'s `(?:^|\s)-` start anchor, because the
 *   substitution's own characters occupy the position real whitespace would
 *   need to be. Deleting the span exposes the `-rf` sitting right where a
 *   real shell would also fuse it into one argv word.
 *
 * Every word — not only ones that already look flag-shaped — is replaced by
 * its own SKELETON (literal characters, spans removed, in order): a word
 * whose skeleton does not start with `-` was never going to match any flag
 * regex here regardless (deleting characters can only ever REMOVE a `-…`
 * anchor point, never create one that was not already present in the
 * surviving literal text — see the AC.3 note below), so descrambling it too
 * costs nothing and closes an adjacent, same-root-cause false positive for
 * free: an UNRELATED word like `$(gh api -f q=1)` (some OTHER command's own
 * argument, entirely inside a substitution) has an EMPTY skeleton — the
 * whole word IS the span — so its `-f` never survives into the output text
 * at all, and is never read as this word's own flag. (Verified this exact
 * shape is a live, PRE-EXISTING false positive on `main` today, for the
 * identical reason in the opposite direction: the flat regex has no concept
 * of substitution grouping whatsoever. Closing it is a direct consequence of
 * this function's own design, not a separate change. Reaches BOTH the
 * unquoted and double-quoted spellings, since `substGuardedText` — unlike
 * `guardedText` — keeps a double-quoted `$(...)` visible to the depth
 * tracker; a SINGLE-quoted or `$'…'`-ANSI-C-quoted one is genuinely inert
 * data in real bash — no expansion occurs at all — so it is correctly left
 * out of scope here regardless: it was never live substitution syntax to
 * begin with, on either side of this fix.)
 *
 * AC.5, categorical block-on-ambiguity — TWO independent signals, both
 * fix-wave findings from a full-branch adversarial `forge:security` pass,
 * not part of the original design:
 *
 * 1. **Truly unterminated at end-of-scan** (`parenDepth > 0 || inBacktick`
 *    when the LAST word closes — this can only happen at the final call,
 *    since every mid-loop `closeWord()` call is itself gated on
 *    `parenDepth === 0`): UNCONDITIONAL, regardless of what `skelWord`
 *    contains. An earlier version scoped this to "only when the word's own
 *    skeleton-so-far starts with `-`" — plausible, since AC.5's own text
 *    says "inside a candidate flag word" — but that missed a live bypass:
 *    a lone, never-closing live paren/backtick (e.g. a double-quoted `"("`
 *    or `` "`" ``, with no real match anywhere in the segment) swallows
 *    EVERY later word too, since the whitespace-boundary check is itself
 *    gated on `parenDepth === 0` — including a genuine, otherwise fully
 *    ordinary flag several tokens later (`git push "(" -f origin main`
 *    real bash argv: `git`, `push`, `(`, `-f`, `origin`, `main` — four
 *    separate tokens, `-f` very much still forces). The word that STARTS
 *    the unresolved span is never itself flag-shaped in this construction
 *    (`skelWord` stays `''` the whole time after the initial `(`), so the
 *    old scoped check silently never fired and the swallowed `-f` vanished
 *    from `cFlags` with no compensating signal at all. Verified: blocked
 *    on `main`, allowed on this branch pre-fix, across all four rules.
 *    Dropping the scoping for THIS signal costs nothing on ordinary,
 *    well-formed input — a truly unterminated substitution can only occur
 *    in genuinely malformed/incomplete syntax, which is never a real,
 *    executable command to begin with.
 * 2. **Nested-quote-reuse divergence within a flag-candidate word**
 *    (`skelWord.startsWith('-')` — scoped here, deliberately, unlike
 *    signal 1 above, to avoid blanket-blocking ordinary double-quoted
 *    substitution use in a non-flag argument position, e.g.
 *    `git push origin "$(git rev-parse --short HEAD)"`, AC.3): a `$`/`(`/
 *    `)`/backtick character that is masked (quote-protected) under the
 *    OLD, quote-type-BLIND `guardedText` but NOT masked (live) under the
 *    quote-type-AWARE `substGuardedText` this function reads is exactly
 *    the fingerprint of a decoy — `normalizeShellText()` still tracks
 *    quoting with a SINGLE flat `quote` variable, with no concept that
 *    `$(...)` opens a genuinely INDEPENDENT nested quoting scope for its
 *    OWN inner command in real bash — so a `'` reused INSIDE a substitution
 *    that is itself already inside an OUTER double-quoted string is never
 *    recognised as opening its own quote at all (a `'` has no meaning
 *    inside `"..."` — correct, in isolation — but real bash parses
 *    `$(...)`'s content in its OWN fresh quoting context, so the `'` DOES
 *    open a real nested scope there). A close-paren genuinely protected by
 *    that invisible inner quote (`cat`'s own single-quoted `')'` argument)
 *    then wrongly closes the OUTER substitution one paren early —
 *    `rm "-r$(cat ')' )f" /prod-secrets` (real bash argv: `rm`, `-rf`,
 *    `/prod-secrets` — a genuine `rm -rf`) — the exact bug class
 *    `beforeEndOfOptions()`'s own fix-wave-4/5/6 already fought for
 *    `guardedText`/`bare[]`, reopened one layer deeper by the NEW
 *    `liveSubst[]`/`substGuardedText` mechanism this ticket adds, since
 *    that fix-wave hardening was never ported to it. Verified: blocked on
 *    `main`, allowed on this branch pre-fix, across all four rules; NOT
 *    mitigated by `recursive-delete`'s own pre-existing `trustworthy` gate,
 *    which only guards `beforeEndOfOptions()`'s truncation, never this
 *    function's own depth-tracking.
 *
 * Both signals mirror `recursive-delete`'s own pre-existing `trustworthy`
 * gate in spirit (cannot certify the parse → treat it as maximally
 * dangerous), and every affected rule treats a returned `ambiguous: true`
 * as an automatic hit.
 */
function descrambleFlags(command, guarded, guardedLegacy) {
  const n = command.length;
  const isIfsWs = (gch) => gch === ' ' || gch === '\t' || gch === '\n';
  let out = '';
  let rawWord = '';
  let skelWord = '';
  let wordDivergent = false; // signal 2 — see the function comment above
  let parenDepth = 0;
  let inBacktick = false;
  let ambiguousFound = false;

  // Flush the word accumulated so far: EVERY word is replaced by its own
  // skeleton (spans deleted, everything else kept, in order) — see the
  // function comment for why that is safe even for a word that turns out
  // not to be flag-shaped. Only ever called with
  // `parenDepth === 0 && !inBacktick` (the mid-loop call site is itself
  // gated on that), EXCEPT the final call after the loop ends — see the
  // function comment's two AC.5 signals for what a still-nonzero
  // depth/backtick state, or an accumulated divergence, mean there.
  const closeWord = () => {
    if (rawWord === '') return;
    out += skelWord;
    if (parenDepth > 0 || inBacktick) ambiguousFound = true; // signal 1: unconditional
    else if (wordDivergent && skelWord.startsWith('-')) ambiguousFound = true; // signal 2: scoped
    rawWord = '';
    skelWord = '';
    wordDivergent = false;
  };

  for (let i = 0; i < n; i++) {
    const ch = command[i];
    const gch = guarded[i];
    if (parenDepth === 0 && !inBacktick && isIfsWs(gch)) {
      closeWord();
      out += ch;
      continue;
    }
    rawWord += ch;
    // Signal 2's own detector: `guardedLegacy` only ever masks whitespace/
    // `$`/`(`/`)`/backtick, and the whitespace rule is IDENTICAL between it
    // and `guarded` (`substGuardedText`) — so a divergence can only ever
    // fire here for one of the four substitution-syntax characters, never
    // a false trigger on an ordinary letter/digit/hyphen.
    if (guardedLegacy[i] === GUARD_SENTINEL && gch !== GUARD_SENTINEL) wordDivergent = true;
    // Same depth-tracking as beforeEndOfOptions(): ANY bare '(' counts, and
    // every check reads `guarded` (not `command`), so a QUOTED paren/
    // backtick/`$` — genuinely inert literal data in real bash — can never
    // be misread as substitution syntax (see that function's own comment
    // for the fix-wave findings this inherits for free by reusing the same
    // technique).
    if (!inBacktick && gch === '(') { parenDepth++; continue; }
    if (!inBacktick && parenDepth > 0 && gch === ')') { parenDepth--; continue; }
    if (parenDepth === 0 && gch === '`') { inBacktick = !inBacktick; continue; }
    // The '$' that INTRODUCES a '$(' is syntax, not a flag character — drop
    // it from the skeleton too (it is already excluded from `command`
    // between the parens; this excludes the one character outside them).
    if (parenDepth === 0 && !inBacktick && gch === '$' && guarded[i + 1] === '(') continue;
    if (parenDepth === 0 && !inBacktick) skelWord += ch;
  }
  closeWord();
  return { text: out, ambiguous: ambiguousFound };
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
  // One boolean per emitted character (#454, AC-454.5 fix wave): true only
  // for a character that reached `parts` completely BARE — outside any quote
  // region AND not the target of a backslash escape. Every other path
  // (inside `"`/`'`/`$'…'`, or immediately after a backslash) marks `false`.
  // This is what lets `beforeEndOfOptions()` tell a GENUINE, syntactically
  // active whitespace/`--` boundary apart from one that merely LOOKS like it
  // after quotes are stripped — see `guardedText` below for why that
  // distinction is load-bearing, not cosmetic.
  const bare = [];
  // One boolean per emitted character (#459 — `descrambleFlags()`'s own
  // quote-TYPE-aware need, distinct from `bare[]` above): true when this
  // character could still be part of GENUINE, live `$(...)`/backtick
  // substitution syntax in real bash — i.e. it is `bare[i]`-bare, OR it sits
  // inside DOUBLE quotes and was not itself individually escaped. `bare[]`
  // alone cannot answer this: it collapses every quote TYPE to the same
  // "protected" bit, but real bash does not — double quotes still expand
  // `$(...)` (only word-splitting of the RESULT is suppressed), single
  // quotes and `$'…'` ANSI-C quoting do not expand it at all, and an escaped
  // character is inert regardless of what quote (if any) surrounds it. See
  // `substGuardedText` below for what this closes.
  const liveSubst = [];
  let endsDollar = false; // does the output currently end with `$`?
  let quote = null;    // the active quote character, or null
  let ansiC = false;   // the active single-quote region was opened as `$'…'`
  let litDollar = false; // the `$` just emitted came from `\$`, so it is DATA
  /** Append one character, keeping `endsDollar` true to the output. */
  const push = (ch, isBare = false, isLiveSubst = false) => {
    parts.push(ch);
    bare.push(isBare);
    liveSubst.push(isLiveSubst);
    endsDollar = ch === '$';
  };
  // A separator that survived escaping/quoting is inert as a separator, so
  // emit a space rather than the character itself — splitSegments() is blind
  // to quoting and would otherwise split the command around it. `isLiveSubst`
  // defaults false (correct for every escaped/decoded call site below); the
  // one call site where it is NOT false is the generic in-quote fallback,
  // which passes `quote === '"'` explicitly — see there for why.
  const emit = (ch, isLiveSubst = false) => push(SEPARATOR_CHARS.test(ch) ? ' ' : ch, false, isLiveSubst);
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
          bare.pop(); // keep `bare` in lockstep with `parts` (#454 AC-454.5 fix wave)
          liveSubst.pop(); // same lockstep requirement, for `liveSubst` (#459)
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
      // The ONLY bare push in this whole scan: unquoted, unescaped, ordinary
      // top-level data. Everything else routes through `emit()`/`emitEscaped()`/
      // `emitCodePoint()`, all of which default `isBare` to `false`. Bare is
      // always live-for-substitution too (#459): top-level `$(...)`/backtick
      // syntax is the ordinary, unquoted case every other rule in this file
      // already assumes.
      push(ch, true, true);
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
    // The generic in-quote fallback (#459): reached only for a character
    // that is inside SOME quote (`quote !== null`, the only way to arrive
    // here — every `quote === null` path above `continue`s) and was not
    // itself escaped or decoded. Live-for-substitution exactly when that
    // quote is DOUBLE — real bash still expands `$(...)`/backtick syntax
    // inside `"..."`, only single quotes and `$'…'` ANSI-C quoting (both
    // `quote === "'"`) suppress it entirely.
    emit(ch, quote === '"');
  }
  const text = parts.join('');
  // `guardedText` (#454, AC-454.5 fix wave): `text` with every PROTECTED
  // whitespace character (one that came from inside a quote/`$'…'` region, or
  // immediately after a backslash escape — i.e. `bare[i] === false`) replaced
  // by a sentinel that cannot match `[ \t\n]`. Same length as `text`, built by
  // pure character SUBSTITUTION at positions that are never one of the
  // `;|&\n` separators `segments()` splits on (a separator surviving inside a
  // quote is ALREADY converted to a plain space by `emit()`'s own
  // SEPARATOR_CHARS check, before it ever reaches `push()` — so a `bare:
  // false` position is never one of those characters to begin with) — the
  // exact same "insertion/substitution can only ever merge segments, never
  // split or reorder them" argument `spacedText` above already makes, applied
  // to substitution instead of insertion. `segments(guardedText)` is
  // therefore guaranteed to split identically to `segments(text)`.
  //
  // WHY: a full-branch adversarial security review found that `text` alone
  // cannot distinguish a GENUINE, syntactically active whitespace boundary
  // from one that merely LOOKS like it after `normalizeShellText()` strips
  // quote characters — `'X --'` (one shell argv token, a literal space
  // between "X" and "--") and a real ` -- ` (two/three separate tokens)
  // render as IDENTICAL text once quotes are gone. `recursive-delete`'s
  // `beforeEndOfOptions()` used exactly that flattened text to decide where
  // POSIX end-of-options begins, so `rm 'X --' -rf /important-template-configs`
  // — a REAL, dangerous `rm -rf` (bash's own default option permutation keeps
  // `-rf` live no matter what non-flag operand precedes it) — was wrongly
  // read as ending at the quoted `--`, hiding the real `-rf` from flag
  // detection entirely and returning not-blocked. Verified: `main` (no
  // end-of-options concept at all, pre-#454) correctly blocks it; the
  // flattened-text-only version of `beforeEndOfOptions()` wrongly allowed it.
  //
  // Deliberately NOT masking `-` (hyphen) characters: a QUOTED flag is still
  // a REAL flag to the invoked program (`rm '-rf' target` really does pass
  // an `-rf` argv element — quoting affects the SHELL's word-splitting, not
  // whether the invoked program's own option parser reads the resulting
  // argument as an option), and `main` already relies on that by matching
  // flags in the flattened, quote-stripped text. Masking hyphens too would
  // have REGRESSED that existing, correct behaviour into a new false
  // negative instead of fixing the reported one. Masking whitespace is
  // exactly the minimal, correct distinction for the boundary check: a
  // standalone `--` token (bare OR entirely inside one pair of quotes, since
  // quoting an ENTIRE token has no INTERNAL protected whitespace either way)
  // still has genuinely bare whitespace on both sides and is still honoured —
  // pinned by `AC-454.5: a bare quoted -- token is still honoured as
  // end-of-options` — while `'X --'`'s protected internal space breaks the
  // left-hand boundary check and the decoy is correctly ignored.
  //
  // ALSO masking `$`, `(`, `)`, and `` ` `` when protected (fix wave, full-
  // branch adversarial re-review — see `beforeEndOfOptions()`'s own comment
  // for the finding this closes): its `$(...)`/backtick nesting-depth
  // tracker needs the identical protected/bare distinction the whitespace
  // check already has, or a close-paren/backtick that is really just quoted
  // literal data (an inner command's own quoted argument, e.g. `cat`'s
  // `')'`) gets miscounted as genuine substitution syntax. Single quotes
  // suppress `$(...)` expansion entirely in real bash, so masking protected
  // instances of these four characters is the correct semantic model here,
  // not merely a defensive widening.
  // Built with a plain UTF-16-code-unit-indexed loop (`text[i]`/`text.length`),
  // NOT `Array.from(text, ...)` (full-branch adversarial re-review, critical
  // finding): `Array.from` on a string iterates by Unicode CODE POINT, so an
  // astral character (most emoji, many CJK-extension/mathematical/other
  // supplementary-plane characters) earlier in the command collapses a
  // surrogate PAIR into one iteration step, shifting the callback's index one
  // position early for everything after it — while `bare` was built by the
  // main scan's own `command[i]` loop, which is a plain UTF-16-code-unit walk
  // (a surrogate pair is two separate iterations, two separate `bare` push
  // calls). The mismatch silently read the WRONG character's protected/bare
  // status for the rest of the string, reopening the exact quoted-decoy
  // bypass fix wave 2 closes for any command containing a common Unicode
  // character anywhere earlier in the line — confirmed reproducible
  // (`check('rm <emoji>X\\ -- -rf target')` read `blocked:false`) before this
  // fix. A same-indexing-scheme loop cannot have that divergence: `text[i]`
  // and `bare[i]` are built by, and read by, the identical UTF-16-code-unit
  // index space throughout.
  const guardedChars = new Array(text.length);
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const maskable = ch === ' ' || ch === '\t' || ch === '\n' || ch === '$' || ch === '(' || ch === ')' || ch === '`';
    guardedChars[i] = !bare[i] && maskable ? GUARD_SENTINEL : ch;
  }
  const guardedText = guardedChars.join('');
  // `substGuardedText` (#459): a SECOND, differently-scoped masking, same
  // length/index space as `text`/`guardedText`. `guardedText` above answers
  // "was this whitespace/`$`/`(`/`)`/backtick character reached completely
  // bare?" — a single yes/no that treats every quote TYPE identically,
  // which is exactly right for `beforeEndOfOptions()`'s end-of-options
  // question (a quoted `--`, of EITHER quote type, is never genuine
  // end-of-options syntax) but WRONG for `descrambleFlags()`'s question
  // ("could this still be LIVE `$(...)`/backtick substitution syntax in
  // real bash?"), because real bash does not treat every quote type the
  // same way for that purpose: double quotes still expand `$(...)` (only
  // word-splitting of the RESULT is suppressed), while single quotes and
  // `$'…'` ANSI-C quoting suppress the expansion entirely, and an escaped
  // character is inert regardless of what quote (if any) surrounds it.
  //
  // Discovered adversarially, not preemptively: an early version of
  // `descrambleFlags()` read `guardedText` for its own depth-tracking,
  // exactly as `beforeEndOfOptions()` does — plausible, since it reuses
  // that function's technique deliberately. But `rm "-r$(true)f"
  // /prod-secrets` (the ORIGINAL #459 bypass, merely wrapped in double
  // quotes — real bash still executes this as `rm -rf /prod-secrets`,
  // identically to the unquoted spelling, since double quotes only affect
  // word-splitting of an EMPTY substitution's output, which is moot) still
  // bypassed: `guardedText` masks the `$`/`(`/`)` inside ANY quote to the
  // sentinel, so `descrambleFlags()`'s depth-tracker never recognised the
  // substitution as one at all, and the bypass this ticket exists to close
  // reopened via the most ordinary possible evasion — quoting the flag.
  // Verified: blocked once `substGuardedText` (below) is used instead.
  //
  // Whitespace masking is UNCHANGED from `guardedText` (still `!bare[i]`,
  // any quote type protects it, matching real bash word-splitting
  // suppression under EITHER quote type) — only the `$`/`(`/`)`/backtick
  // rule differs, keyed off the new `liveSubst[]` tracked during the scan
  // above (true for a bare character, OR one reached via the generic
  // in-quote fallback while `quote === '"'` — i.e. unescaped double-quoted
  // content; false for anything escaped, ANSI-C-decoded, or single-quoted).
  const substGuardedChars = new Array(text.length);
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const isWs = ch === ' ' || ch === '\t' || ch === '\n';
    const isSubstChar = ch === '$' || ch === '(' || ch === ')' || ch === '`';
    const masked = (isWs && !bare[i]) || (isSubstChar && !liveSubst[i]);
    substGuardedChars[i] = masked ? GUARD_SENTINEL : ch;
  }
  const substGuardedText = substGuardedChars.join('');
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
  return { text, spacedText, guardedText, substGuardedText };
}

// Every rule's `test()` reads `text` (the canonical parse — quotes stripped,
// escapes resolved, a raw NUL byte deleted) as its segment argument (#452
// v2). Only `recursive-delete` reads a SECOND argument, `spacedText`'s
// corresponding segment, for its own target-parsing (see its own comment
// below), and a THIRD, `guardedText`'s corresponding segment, for its own
// flag-boundary parsing (#454 AC-454.5 fix wave, see `beforeEndOfOptions()`)
// — every other rule ignores the second and third arguments entirely.
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
    // #459/#495: every flag-matching regex below reads `cFlags`
    // (descrambleFlags()'s output for THIS segment), not `c` directly — a
    // substitution fused mid-word or glued onto a flag's start can no
    // longer break `--force`/`--mirror`/the short-flag cluster apart, or
    // dodge them entirely. `cFlags === c` byte-for-byte whenever the segment
    // has no substitution syntax at all, so this is a no-op for every
    // pre-existing pinned case (#429/#437). The verb check and `+refspec`
    // (a different, out-of-scope fusion class — see the ticket's own named
    // scope) deliberately still read `c`.
    test: (c, cSpaced, cGuarded, cSubstGuarded) => {
      if (!/\bgit\b[^\n]*\bpush\b/.test(c)) return false;
      const { text: cFlags, ambiguous } = descrambleFlags(c, cSubstGuarded, cGuarded);
      if (ambiguous) return true;
      if (/\s--force\b(?!-with-lease|-if-includes)/.test(cFlags)) return true;
      // --mirror IS abbreviable (unlike --force above): `git push --mir` really
      // does mirror — verified against live git, it pushed every branch AND tag
      // with no refspec given. Matching only the full spelling left the exact
      // abbreviation class #429 identified as unclosable-by-enumeration wide
      // open in the very rule #429 hardened (#437, adversarial review).
      if (PUSH_MIRROR.test(cFlags)) return true;
      if (/(?:^|\s)\+\S/.test(c)) return true;
      // Alphanumeric, not alpha-only: `git push -4f` bundles the IPv4 flag with
      // -f and really does force-update (verified against live git), but an
      // [a-zA-Z]-only cluster scan misses it because the digit breaks the run.
      return /f/.test(shortFlagCluster(cFlags, { alnum: true }));
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
    // #459/#495: same `cFlags` swap as force-push above — every flag regex
    // below reads the descrambled segment, `PROTECTED_BRANCHES` and the `:`
    // refspec check deliberately still read `c`.
    test: (c, cSpaced, cGuarded, cSubstGuarded) => {
      if (!PROTECTED_BRANCHES.test(c)) return false;
      const { text: cFlags, ambiguous } = descrambleFlags(c, cSubstGuarded, cGuarded);
      if (ambiguous) return true;
      if (/\bgit\b[^\n]*\bpush\b/.test(c)) {
        if (PUSH_DELETE.test(cFlags) || /:/.test(c)) return true;
        if (/d/.test(shortFlagCluster(cFlags, { alnum: true }))) return true;
      }
      if (/\bgit branch\b/.test(c)) {
        const cluster = shortFlagCluster(cFlags, { alnum: true });
        if (/D/.test(cluster)) return true; // -D, incl. bundled (-Dq / -qD), IS delete+force
        const hasForce = /f/.test(cluster) || BRANCH_FORCE.test(cFlags);
        const hasDelete = /d/.test(cluster) || BRANCH_DELETE.test(cFlags);
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
    test: (c) => /\bgit\b[^\n]*\breset\b/.test(c) && HARD_RESET.test(c),
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
    // #459: the mid-word edge defeats this rule's own inline flag regex too
    // (it does not go through shortFlagCluster(), but has the identical
    // "contiguous letters only" assumption) — `git clean -$(true)fd` broke
    // the `f` in `-[a-zA-Z]*f` apart pre-fix. Same `cFlags` swap, verb check
    // stays on `c`. (The #495 adjacent edge already survived here — this
    // regex has no `(?:^|\s)` start anchor to dodge in the first place — so
    // this closes only the one edge that was actually open.)
    test: (c, cSpaced, cGuarded, cSubstGuarded) => {
      if (!/\bgit\b[^\n]*\bclean\b/.test(c)) return false;
      const { text: cFlags, ambiguous } = descrambleFlags(c, cSubstGuarded, cGuarded);
      if (ambiguous) return true;
      return /\bgit\b[^\n]*\bclean\b[^\n]*-[a-zA-Z]*f/.test(cFlags);
    },
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
    // The one rule reading `spacedText`/`guardedText` as well as `text`
    // (#452 v2, #454 AC-454.5): `c` (the canonical, NUL-deleted segment —
    // same argument every other rule reads) drives flag-cluster detection,
    // so `-r<NUL>f` still collects as a bundled `rf` the way a real shell's
    // dropped-byte behaviour would hand `rm` the intact `-rf`. `cSpaced` —
    // that SAME segment's spacedText reading — drives target parsing ONLY,
    // so #446's target-splice fix (`/prod-secrets<NUL>/scratchpad` judged as
    // two tokens, not one fused path ending in the safe word `scratchpad`)
    // keeps working unchanged; AC-446.6's pinned tests need no edits.
    // `cGuarded` — that SAME segment's guardedText reading — drives the
    // end-of-options BOUNDARY check only, so a quoted decoy can't fake a
    // real `--` (see `beforeEndOfOptions()`'s own comment).
    test: (c, cSpaced, cGuarded, cSubstGuarded) => {
      if (!/\brm\b/.test(c)) return false;
      // Flag detection must stop at a bare `--` (POSIX end-of-options, #454
      // AC.5): every token after it is a filename, never a flag, so it must
      // never be read as one. Mirrors safeRmTarget()'s own `--` handling for
      // the target half — see beforeEndOfOptions() above.
      //
      // CATEGORICAL SAFETY NET (#454 fix wave 6, full-branch adversarial
      // reviewer finding, the deepest of six adversarial rounds on this
      // mechanism): only TRUST `beforeEndOfOptions()`'s truncation when this
      // segment has NO quote-protected syntactically-relevant character at
      // all — i.e. `cGuarded` contains no `GUARD_SENTINEL` anywhere.
      // `normalizeShellText()` tracks quoting with a SINGLE flat `quote`
      // variable, with no concept that `$(...)`/backticks open a genuinely
      // INDEPENDENT quoting scope in real bash — so a segment where the
      // SAME quote character is reused both outside and inside a
      // substitution (`rm "$(cat " -- ")" -rf /important-secrets`, where the
      // inner argument's own `"` delimiters are indistinguishable, to that
      // flat scan, from the outer quote's) desyncs the scanner's quote
      // parity itself, not merely one character's masking — producing WRONG
      // `bare[]` values that no per-character masking fix (fix waves 2-5, all
      // of which patched one specific character class within an assumed-
      // correctly-tracked quote) can catch, because the underlying tracking
      // was already wrong before any masking ran. Verified: `main` blocks
      // the reproduction above; this branch's tip through fix wave 5 did
      // not. Rather than chase a seventh, eighth, Nth variant of "which
      // exact nested-quote-reuse shape breaks the flat scan next", any
      // segment with EVEN ONE quote-protected space/`$`/`(`/`)`/backtick is
      // conservatively treated as too ambiguous to trust for the end-of-
      // options *relaxation*, falling back to the historical, always-scan-
      // the-whole-segment behaviour (`main`'s exact pre-#454 approach,
      // already secured by #446/#437) — this can only ever OVER-block
      // (never weakens a dangerous-case block), and it does not affect
      // either of AC.5's own named cases (`rm -- -rf target`, `rm --
      // --recursive --force target`), neither of which involves any
      // quoting at all.
      const trustworthy = !cGuarded.includes(GUARD_SENTINEL);
      const flagsSegment = trustworthy ? beforeEndOfOptions(c, cGuarded) : c;
      // #459/#495: `flagsSegment` is a clean PREFIX of `c` (either `c`
      // itself, or `beforeEndOfOptions()`'s truncation at a genuine, depth-0
      // top-level `--`), so the same-length, same-index prefix of
      // `cSubstGuarded` — NOT `cGuarded`, see `substGuardedText`'s own
      // comment for why the two differ — is its correct quote-type-aware
      // guarded reading, no re-scanning needed. `descrambleFlags()` deletes
      // any substitution fused into a flag-shaped word before the
      // cluster/`--recursive`/`--force` regexes ever see it, closing both
      // the mid-word (#459) and adjacent (#495) edges — including when the
      // fused flag is itself wrapped in double quotes, which `cGuarded`
      // alone cannot see through; an unterminated substitution inside a
      // flag-candidate word (`ambiguous`) is an automatic block, the same
      // categorical-safety-net shape as the `trustworthy` gate just above.
      const flagsSubstGuarded = cSubstGuarded.slice(0, flagsSegment.length);
      const flagsGuardedLegacy = cGuarded.slice(0, flagsSegment.length);
      const { text: flagsDescrambled, ambiguous } = descrambleFlags(flagsSegment, flagsSubstGuarded, flagsGuardedLegacy);
      if (ambiguous) return true;
      // Collect single-dash SHORT flag clusters (e.g. -rf, -Rf) via the shared
      // helper. Deliberately alpha-only (default) where force-push above
      // passes `alnum: true`: git has numeric short flags (`-4`) that can
      // bundle with `-f`, `rm` has none, so widening here would buy nothing.
      const shortFlags = shortFlagCluster(flagsDescrambled);
      // Recursive via short -r/-R OR the long --recursive; force via short -f OR
      // long --force. Both required (AC-312.1), in any order.
      const recursive = /[rR]/.test(shortFlags) || /\B--recursive\b/.test(flagsDescrambled);
      const force = /f/.test(shortFlags) || /\B--force\b/.test(flagsDescrambled);
      if (!recursive || !force) return false;
      // The `rm` slice point is found on a command-token BOUNDARY, not by
      // unanchored substring search (#454 AC.1): `cSpaced.indexOf('rm')` used
      // to find the first occurrence of the LETTERS "rm" anywhere in the
      // segment, so an env-var prefix that merely contains "rm" (`TERM=xterm`,
      // `X=affirm`) moved the slice point before the real `rm` token and the
      // rule judged the wrong span. `\brm\b` requires "rm" to sit between
      // non-word characters (or string start/end) on both sides, which
      // "xterm"/"affirm" never do (the "rm" there directly abuts a word
      // character, "e"/"i"), while a real standalone `rm` token always does.
      // Falls back to the start of the segment if, somehow, no boundary-
      // anchored "rm" is found (defensive only: `c`'s own `\brm\b` guard
      // above already establishes one exists in the sibling `text` reading).
      const rmMatch = /\brm\b/.exec(cSpaced);
      const rest = cSpaced.slice(rmMatch ? rmMatch.index : 0);
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
  let text, spacedText, guardedText, substGuardedText;
  try {
    ({ text, spacedText, guardedText, substGuardedText } = normalizeShellText(command));
  } catch {
    text = command;
    spacedText = command;
    guardedText = command;
    substGuardedText = command;
  }
  const segs = segments(text);
  // `segsSpaced`/`segsGuarded`/`segsSubstGuarded` are PROVABLY the same
  // length/order as `segs` — spacedText is built from text by pure character
  // insertion, and guardedText/substGuardedText by pure character
  // substitution, both at positions that are never one of the `;|&\n`
  // separators segments() splits on (#452 v2, #454 AC-454.5, #459; see
  // normalizeShellText()'s function-level comment for the full argument, and
  // the AC-452.5 regression test for empirical pins). The `?? seg` fallbacks
  // below are therefore defensive only, never load-bearing.
  const segsSpaced = segments(spacedText);
  const segsGuarded = segments(guardedText);
  const segsSubstGuarded = segments(substGuardedText);
  for (const rule of RULES) {
    // scope:'full' rules test the whole command (pipe-to-shell hides in the pipe
    // that segments() splits on); all others test each split sub-command. Every
    // rule's test() gets `text`'s segment as its first argument, the
    // corresponding `spacedText` segment as its second, the corresponding
    // `guardedText` segment as its third, and the corresponding
    // `substGuardedText` segment as its fourth — only `recursive-delete`
    // reads the second or third at all (its own target/flag-boundary
    // parsing), and only `force-push`/`env-branch-delete`/`git-clean-force`/
    // `recursive-delete` read the fourth (`descrambleFlags()`'s own
    // quote-type-aware input, see that function's comment).
    const hit = rule.scope === 'full'
      ? rule.test(text, spacedText, guardedText, substGuardedText)
      : segs.some((seg, i) => rule.test(seg, segsSpaced[i] ?? seg, segsGuarded[i] ?? seg, segsSubstGuarded[i] ?? seg));
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
