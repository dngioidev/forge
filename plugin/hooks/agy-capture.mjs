#!/usr/bin/env node
/**
 * Antigravity (agy) PostToolUse capture shim (learning-loop evidence).
 * agy PostToolUse contract: JSON on stdin, expects an empty object `{}` on stdout.
 * Appends a minimal, self-contained journal line to <workspace>/.forge/agy-journal.jsonl
 * (no message CONTENT - only tool metadata). Self-contained: no dependency on the
 * plugin's scripts/ tree, which agy does not copy into the plugin dir.
 */
import { appendFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

async function main() {
  let raw = '';
  for await (const chunk of process.stdin) raw += chunk;
  let payload = {};
  try { payload = JSON.parse(raw); } catch { /* still emit {} */ }

  try {
    const ws = (payload?.workspacePaths && payload.workspacePaths[0]) || process.cwd();
    const dir = join(ws, '.forge');
    await mkdir(dir, { recursive: true });
    // Metadata only: never persist raw command output. `error` is bounded to a short
    // string so a failed command that echoed a secret cannot land verbatim in the journal.
    const err = payload?.error == null ? null : String(payload.error).slice(0, 200);
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      host: 'agy',
      stepIdx: payload?.stepIdx ?? null,
      error: err,
    }) + '\n';
    await appendFile(join(dir, 'agy-journal.jsonl'), line);
  } catch { /* capture is best-effort; never fail the loop */ }

  process.stdout.write('{}');
}

main().catch(() => process.stdout.write('{}'));
