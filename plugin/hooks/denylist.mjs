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
      if (/\s--mirror\b/.test(c)) return true;
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
    // literal, unbundled `-D` token. Abbreviations of the LONG forms (`--del`,
    // `--forc`, …) remain an accepted, documented gap here — see the note at the
    // end of RULES; force-push (#429) set the same precedent of not
    // abbreviation-matching `--force`.
    test: (c) => {
      if (!PROTECTED_BRANCHES.test(c)) return false;
      if (/\bgit\b[^\n]*\bpush\b[^\n]*(?:--delete\b|:)/.test(c)) return true;
      if (/\bgit\b[^\n]*\bpush\b/.test(c) && /d/.test(shortFlagCluster(c, { alnum: true }))) return true;
      if (/\bgit branch\b/.test(c)) {
        const cluster = shortFlagCluster(c, { alnum: true });
        if (/D/.test(cluster)) return true; // -D, incl. bundled (-Dq / -qD), IS delete+force
        const hasForce = /f/.test(cluster) || /--force\b/.test(c);
        const hasDelete = /d/.test(cluster) || /--delete\b/.test(c);
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
  const segs = segments(command);
  for (const rule of RULES) {
    // scope:'full' rules test the whole command (pipe-to-shell hides in the pipe
    // that segments() splits on); all others test each split sub-command.
    const hit = rule.scope === 'full' ? rule.test(command) : segs.some((seg) => rule.test(seg));
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
