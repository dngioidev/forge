#!/usr/bin/env node
/**
 * forge:release runner (spec §4 item 7): readiness → bump → CHANGELOG →
 * annotated tag → GitHub Release → image retag / npm publish. Release NAMES
 * artifacts, it never builds them. `--dry-run` previews without writing.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { run, makeGh } from '../lib/exec.mjs';
import { loadConfig } from '../lib/config.mjs';
import { getRepoInfo } from '../lib/board.mjs';
import { computeReadiness } from './readiness.mjs';
import { deriveBump, nextVersion, groupChanges, renderChangelogSection, renderReleaseBody, summarize } from './core.mjs';

export function parseArgs(argv) {
  return { dryRun: argv.includes('--dry-run') };
}

export async function runRelease(ctx, args, log = console.log) {
  const { cwd, gh, execFn = run } = ctx;
  const git = (...a) => execFn('git', a);
  const cfg = await loadConfig(cwd);
  const config = cfg.ok ? cfg.config : {};
  const repo = await getRepoInfo(gh);
  const repoUrl = repo.ok ? `https://github.com/${repo.owner}/${repo.name}` : null;

  // 1. readiness
  const readiness = await computeReadiness({ cwd, execFn, config, verifyCmd: config.conventions?.verify });
  for (const i of readiness.items) log(`${i.level === 'pass' ? '✓' : i.level === 'skip' ? '·' : '✗'} ${i.name.padEnd(16)} ${i.msg}`);
  if (!readiness.ok) return { ok: false, error: 'release-readiness checklist failed (see above)' };

  // 2. delta since last tag
  const lastTag = await git('describe', '--tags', '--abbrev=0', '--match', 'v*');
  const tag = lastTag.ok ? lastTag.stdout.trim() : null;
  const range = tag ? `${tag}..HEAD` : 'HEAD';
  const logRes = await git('log', range, '--format=%s');
  if (!logRes.ok) return { ok: false, error: 'git log failed' };
  const subjects = logRes.stdout.split(/\r?\n/).filter(Boolean).filter((s) => !s.startsWith('chore(release)'));
  if (subjects.length === 0) return { ok: false, error: `no releasable commits since ${tag ?? 'the beginning'}` };

  const bump = deriveBump(subjects);
  if (!bump) return { ok: false, error: 'no conventional commits in the delta — nothing to release' };
  const version = tag ? nextVersion(tag, bump) : '0.1.0';
  const groups = groupChanges(subjects);

  // deploy notes
  const diffRange = tag ? `${tag}..HEAD` : 'HEAD';
  const changed = await git('diff', '--name-only', ...(tag ? [tag, 'HEAD'] : ['HEAD'])); // full-tree list on first release
  const files = changed.ok ? changed.stdout.split(/\r?\n/) : [];
  const infraChanged = files.some((f) => f.startsWith('infra/'));
  const migrations = config.deploy?.migrations != null && files.some((f) => f.includes('migrations/'));

  // image digest (deploy repos): the staging-built image for HEAD, if any
  let imageDigest = null;
  if (config.features?.deploy === true && repo.ok) {
    const head = await git('rev-parse', 'HEAD');
    if (head.ok) imageDigest = `ghcr.io/${repo.owner.toLowerCase()}/${repo.name}:sha-${head.stdout.trim()}`;
  }

  const date = new Date().toISOString().slice(0, 10);
  const section = renderChangelogSection(version, date, groups, repoUrl);
  const body = renderReleaseBody({ version, summary: summarize(groups, version), groups, repoUrl, infraChanged, migrations, imageDigest });

  if (args.dryRun) {
    log(`\n— dry run — would release v${version} (${bump} bump from ${tag ?? 'no prior tag'})`);
    log(section);
    return { ok: true, dryRun: true, version, bump, body };
  }

  // 3. changelog commit
  const clPath = join(cwd, 'CHANGELOG.md');
  let cl = '';
  try { cl = await readFile(clPath, 'utf8'); } catch { cl = '# Changelog\n\n'; }
  const marker = '# Changelog\n\n';
  const updated = cl.startsWith(marker) ? marker + section + '\n' + cl.slice(marker.length) : section + '\n' + cl;
  await writeFile(clPath, updated, 'utf8');
  const add = await git('add', 'CHANGELOG.md');
  const commit = add.ok && (await git('commit', '-m', `chore(release): v${version}`));
  if (!commit.ok) return { ok: false, error: 'changelog commit failed' };

  // 4. annotated tag + push
  const tagged = await git('tag', '-a', `v${version}`, '-m', `v${version}`);
  if (!tagged.ok) return { ok: false, error: `tag failed: ${tagged.stderr}` };
  const pushed = await git('push', 'origin', 'main', `v${version}`);
  if (!pushed.ok) return { ok: false, error: `push failed: ${pushed.stderr}` };

  // 5. GitHub Release
  const rel = await gh(['release', 'create', `v${version}`, '--title', `v${version}`, '--notes', body]);
  if (!rel.ok) return { ok: false, error: `gh release create failed: ${rel.stderr}` };

  // 6. artifact naming
  const notes = [];
  if (imageDigest) notes.push(`retag the staging image as v${version}: docker buildx imagetools create -t ${imageDigest.replace(/:sha-.*/, `:v${version}`)} ${imageDigest} (requires registry auth — run where docker is available)`);
  let pkg = null;
  try { pkg = JSON.parse(await readFile(join(cwd, 'package.json'), 'utf8')); } catch { /* no package */ }
  if (pkg && pkg.private !== true) notes.push(`public package — publish with: npm publish (from the v${version} tag)`);

  log(`released v${version}`);
  for (const n of notes) log(`next: ${n}`);
  return { ok: true, version, bump, notes };
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  const gh = makeGh(run);
  runRelease({ gh, cwd: process.cwd() }, parseArgs(process.argv.slice(2))).then((res) => {
    if (!res.ok) { console.error(`release failed: ${res.error}`); process.exit(1); }
  });
}
