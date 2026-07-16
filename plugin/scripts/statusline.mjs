#!/usr/bin/env node
/**
 * Claude Code status line (spec §7, plan T7 — minimal SP1 form).
 * Prints: `forge #<ticket> <branch>` — or `forge <branch>` when the branch
 * carries no ticket. A status line must never break a session: any error
 * prints nothing and exits 0. Situation-aware upgrade lands with SP3.
 */
import { run } from './lib/exec.mjs';
import { parseBranch } from './lib/ticket.mjs';

async function readStdin() {
  let data = '';
  for await (const chunk of process.stdin) data += chunk;
  return data;
}

try {
  const raw = await readStdin();
  let cwd = process.cwd();
  try {
    const payload = JSON.parse(raw);
    cwd = payload?.workspace?.current_dir || payload?.cwd || cwd;
  } catch { /* no/invalid payload — fall back to cwd */ }

  const res = await run('git', ['-C', cwd, 'rev-parse', '--abbrev-ref', 'HEAD']);
  if (!res.ok) process.exit(0);
  const branch = res.stdout.trim();
  const parsed = parseBranch(branch);
  process.stdout.write(parsed.ticket != null ? `forge #${parsed.ticket} ${branch}` : `forge ${branch}`);
} catch {
  // silent by design
}
process.exit(0);
