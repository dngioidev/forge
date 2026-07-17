#!/usr/bin/env node
/**
 * graphctl (spec §9; SP8 T5) — the graph's CLI face:
 *   rebuild             full reindex (wipes derived state, re-derives ticket edges)
 *   reindex <files…>    incremental: only the named files' rows change
 *   tickets             git log issue-ref scan -> ticket edges
 *   install-hook        writes .git/hooks/post-commit (explicit opt-in — plugins
 *                       cannot install git hooks themselves; idempotent)
 */
import { readFile, writeFile, mkdir, access } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { run } from '../lib/exec.mjs';
import { openDb, upsertNode, upsertEdge, counts } from '../../mcp/graph/db.mjs';
import { rebuild, indexFiles } from '../../mcp/graph/indexer.mjs';

const TICKET_REF_RE = /\(#(\d+)\)/g;
const SUBJECT_PREFIX = '@@forge@@';

/**
 * Parse `git log --name-only --format=@@forge@@%s` output into ticket -> files.
 * The prefix disambiguates subjects from filenames — a ref-less subject would
 * otherwise be indistinguishable from a path.
 */
export function parseTicketLog(logText) {
  const map = new Map();
  let current = [];
  for (const line of logText.split(/\r?\n/)) {
    if (line.startsWith(SUBJECT_PREFIX)) {
      current = [...line.matchAll(TICKET_REF_RE)].map((m) => m[1]);
    } else if (line.trim() && current.length > 0) {
      const file = line.trim().split('\\').join('/');
      for (const t of current) {
        if (!map.has(t)) map.set(t, new Set());
        map.get(t).add(file);
      }
    }
  }
  return map;
}

export async function scanTickets(db, cwd, execFn = run) {
  const res = await execFn('git', ['log', '--name-only', `--format=${SUBJECT_PREFIX}%s`], { cwd });
  if (!res.ok) return { ok: false, error: res.stderr || 'git log failed' };
  const map = parseTicketLog(res.stdout);
  let edges = 0;
  for (const [ticket, files] of map) {
    upsertNode(db, { id: `ticket:#${ticket}`, kind: 'ticket', name: `#${ticket}` });
    for (const f of files) {
      upsertEdge(db, { src: `ticket:#${ticket}`, dst: `file:${f}`, kind: 'ticket' });
      edges++;
    }
  }
  return { ok: true, tickets: map.size, edges };
}

export const HOOK_MARKER = '# forge-graph post-commit';
const HOOK_BODY = `#!/bin/sh
${HOOK_MARKER}
changed=$(git diff-tree --no-commit-id --name-only -r HEAD -- '*.ts' '*.tsx')
[ -n "$changed" ] && node "$(dirname "$0")/../../plugin/scripts/graph/graphctl.mjs" reindex $changed >/dev/null 2>&1 || true
`;

export async function installHook(cwd) {
  const hooksDir = join(cwd, '.git', 'hooks');
  const hookPath = join(hooksDir, 'post-commit');
  const gitExists = await access(join(cwd, '.git')).then(() => true, () => false);
  if (!gitExists) return { ok: false, error: 'not a git repository' };
  const existing = await readFile(hookPath, 'utf8').catch(() => null);
  if (existing?.includes(HOOK_MARKER)) return { ok: true, installed: false, note: 'hook already present' };
  if (existing != null) return { ok: false, error: `a post-commit hook already exists at ${hookPath} — merge the forge-graph reindex line in manually (marker: "${HOOK_MARKER}")` };
  await mkdir(hooksDir, { recursive: true });
  await writeFile(hookPath, HOOK_BODY, { encoding: 'utf8', mode: 0o755 });
  return { ok: true, installed: true, path: hookPath };
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  const [cmd, ...rest] = process.argv.slice(2);
  const cwd = process.cwd();
  const fail = (msg) => { console.error(msg); process.exit(1); };
  if (cmd === 'rebuild') {
    const db = openDb(cwd);
    rebuild(db, cwd).then(async (res) => {
      if (!res.ok) fail(res.error);
      const t = await scanTickets(db, cwd);
      if (!t.ok) fail(t.error);
      console.log(`graph: ${res.files} files indexed, ${t.tickets} tickets linked — ${JSON.stringify(counts(db))}`);
    });
  } else if (cmd === 'reindex') {
    if (rest.length === 0) fail('usage: graphctl reindex <files…>');
    const db = openDb(cwd);
    indexFiles(db, cwd, rest).then((res) => {
      if (!res.ok) fail(res.error);
      console.log(`graph: ${res.files} files reindexed`);
    });
  } else if (cmd === 'tickets') {
    const db = openDb(cwd);
    scanTickets(db, cwd).then((res) => {
      if (!res.ok) fail(res.error);
      console.log(`graph: ${res.tickets} tickets, ${res.edges} ticket edges`);
    });
  } else if (cmd === 'install-hook') {
    installHook(cwd).then((res) => {
      if (!res.ok) fail(res.error);
      console.log(res.installed ? `graph: post-commit hook installed at ${res.path}` : `graph: ${res.note}`);
    });
  } else {
    fail('usage: graphctl <rebuild|reindex <files…>|tickets|install-hook>');
  }
}
