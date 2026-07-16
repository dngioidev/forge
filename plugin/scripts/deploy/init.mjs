#!/usr/bin/env node
/**
 * /forge:deploy-init (spec §10): copy the deploy scaffold into a consumer
 * repo — missing files only, never overwrite — substitute placeholders, and
 * wire the deploy block into forge.json.
 */
import { readdir, readFile, writeFile, mkdir, stat, copyFile } from 'node:fs/promises';
import { join, dirname, resolve, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { run, makeGh } from '../lib/exec.mjs';
import { loadConfig, CONFIG_RELPATH } from '../lib/config.mjs';
import { mergeJson } from '../lib/jsonfile.mjs';
import { getRepoInfo } from '../lib/board.mjs';

const PLUGIN_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

export function parseArgs(argv) {
  const a = { stack: 'node', app: null, healthcheck: '/healthz' };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--stack') a.stack = argv[++i];
    else if (argv[i] === '--app') a.app = argv[++i];
    else if (argv[i] === '--healthcheck') a.healthcheck = argv[++i];
  }
  return a;
}

/** Scaffold file → destination in the consumer repo. */
function destFor(rel) {
  if (rel.startsWith('workflows/')) return join('.github', rel);
  return rel;
}

async function* walk(dir, base = dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(p, base);
    else yield relative(base, p).replaceAll('\\', '/');
  }
}

export async function runDeployInit(ctx, args, log = console.log) {
  const { cwd, gh } = ctx;
  const cfg = await loadConfig(cwd);
  if (!cfg.ok) return { ok: false, error: `${CONFIG_RELPATH} invalid or missing — run /forge:init first` };

  const stackDir = join(PLUGIN_ROOT, 'templates', 'deploy', args.stack);
  try {
    await stat(stackDir);
  } catch {
    return { ok: false, error: `unknown stack '${args.stack}' — available: node` };
  }

  const repo = await getRepoInfo(gh);
  if (!repo.ok) return { ok: false, error: repo.error };
  const app = args.app ?? repo.name;
  const registry = `ghcr.io/${repo.owner.toLowerCase()}`;
  const verify = cfg.config.conventions?.verify ?? 'pnpm verify';
  const substitute = (text) => text
    .replaceAll('{{APP}}', app)
    .replaceAll('{{HEALTHCHECK}}', args.healthcheck)
    .replaceAll('{{REGISTRY}}', registry)
    .replaceAll('{{VERIFY}}', verify);

  const placed = [];
  const skipped = [];
  for await (const rel of walk(stackDir)) {
    const dest = join(cwd, destFor(rel));
    try {
      await stat(dest);
      skipped.push(destFor(rel));
      continue; // never overwrite (AC-4b.1)
    } catch { /* missing — place it */ }
    await mkdir(dirname(dest), { recursive: true });
    await writeFile(dest, substitute(await readFile(join(stackDir, rel), 'utf8')), 'utf8');
    placed.push(destFor(rel));
  }

  // smoke script: consumer-local copy so workflows can run it without the plugin
  const smokeDest = join(cwd, 'scripts', 'forge-smoke.mjs');
  try {
    await stat(smokeDest);
  } catch {
    await mkdir(dirname(smokeDest), { recursive: true });
    await copyFile(join(PLUGIN_ROOT, 'scripts', 'deploy', 'smoke.mjs'), smokeDest);
    placed.push('scripts/forge-smoke.mjs');
  }

  // forge.json: deploy block + feature flag (merge — user edits survive)
  await mergeJson(join(cwd, CONFIG_RELPATH), {
    features: { deploy: true },
    deploy: cfg.config.deploy ?? {
      docker: { file: 'Dockerfile', compose: 'docker-compose.yml', healthcheck: args.healthcheck },
      terraform: { dir: 'infra/', stateBackend: 'gcs' },
      environments: [
        { name: 'staging', branch: 'staging', deploy: 'on-push' },
        { name: 'production', branch: 'production', deploy: 'promote' },
      ],
    },
  });

  // .gitignore: terraform local dirs
  const giPath = join(cwd, '.gitignore');
  let gi = '';
  try { gi = await readFile(giPath, 'utf8'); } catch { /* none */ }
  const giAdds = ['.terraform/', '*.tfstate', '*.tfstate.*'].filter((r) => !gi.split(/\r?\n/).some((l) => l.trim() === r));
  if (giAdds.length) await writeFile(giPath, gi.trimEnd() + (gi.trim() ? '\n' : '') + giAdds.join('\n') + '\n', 'utf8');

  for (const p of placed) log(`placed: ${p}`);
  for (const s of skipped) log(`kept existing: ${s}`);
  log('');
  log('next (human steps, spec §10):');
  log('  1. create + protect the environment branches:  git branch staging && git push -u origin staging  (repeat for production; protect both — merging into them IS the deploy authorization)');
  log('  2. wire your cloud deploy at the INSERT points in .github/workflows/deploy-*.yml');
  log('  3. set repo variables STAGING_URL / PRODUCTION_URL; fill infra/ REPLACE-ME values');
  return { ok: true, placed, skipped };
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  const gh = makeGh(run);
  runDeployInit({ gh, cwd: process.cwd() }, parseArgs(process.argv.slice(2))).then((res) => {
    if (!res.ok) { console.error(`deploy-init failed: ${res.error}`); process.exit(1); }
  });
}
