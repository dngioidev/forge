#!/usr/bin/env node
/**
 * Antigravity (agy) PreToolUse denylist + allowlist shim.
 * Translates agy's hook I/O contract around forge's host-agnostic `check()`:
 *   - stdin  (agy): { toolCall: { name, args: { CommandLine } }, ... } (camelCase)
 *   - stdout (agy): { "decision": "deny" | "ask" | "allow", "reason"? }
 * agy's matcher already scopes this to `run_command`; we re-check defensively.
 * Fails OPEN (allow) on any internal error - a safety hook must never wedge the loop.
 *
 * SECURITY (#429): per agy's own shipped hook-contract doc (v1.1.7,
 * `~/.gemini/antigravity-cli/builtin/skills/agy-customizations/docs/hooks.md`),
 * `"allow"` auto-approves the tool call and suppresses agy's own prompt - it is
 * NOT "no objection, agy still asks". A blanket `allow` default therefore
 * pre-authorizes every non-denylisted shell command with zero human visibility
 * (the #434 finding). The default for anything NOT explicitly denylisted or
 * allowlisted is now **`ask`** - `allow` is returned only for the known-good
 * command set in `../scripts/lib/allowed-commands.mjs`, single-sourced with the
 * Claude host's own `Bash(...)` allowlist (`../scripts/autopilot/perms.mjs`).
 *
 * PRECEDENCE (#429 AC.3, load-bearing): the denylist is checked FIRST and its
 * `deny` always wins, even for a command that also matches the allowlist - a
 * force-push is a `git push` (allowlisted verb) but is denylisted and MUST
 * still be denied. Never reorder these checks.
 *
 * KNOWN RESIDUAL GAP (#429 AC.5, cannot be closed from forge's side): the
 * spike (docs/spikes/2026-08-12-agy-approval-semantics.md) verified agy's own
 * hook timeout (`emit.mjs`'s `timeout: 10`) fails OPEN at the host level - a
 * hook that doesn't answer within 10s lets the command run, regardless of
 * what this script would have returned. This script stays a synchronous,
 * cheap regex check specifically so 10s is never a realistic ceiling, but a
 * slow/hung Node startup or system stall could still hit it. Documented
 * honestly in docs/guides/cross-gai.md rather than implied away.
 *
 * NOTE: this file must NOT be named "*denylist.mjs" - denylist.mjs's self-exec
 * guard is anchored to its own basename (AC-289.3), so importing check() from
 * here has no side effects. The name is kept deny-not-denylist as belt-and-braces.
 */
import { check } from './denylist.mjs';
// Single-sourced escalate wording (#321), shared with denylist.mjs so the two host
// shims cannot drift the message again. Imported with zero side effects. (This shim
// file stays ASCII-only per the agy emit contract; the message text lives in the lib.)
import { escalateMessage } from '../scripts/lib/escalate-msg.mjs';
import { isAllowedCommand } from '../scripts/lib/allowed-commands.mjs';
import { splitSegments } from '../scripts/lib/shell-split.mjs';

async function main() {
  let raw = '';
  for await (const chunk of process.stdin) raw += chunk;
  let payload = {};
  try { payload = JSON.parse(raw); } catch { /* fail open */ }

  const tool = payload?.toolCall?.name;
  const cmd = payload?.toolCall?.args?.CommandLine ?? '';

  let out = { decision: 'allow' };
  if (tool === 'run_command' && typeof cmd === 'string') {
    const res = check(cmd);
    if (res.blocked) {
      // Denylist always outranks the allowlist (#429 AC.3) - checked first,
      // unconditionally, before isAllowedCommand() is ever consulted.
      out = {
        decision: 'deny',
        reason: escalateMessage(res.rule, res.msg),
      };
    } else if (isAllowedCommand(cmd, { segments: splitSegments })) {
      out = { decision: 'allow' };
    } else {
      // New default (#429 AC.1): anything not explicitly known-good prompts
      // the human instead of being silently pre-authorized.
      out = { decision: 'ask' };
    }
  }
  process.stdout.write(JSON.stringify(out));
}

main().catch(() => process.stdout.write('{"decision":"allow"}'));
