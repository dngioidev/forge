#!/usr/bin/env node
/**
 * backends sync (spec §5): render forge.json conventions + the static shell
 * template into each CLI's native context file (GEMINI.md, AGENTS.md) as a
 * fenced managed block — hand-written content survives — and write the CLI
 * ignore files so secret-bearing paths never reach third-party models.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadConfig } from '../lib/config.mjs';
import { upsertBlock } from '../lib/markers.mjs';

const PLUGIN_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

export const CONTEXT_FILES = ['GEMINI.md', 'AGENTS.md'];
export const IGNORE_FILES = { '.geminiignore': true, '.codexignore': true };
export const IGNORE_RULES = ['.env*', '*.pem', '*.key', 'id_rsa*', '*.tfstate', '*.tfstate.*', '.terraform/', '.forge/', 'secrets/'];

export async function renderBlock(config) {
  const c = config.conventions ?? {};
  const lines = [
    '## forge conventions (managed — do not edit inside this block)',
    '',
    `- Verify command: \`${c.verify ?? 'pnpm verify'}\` — run it before reporting done.`,
    `- Commit format: ${c.commitFormat ?? 'conventional+issue-ref'} (\`type(scope): subject (#issue)\`).`,
    `- Specs live in \`${c.specsDir ?? 'docs/specs'}\`, plans in \`${c.plansDir ?? 'docs/plans'}\`.`,
    '- Reports end with the forge terminal JSON block (verdict + findings).',
  ];
  if ((c.shell ?? 'windows') === 'windows') {
    const shell = await readFile(join(PLUGIN_ROOT, 'templates', 'shell-windows.md'), 'utf8');
    lines.push('', shell.trim());
  }
  return lines.join('\n');
}

export async function runSync({ cwd, log = console.log }) {
  const cfg = await loadConfig(cwd);
  if (!cfg.ok) return { ok: false, error: cfg.errors[0] };

  const block = await renderBlock(cfg.config);
  for (const file of CONTEXT_FILES) {
    const path = join(cwd, file);
    let current = '';
    try { current = await readFile(path, 'utf8'); } catch { /* new file */ }
    const next = upsertBlock(current, 'context', block);
    if (next !== current) {
      await writeFile(path, next, 'utf8');
      log(`sync: ${file} managed block updated`);
    }
  }

  for (const file of Object.keys(IGNORE_FILES)) {
    const path = join(cwd, file);
    let current = '';
    try { current = await readFile(path, 'utf8'); } catch { /* new file */ }
    const have = new Set(current.split(/\r?\n/).map((l) => l.trim()));
    const missing = IGNORE_RULES.filter((r) => !have.has(r));
    if (missing.length) {
      const next = current.trimEnd() + (current.trim() ? '\n' : '') + missing.join('\n') + '\n';
      await writeFile(path, next, 'utf8');
      log(`sync: ${file} +${missing.length} rules`);
    }
  }
  return { ok: true };
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  runSync({ cwd: process.cwd() }).then((res) => {
    if (!res.ok) { console.error(`sync failed: ${res.error}`); process.exit(1); }
    console.log('backends sync complete');
  });
}
