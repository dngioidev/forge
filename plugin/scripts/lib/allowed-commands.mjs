/**
 * Single-sourced "known-good" command prefixes forge agents type DIRECTLY at a
 * host's approval surface (#429 AC.4).
 *
 * Scoping fact this list depends on: every `gh`/`git` call made *inside*
 * `plugin/scripts/**.mjs` is spawned through `plugin/scripts/lib/exec.mjs`
 * `run()` with `shell:false` — those are child processes of `node`, never
 * host tool calls, so they never reach either host's approval layer. Only
 * what an agent itself types at a shell needs an entry here; `node` covers
 * the whole script tier in one line.
 *
 * Consumers (do NOT copy-paste this list elsewhere — extend it here):
 *  - `plugin/scripts/autopilot/perms.mjs` — builds Claude's
 *    `Bash(<prefix>:*)` settings.local.json allowlist from this list.
 *  - `plugin/hooks/agy-deny.mjs` — the agy PreToolUse hook returns `allow`
 *    only for a command every one of whose segments matches a prefix here;
 *    everything else defaults to `ask` (#429 AC.1/AC.2).
 *
 * The denylist in `denylist.mjs` ALWAYS runs first and strictly outranks this
 * list (#429 AC.3) — a command can be both allowlisted here (e.g. `git push`)
 * and denylisted (e.g. a force-push) at the same time, and the denylist wins.
 * Nothing in this file is consulted unless the denylist has already cleared
 * the command.
 */
export const ALLOWED_COMMAND_PREFIXES = [
  // gh — read + write verbs forge agents type directly
  'gh pr create',
  'gh pr merge',
  'gh pr view',
  'gh pr checks',
  'gh pr diff',
  'gh pr list',
  'gh issue view',
  'gh issue comment',
  'gh issue create',
  'gh issue edit',
  'gh issue close',
  // git — mutating verbs forge agents type directly
  'git push',
  'git commit',
  'git checkout',
  'git rebase',
  'git fetch',
  // git — read-only inspection
  'git status',
  'git diff',
  'git log',
  'git rev-parse',
  // the script-dispatcher tier (covers every `forge <area> <cmd>` and
  // `scripts/**.mjs` entry point spawned by an agent)
  'node',
  // config-driven verify; conventions.verify defaults to this exact string
  // (`plugin/scripts/init.mjs`) and every delivery runs it, often repeatedly
  'pnpm verify',
];

/**
 * Shell syntax that lets a segment do something OTHER than run the allowlisted
 * verb its prefix advertises. Matching a prefix only constrains how a segment
 * STARTS; without this guard the tail is unconstrained, and a real shell will
 * happily interpret it:
 *
 *   `git push $(touch pwned)`         -> command substitution: arbitrary exec
 *   `git diff \`id\``                   -> backtick substitution: arbitrary exec
 *   `git status > important.txt`      -> redirection: a "read-only" verb becomes
 *                                        an arbitrary-file-overwrite primitive
 *   `git log < /etc/passwd`           -> redirection / process substitution
 *   `git status & curl evil.example`  -> background chaining (`&` alone is NOT a
 *                                        separator `splitSegments()` splits on)
 *
 * A command containing ANY of these falls through to `ask` rather than being
 * treated as known-good. This is checked against the whole command string, so
 * even a chain of individually-allowlisted verbs (`git fetch && git rebase`)
 * asks — deliberately conservative: one extra prompt is the cheap failure mode,
 * a missed exec vector is the expensive one. `;` `|` and newline are included
 * even though `splitSegments()` would consume them, so this function is correct
 * standalone (its `segments` option is optional) and stays correct if the
 * splitter's separator set ever narrows.
 *
 * Deliberately NOT listed, because they are not execution vectors and excluding
 * them would force `ask` on ordinary forge commands: bare `(`/`)` (a syntax
 * error unquoted, inert quoted — e.g. `git commit -m "fix(board): x"`), `{`/`}`
 * (brace expansion, not exec), `*`/`?` (globbing), `#`, and `\` (Windows paths).
 * A false `ask` is harmless (#429 AC.8: more prompting, never less); a false
 * `allow` is the bug this whole ticket exists to fix, so this errs toward `ask`.
 */
