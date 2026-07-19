#!/usr/bin/env node
/**
 * PreToolUse denylist hook (spec §7 trigger + §13 blast-radius; plan T4).
 * Blocks destructive commands with an escalate-instead message. Exit 2 =
 * block (stderr shown to the model); any internal error fails OPEN (exit 0)
 * — a safety hook must never take the session down (AC-3.4).
 */

const SAFE_RM_TARGETS = /(node_modules|\.forge|dist|build|coverage|te?mp|\$TMP|\$TEMP|scratchpad)/i;
const PROTECTED_BRANCHES = /\b(main|master|staging|production)\b/;

export const RULES = [
  {
    name: 'force-push',
    test: (c) => /\bgit\b[^\n]*\bpush\b/.test(c) && /(\s--force\b(?!-with-lease)|\s-f\b)/.test(c),
    msg: 'git push --force/-f rewrites published history',
  },
  {
    name: 'env-branch-delete',
    test: (c) => (/\bgit\b[^\n]*\bpush\b[^\n]*(--delete|:)/.test(c) || /\bgit branch\b[^\n]*-D/.test(c)) && PROTECTED_BRANCHES.test(c),
    msg: 'deleting main/environment branches is never agent work',
  },
  {
    name: 'hard-reset',
    test: (c) => /\bgit\b[^\n]*\breset\s+--hard\b/.test(c),
    msg: 'git reset --hard discards work irrecoverably',
  },
  {
    name: 'git-clean-force',
    test: (c) => /\bgit\b[^\n]*\bclean\b[^\n]*-[a-zA-Z]*f/.test(c),
    msg: 'git clean -f deletes untracked files irrecoverably',
  },
  {
    name: 'history-rewrite',
    test: (c) => /\bgit\b[^\n]*\b(filter-branch|filter-repo)\b/.test(c),
    msg: 'history rewriting is escalation-only (secrets are scrubbed by rotation, not rewrites — spec §4 respond)',
  },
  {
    name: 'recursive-delete',
    test: (c) => {
      const m = /\brm\s+(-[a-zA-Z]+\s+)*/.exec(c);
      if (!m) return false;
      const flags = c.match(/\brm\s+((-[a-zA-Z]+\s*)+)/);
      if (!flags || !/r/.test(flags[1]) || !/f/.test(flags[1])) return false;
      const rest = c.slice(c.indexOf('rm'));
      return !SAFE_RM_TARGETS.test(rest);
    },
    msg: 'rm -rf outside build/temp dirs',
  },
];

/**
 * Split a command line into sub-commands on shell separators (&& || ; | newline)
 * so each rule tests ONE sub-command, not the whole string. Without this a benign
 * chained call false-positives — e.g. `git push … && gh api graphql -f query=…`
 * tripped force-push because `git push` and an unrelated `-f` were both present
 * somewhere in the string (#85). Over-splitting is safe: a destructive command is
 * still fully contained in its own segment.
 */
export function segments(command) {
  return command.split(/&&|\|\||[;|\n]/).map((s) => s.trim()).filter(Boolean);
}

export function check(command) {
  if (typeof command !== 'string' || command.length === 0) return { blocked: false };
  const segs = segments(command);
  for (const rule of RULES) {
    if (segs.some((seg) => rule.test(seg))) return { blocked: true, rule: rule.name, msg: rule.msg };
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
    message:
      `forge denylist blocked this command (${res.rule}): ${res.msg}. ` +
      `Destructive actions require a human decision — escalate instead: ` +
      `node plugin/scripts/board/escalate.mjs --issue <n> --reason "..." --options "do it|alternative" (spec §7).`,
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

const isHookRun = process.argv[1] && /denylist\.mjs$/.test(process.argv[1]);
if (isHookRun) main().then((code) => process.exit(code)).catch(() => process.exit(0)); // fail open
