#!/usr/bin/env node
/**
 * Antigravity (agy) PreToolUse denylist shim.
 * Translates agy's hook I/O contract around forge's host-agnostic `check()`:
 *   - stdin  (agy): { toolCall: { name, args: { CommandLine } }, ... } (camelCase)
 *   - stdout (agy): { "decision": "deny" | "allow", "reason"? }
 * agy's matcher already scopes this to `run_command`; we re-check defensively.
 * Fails OPEN (allow) on any internal error — a safety hook must never wedge the loop.
 *
 * NOTE: this file must NOT be named "*denylist.mjs" — denylist.mjs's self-exec
 * guard `/denylist\.mjs$/` is unanchored and would re-fire on import.
 */
import { check } from './denylist.mjs';

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
        reason:
          `forge denylist blocked this command (${res.rule}): ${res.msg}. ` +
          `Destructive actions require a human decision — escalate instead of forcing them (spec §7).`,
      };
    }
  }
  process.stdout.write(JSON.stringify(out));
}

main().catch(() => process.stdout.write('{"decision":"allow"}'));
