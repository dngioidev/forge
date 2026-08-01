#!/usr/bin/env node
/**
 * Antigravity (agy) PreToolUse denylist shim.
 * Translates agy's hook I/O contract around forge's host-agnostic `check()`:
 *   - stdin  (agy): { toolCall: { name, args: { CommandLine } }, ... } (camelCase)
 *   - stdout (agy): { "decision": "deny" | "allow", "reason"? }
 * agy's matcher already scopes this to `run_command`; we re-check defensively.
 * Fails OPEN (allow) on any internal error - a safety hook must never wedge the loop.
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
      out = {
        decision: 'deny',
        reason: escalateMessage(res.rule, res.msg),
      };
    }
  }
  process.stdout.write(JSON.stringify(out));
}

main().catch(() => process.stdout.write('{"decision":"allow"}'));