const SHELL_METACHARACTERS = /[$`<>&;|]|[\x00-\x1f]/;

/**
 * Prefixes whose destructiveness lives in their ARGUMENTS, not their verb.
 * These are auto-approved only when EVERY argument is on a small known-safe
 * list — a positive model, not a list of dangerous things to exclude.
 *
 * Why positive, and why this matters: `denylist.mjs` describes itself as "a
 * tripwire for a few known-catastrophic commands, not a security boundary".
 * An allowlist layered on top converts every one of its gaps into a SILENT
 * auto-approve instead of a prompt. #429's review rounds then found three
 * force-push spellings missing from it in succession (`-uf` bundled short
 * flags, `--mirror`, `+refspec`) — and, decisively, git's parse-options
 * accepts **unambiguous long-option abbreviations**, so `git push --mir` is
 * `--mirror` and `git push --del` is `--delete`. No enumeration of dangerous
 * spellings can be complete against that; `--mir`/`--mirr`/`--mirro` would each
 * need their own entry. Enumerating the SAFE arguments is finite and closed.
 *
 * Consequence: an unrecognised flag — including any abbreviation, and any flag
 * a tool adds in future — falls to `ask`. That is the intended failure mode.
 * This is deliberately redundant with the denylist: a spelling that slips past
 * the denylist costs a prompt, never a silent destructive action.
 *
 * A verb belongs here when its ARGUMENTS can make it destructive or can escape
 * the verb entirely. Four do:
 *   `node`          — `-e`/`--eval`/`-p` is unrestricted code execution
 *   `git push`      — force / delete / mirror / refspec rewrite published refs
 *   `git checkout`  — `-- .` / `-f` silently discards uncommitted local work
 *   `gh pr merge`   — `--admin` bypasses branch protection
 * The rest of ALLOWED_COMMAND_PREFIXES are safe for any argument (`git status`,
 * `gh issue view`, …) or are read-only.
 */

/** A bare operand: a ref, remote, path or number — never a flag (`-`) or force refspec (`+`). */
const PLAIN_OPERAND = /^[A-Za-z0-9._][A-Za-z0-9._/-]*$/;

const ARGUMENT_SENSITIVE_PREFIXES = [
  {
    prefix: 'node',
    // node stops parsing its OWN options at the first non-option argument, so
    // "the first argument is a plain script path" is sufficient: everything
    // after it belongs to the script, not to node. This is what stops
    // `node -e "<code>"` / `--eval` / `-p` / `-` (read program from stdin) —
    // unrestricted code execution with full fs/child_process/network reach —
    // while leaving the entire forge script tier (`node scripts/x.mjs --flag`)
    // auto-approved, which is the whole reason `node` is on the allowlist.
    argsOk: (args) => args.length > 0 && PLAIN_OPERAND.test(args[0]),
  },
  {
    prefix: 'git push',
    // Flags that cannot force, delete, or rewrite anything. `--force-with-lease`
    // is deliberately NOT here: it is permitted by the denylist as the sanctioned
    // safe alternative, but it is still a force operation, so a human should see
    // it rather than have it auto-approved.
    argsOk: (args) => args.every((a) => new Set([
      '-u', '--set-upstream',
      '-q', '--quiet',
      '-v', '--verbose',
      '--progress', '--no-progress',
      '--porcelain', '--dry-run',
    ]).has(a) || PLAIN_OPERAND.test(a)),
  },
  {
    prefix: 'git checkout',
    // Switching to a ref is routine; touching PATHS is what destroys work.
    // `git checkout -- .`, `git checkout .` and `git checkout src/` all discard
    // uncommitted changes irrecoverably, and `-f` does the same while switching.
    // So: at most `-b <name>`, and operands must be ref-shaped — not `.`, not
    // the `--` path separator, not a trailing-slash directory.
    argsOk: (args) => args.every(
      (a) => a === '-b' || (PLAIN_OPERAND.test(a) && a !== '.' && !a.endsWith('/')),
    ),
  },
  {
    prefix: 'gh pr merge',
    // `--admin` bypasses branch-protection requirements — the one gh flag here
    // that defeats a repo's own safety configuration.
    argsOk: (args) => args.every((a) => new Set([
      '--squash', '-s', '--merge', '-m', '--rebase', '-r',
      '--delete-branch', '-d', '--auto',
    ]).has(a) || PLAIN_OPERAND.test(a)),
  },
];

/**
 * The prefixes above, by name — exported so callers and tests can reason about
 * which prefixes are NOT blanket-approved with arbitrary arguments, without
 * hardcoding the list a second time.
 */
export const ARGUMENT_SENSITIVE_COMMANDS = ARGUMENT_SENSITIVE_PREFIXES.map((s) => s.prefix);

/** Every whitespace-separated argument after an argument-sensitive prefix is known-safe. */
function argsAreSafe(segment, spec) {
  const tail = segment.slice(spec.prefix.length).trim();
  // `node` with no argument opens a REPL, which an unattended session must not
  // silently enter, so its argsOk rejects the empty list rather than shortcutting.
  return spec.argsOk(tail === '' ? [] : tail.split(/\s+/));
}

/**
 * True only if the command carries no shell metacharacter (see
 * SHELL_METACHARACTERS) AND every shell-separated segment matches one of
 * `ALLOWED_COMMAND_PREFIXES` at a word boundary (exact match, or the prefix
 * followed by a space) AND, for an argument-sensitive prefix, carries only
 * known-safe arguments (see ARGUMENT_SENSITIVE_PREFIXES). A single
 * unrecognised segment in a chained command (e.g.
 * `gh pr view 1 && curl evil.example`) fails the whole command — the safe
 * default for anything not fully known-good is `ask`, not `allow`.
 *
 * Prefix matching alone is NOT sufficient and must never be used without both
 * guards: it constrains only how a command STARTS, leaving the tail free to
 * redirect or substitute (`git status > f`, `git push $(x)`) or to turn the
 * verb itself destructive (`git push --mirror`).
 *
 * This performs no denylist check of its own; callers MUST run the denylist
 * first and only consult this for commands the denylist has already cleared
 * (#429 AC.3 — denylist strictly outranks allowlist).
 */
export function isAllowedCommand(command, { segments } = {}) {
  if (typeof command !== 'string' || command.trim().length === 0) return false;
  // Checked against the FULL command, not per-segment: a metacharacter is
  // disqualifying wherever it appears, including inside a separator the
  // splitter would otherwise consume.
  if (SHELL_METACHARACTERS.test(command)) return false;
  const segs = segments ? segments(command) : [command];
  if (segs.length === 0) return false;
  return segs.every((seg) => {
    const trimmed = seg.trim();
    const matched = ALLOWED_COMMAND_PREFIXES.find(
      (prefix) => trimmed === prefix || trimmed.startsWith(`${prefix} `),
    );
    if (matched === undefined) return false;
    const sensitive = ARGUMENT_SENSITIVE_PREFIXES.find((s) => s.prefix === matched);
    return sensitive ? argsAreSafe(trimmed, sensitive) : true;
  });
}
