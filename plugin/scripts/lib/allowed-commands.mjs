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
  'git add',
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
 * the verb entirely. Eight do — keep this list in step with the array below and
 * with the guarded-verbs table in docs/guides/cross-gai.md:
 *   `node`          — `-e`/`--eval`/`-p` is unrestricted code execution
 *   `pnpm verify`   — pnpm forwards args to vitest, whose `--reporter=<path>`
 *                     / `--config=<path>` import()s that module at startup
 *   `git push`      — force / delete / mirror / refspec rewrite published refs
 *   `git add`       — `-p`/`-i` are interactive prompt loops; `-e`/`--edit`
 *                     opens the patch in `$EDITOR` — an arbitrary program launch
 *   `git fetch`     — `--upload-pack=<program>` executes that program
 *   `git rebase`    — `-x`/`--exec` runs arbitrary shell per replayed commit
 *   `git checkout`  — `-- .` / `-f` / a bare path silently discards local work
 *   `gh pr merge`   — `--admin` bypasses branch protection
 *
 * Note what five of those eight have in common: `node -e`, `pnpm verify
 * --reporter=`, `git rebase -x`, `git fetch --upload-pack=` and `git add -e`
 * are all arbitrary code execution reached through a verb that looks
 * innocuous, and NONE of them needs a shell metacharacter — SHELL_METACHARACTERS
 * cannot see them. Each of the first four was found by a separate adversarial
 * review round; `git add -e` was identified by threat-modeling the same class
 * before it ever reached this file (#444). When adding a verb to
 * ALLOWED_COMMAND_PREFIXES, the question to ask is not "is this verb safe" but
 * "can any argument make it run something else, read/write an arbitrary path,
 * or rewrite published history".
 *
 * The rest of ALLOWED_COMMAND_PREFIXES are safe for any argument (`git status`,
 * `gh issue view`, …) or are read-only.
 */

/**
 * HOST SCOPE — these guards are enforced by `isAllowedCommand()`, whose only
 * consumer is the agy PreToolUse hook. The Claude host consumes only the raw
 * prefix list above, because `.claude/settings.local.json`'s grammar is a
 * prefix glob (`Bash(node:*)`) with no way to constrain arguments. So the
 * command SET is single-sourced across hosts, but this argument narrowing is
 * agy-only. Stated here rather than left implicit: closing it Claude-side would
 * need either denylist rules that over-block legitimate use (`node -e` is a
 * normal thing to type) or dropping `node` from the grant, which would break
 * the whole script tier.
 */

/** A bare operand: a ref, remote, path or number — never a flag (`-`) or force refspec (`+`). */
const PLAIN_OPERAND = /^[A-Za-z0-9._][A-Za-z0-9._/-]*$/;

/** argsOk for "a fixed set of inert flags, plus any number of plain operands". */
const flagsAndOperands = (...safeFlags) => {
  const allowed = new Set(safeFlags);
  return (args) => args.every((a) => allowed.has(a) || PLAIN_OPERAND.test(a));
};

const ARGUMENT_SENSITIVE_PREFIXES = [
  {
    prefix: 'node',
    // node stops parsing its OWN options at the first non-option argument, so
    // "the first argument is a plain script path" is sufficient: everything
    // after it belongs to the script, not to node. This is what stops
    // `node -e "<code>"` / `--eval` / `-p` / `-` (read program from stdin) —
    // unrestricted INLINE code execution — while leaving the forge script tier
    // (`node scripts/x.mjs --flag`) auto-approved, which is the whole reason
    // `node` is on the allowlist.
    //
    // Honest scope limit: this validates that a SCRIPT PATH was given, not
    // WHICH script. `node <any-on-disk-path>` still auto-approves, including
    // one outside the repo. Running an arbitrary on-disk script is the
    // capability this allowlist entry deliberately grants; narrowing it to
    // forge's own script tree is tracked separately (see #438), not silently
    // implied here.
    argsOk: (args) => args.length > 0 && PLAIN_OPERAND.test(args[0]),
  },
  {
    prefix: 'pnpm verify',
    // `conventions.verify` is the literal string `pnpm verify`, and pnpm
    // forwards any trailing arguments straight through to the underlying
    // script (`vitest run`). vitest's `--reporter=<path>` and `--config=<path>`
    // dynamically import() that module at startup, BEFORE any test runs — so an
    // unguarded trailing argument is arbitrary code execution, the same class
    // just closed for `node -e`. Agents only ever run the bare command, so the
    // bare command is all that auto-approves.
    argsOk: (args) => args.length === 0,
  },
  {
    prefix: 'git push',
    // Flags that cannot force, delete, or rewrite anything. `--force-with-lease`
    // is deliberately NOT here: it is permitted by the denylist as the sanctioned
    // safe alternative, but it is still a force operation, so a human should see
    // it rather than have it auto-approved.
    argsOk: flagsAndOperands(
      '-u', '--set-upstream',
      '-q', '--quiet',
      '-v', '--verbose',
      '--progress', '--no-progress',
      '--porcelain', '--dry-run',
    ),
  },
  {
    prefix: 'git add',
    // `git add` is non-destructive in its common form — it stages, it never
    // discards. But `-p`/`--patch` and `-i`/`--interactive` are interactive
    // prompt loops an unattended session must not silently enter, and
    // `-e`/`--edit` opens the staged diff in `$EDITOR` — an arbitrary program
    // launch, the same class as `node -e` / `git rebase -x`. All three are
    // excluded by OMISSION, not by a blocklist entry: they simply aren't in
    // the safe set below, so an unrecognised flag (including any abbreviation
    // of one of them, e.g. `--edi` — verified against live git 2.55 to resolve
    // to `--edit`, since no other `git add` long option starts "edi") falls to
    // `ask` the same way it does for every other argument-sensitive prefix
    // here.
    //
    // `-f`/`--force` is ALSO excluded by omission, and deliberately not in the
    // "safe" set an earlier draft of this guard shipped it in (#444 adversarial
    // security review). Its danger isn't destruction — staging an otherwise-
    // ignored file overwrites nothing — it's EXFILTRATION: `-f`/`--force` is
    // git's literal mechanism for overriding `.gitignore`, and this repo's own
    // `.gitignore` protects exactly the class of file that matters
    // (`runner.env`, carrying `FORGE_RUNNER_PAT` per
    // docs/guides/runner-adoption.md). `git add --force runner.env` followed by
    // the already-unguarded `git commit`/`git push` is a zero-human-checkpoint
    // path from a gitignored credential to a pushed commit. Every other flag
    // below stages only and changes nothing about WHICH protection a file has:
    // `-A`/`--all` and `-u`/`--update` widen which tracked/untracked files are
    // staged but do NOT bypass `.gitignore` on their own (only `--force` does);
    // `-n`/`--dry-run`, `-v`/`--verbose`, `--sparse`, `--refresh`,
    // `--ignore-errors`, `--ignore-missing`, `--no-warn-embedded-repo` and
    // `--renormalize` are all inert w.r.t. both destructiveness and secrecy.
    argsOk: flagsAndOperands(
      '-A', '--all', '--no-ignore-removal',
      '-u', '--update',
      '-n', '--dry-run',
      '-v', '--verbose',
      '--sparse', '--refresh',
      '--ignore-errors', '--ignore-missing', '--no-warn-embedded-repo',
      '--renormalize',
    ),
  },
  {
    prefix: 'git fetch',
    // `git fetch --upload-pack=<program>` (and its unambiguous abbreviations,
    // e.g. `--up=`) overrides the remote helper and EXECUTES that program for
    // local/file transports — arbitrary execution behind an ordinary-looking
    // fetch, again with no shell metacharacter needed. `git push`'s mirror-image
    // trick, `--receive-pack=`, is already excluded by that verb's safe-flag set.
    argsOk: flagsAndOperands(
      '--all', '--tags', '--no-tags', '--prune', '-p',
      '-q', '--quiet', '-v', '--verbose',
    ),
  },
  {
    prefix: 'git rebase',
    // `git rebase -x/--exec "<cmd>"` runs an ARBITRARY SHELL COMMAND after every
    // replayed commit — full command execution behind an ordinary-looking rebase,
    // and it needs no shell metacharacter to do it (`git rebase -x "touch pwned"`
    // is plain text). `-i/--interactive` also opens an editor, which an
    // unattended session must not silently enter. So only the flow-control flags
    // and plain refs auto-approve.
    argsOk: flagsAndOperands(
      '--continue', '--abort', '--skip', '--onto',
      '-q', '--quiet', '--autostash',
    ),
  },
  {
    prefix: 'git checkout',
    // `git checkout <name>` is genuinely AMBIGUOUS: git resolves <name> as a ref
    // if one exists and otherwise as a path, and `git checkout <path>` discards
    // that path's uncommitted changes irrecoverably. Nothing in the string tells
    // the two apart — `main` is a ref, `package.json` is a file, `src` could be
    // either, and no heuristic (dots, slashes, extensions) separates them
    // reliably. So rather than guess, only the unambiguously non-destructive
    // form auto-approves: branch CREATION (`-b <name>`, optionally from a start
    // point). Every other checkout — including the common, harmless
    // `git checkout main` — asks. That costs about one prompt per ticket and
    // closes the whole ref-or-path class instead of heuristically half-closing it.
    argsOk: (args) => args.includes('-b') && args.every((a) => a === '-b' || PLAIN_OPERAND.test(a)),
  },
  {
    prefix: 'gh pr merge',
    // `--admin` bypasses branch-protection requirements — the one gh flag here
    // that defeats a repo's own safety configuration.
    argsOk: flagsAndOperands(
      '--squash', '-s', '--merge', '-m', '--rebase', '-r',
      '--delete-branch', '-d', '--auto',
    ),
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
