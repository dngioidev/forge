#!/usr/bin/env node
/**
 * Doc-sync gate (#136): keep the repo's docs in step with what ships. Two
 * mechanical, fail-closed checks run at ship — so manual `ship`, `forge:deliver`,
 * and `forge:autopilot` all inherit them:
 *   1. every doc under docs/ is listed in the docs/README.md route index;
 *   2. a newly-added skill is mentioned in the handbook.
 * (Releases stay current on their own — release.mjs derives the CHANGELOG from
 * conventional commits. Wiki publish is a separate post-release step.)
 */
import { readFile, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { run } from '../lib/exec.mjs';

export const ROUTE_INDEX = 'docs/README.md';
export const HANDBOOK = 'docs/guides/handbook.md';

/** Relative-to-docs/ .md links referenced in the route index (skips http + anchors). */
export function parseRouteLinks(indexText) {
  const links = new Set();
  for (const m of (indexText ?? '').matchAll(/\]\(([^)]+?\.md)(?:#[^)]*)?\)/g)) {
    const href = m[1].trim();
    if (/^https?:/i.test(href)) continue;
    links.add(href.replace(/^\.\//, '').replaceAll('\\', '/'));
  }
  return links;
}

/** Docs present on disk but absent from the route index (README.md excludes itself). */
export function routeIndexGaps(docFiles, linkedSet) {
  return docFiles.filter((f) => f !== 'README.md' && !linkedSet.has(f)).sort();
}

/** Skill dir-names for added plugin/skills/<name>/SKILL.md paths. */
export function addedSkills(addedFiles) {
  const names = [];
  for (const f of addedFiles) {
    const m = /^plugin\/skills\/([^/]+)\/SKILL\.md$/.exec(f.replaceAll('\\', '/'));
    if (m) names.push(m[1]);
  }
  return [...new Set(names)];
}

/** Added skills whose name never appears in the handbook. */
export function skillHandbookGaps(skillNames, handbookText) {
  const text = handbookText ?? '';
  return skillNames.filter((n) => !text.includes(n)).sort();
}

/** Recursively list .md files under docs/, relative to docs/ (posix slashes). */
async function listDocFiles(docsDir) {
  let entries;
  try { entries = await readdir(docsDir, { recursive: true, withFileTypes: true }); }
  catch { return []; }
  return entries
    .filter((e) => e.isFile() && e.name.endsWith('.md'))
    .map((e) => join(e.parentPath ?? e.path, e.name))
    .map((p) => p.slice(docsDir.length + 1).replaceAll('\\', '/'));
}

export async function runDocSync({ cwd, base = 'main', execFn = run, log = console.log }) {
  const docsDir = resolve(cwd, 'docs');
  const indexText = await readFile(join(docsDir, 'README.md'), 'utf8').catch(() => null);
  if (indexText === null) {
    log('doc-sync: no docs/README.md route index — skipping (nothing to enforce)');
    return { ok: true, routeGaps: [], skillGaps: [], skipped: true };
  }
  const docFiles = await listDocFiles(docsDir);
  const routeGaps = routeIndexGaps(docFiles, parseRouteLinks(indexText));

  const diff = await execFn('git', ['-C', cwd, 'diff', '--name-only', '--diff-filter=A', `${base}...HEAD`]);
  if (!diff.ok) return { ok: false, error: `git diff failed: ${diff.stderr}` };
  const added = diff.stdout.split(/\r?\n/).filter(Boolean);
  const handbookText = await readFile(resolve(cwd, HANDBOOK), 'utf8').catch(() => null);
  const skillGaps = skillHandbookGaps(addedSkills(added), handbookText);

  for (const g of routeGaps) log(`✗ docs/${g} is not linked in ${ROUTE_INDEX}`);
  for (const s of skillGaps) log(`✗ new skill '${s}' is not mentioned in ${HANDBOOK}`);
  const ok = routeGaps.length === 0 && skillGaps.length === 0;
  if (ok) log(`doc-sync: clean (${docFiles.length} docs indexed${skillGaps.length === 0 ? '' : ''})`);
  else log(`doc-sync: ${routeGaps.length} unindexed doc(s), ${skillGaps.length} undocumented skill(s) — update the route index / handbook before shipping`);
  return { ok, routeGaps, skillGaps };
}

export function parseArgs(argv) {
  const a = { base: 'main' };
  for (let i = 0; i < argv.length; i++) if (argv[i] === '--base') a.base = argv[++i];
  return a;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  const args = parseArgs(process.argv.slice(2));
  runDocSync({ cwd: process.cwd(), base: args.base }).then((res) => {
    if (res.error) console.error(res.error);
    process.exit(res.ok ? 0 : 1);
  });
}
