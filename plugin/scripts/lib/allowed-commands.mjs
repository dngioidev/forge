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
 * True only if EVERY shell-separated segment of `command` matches one of
 * `ALLOWED_COMMAND_PREFIXES` at a word boundary (exact match, or the prefix
 * followed by a space). A single unrecognised segment in a chained command
 * (e.g. `gh pr view 1 && curl evil.example`) fails the whole command — the
 * safe default for anything not fully known-good is `ask`, not `allow`.
 *
 * This performs no denylist check of its own; callers MUST run the denylist
 * first and only consult this for commands the denylist has already cleared
 * (#429 AC.3 — denylist strictly outranks allowlist).
 */
export function isAllowedCommand(command, { segments } = {}) {
  if (typeof command !== 'string' || command.trim().length === 0) return false;
  const segs = segments ? segments(command) : [command];
  if (segs.length === 0) return false;
  return segs.every((seg) => {
    const trimmed = seg.trim();
    return ALLOWED_COMMAND_PREFIXES.some(
      (prefix) => trimmed === prefix || trimmed.startsWith(`${prefix} `),
    );
  });
}
