#!/usr/bin/env node
/**
 * Claude Code status line (spec §7 — situation-aware since SP3).
 * Prints: `[glyph ]forge #<ticket> <branch>`. The glyph appears only when a
 * human is needed (🔒 security-response, 🔥 incident, 🚩n pending decisions)
 * — quiet while building/idle. A status line must never break a session:
 * any error prints nothing (or drops the glyph) and exits 0.
 */
import { run } from './lib/exec.mjs';
import { parseBranch } from './lib/ticket.mjs';
import { deriveSituation } from './lib/situation.mjs';

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

  // Situation glyph: local files only (.forge/) — never a network call.
  let prefix = '';
  try {
    const s = await deriveSituation(cwd, { blocked: 0, inProgress: 0 });
    if (s.key === 'security-response' || s.key === 'incident') prefix = `${s.glyph} `;
    else if (s.key === 'awaiting-decision') prefix = `🚩${s.pendingCount} `;
  } catch { /* glyph is optional */ }

  process.stdout.write(prefix + (parsed.ticket != null ? `forge #${parsed.ticket} ${branch}` : `forge ${branch}`));
} catch {
  // silent by design
}
process.exit(0);
