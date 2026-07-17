#!/usr/bin/env node
/**
 * Dependency-existence guard (spec §13): every NEW package must exist on the
 * registry, be ≥ MIN_AGE_DAYS old, and clear a download floor — blocks
 * hallucinated-package (slopsquatting) supply-chain attacks. npm-only v1.
 */
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { run } from '../lib/exec.mjs';

export const MIN_AGE_DAYS = 90;
export const MIN_WEEKLY_DOWNLOADS = 500;

export function collectDeps(pkg) {
  return { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}), ...(pkg.optionalDependencies ?? {}) };
}

/** New deps = in branch package.json but not in base's. */
export function newDeps(basePkg, branchPkg) {
  const base = collectDeps(basePkg ?? {});
  const branch = collectDeps(branchPkg ?? {});
  return Object.keys(branch).filter((name) => !(name in base));
}

export async function checkPackage(name, { fetchFn = fetch, now = Date.now() } = {}) {
  const meta = await fetchFn(`https://registry.npmjs.org/${encodeURIComponent(name)}`);
  if (!meta.ok) return { name, ok: false, reason: meta.status === 404 ? 'does not exist on the registry (possible hallucinated package)' : `registry lookup failed (${meta.status})` };
  const data = await meta.json();
  const created = Date.parse(data.time?.created ?? '');
  if (!Number.isFinite(created)) return { name, ok: false, reason: 'no creation date in registry metadata' };
  const ageDays = Math.floor((now - created) / 86_400_000);
  if (ageDays < MIN_AGE_DAYS) return { name, ok: false, reason: `only ${ageDays} days old (< ${MIN_AGE_DAYS} — young packages are the slopsquatting vector)` };

  const dl = await fetchFn(`https://api.npmjs.org/downloads/point/last-week/${encodeURIComponent(name)}`);
  if (dl.ok) {
    const { downloads } = await dl.json();
    if (Number.isFinite(downloads) && downloads < MIN_WEEKLY_DOWNLOADS) {
      return { name, ok: false, reason: `${downloads} weekly downloads (< ${MIN_WEEKLY_DOWNLOADS})` };
    }
  } // downloads API unavailable → age + existence already checked; don't hard-fail
  return { name, ok: true, ageDays };
}

export async function runDepGuard({ cwd, base = 'main', execFn = run, fetchFn = fetch, log = console.log }) {
  const baseRaw = await execFn('git', ['-C', cwd, 'show', `${base}:package.json`]);
  const basePkg = baseRaw.ok ? JSON.parse(baseRaw.stdout) : {};
  let branchPkg = {};
  try { branchPkg = JSON.parse(await readFile(resolve(cwd, 'package.json'), 'utf8')); } catch { /* no package.json */ }

  const added = newDeps(basePkg, branchPkg);
  if (added.length === 0) {
    log('dep-guard: no new dependencies');
    return { ok: true, added: [], violations: [] };
  }
  const results = [];
  for (const name of added) results.push(await checkPackage(name, { fetchFn }));
  const violations = results.filter((r) => !r.ok);
  for (const r of results) log(`${r.ok ? '✓' : '✗'} ${r.name}${r.ok ? ` (${r.ageDays}d old)` : ` — ${r.reason}`}`);
  if (violations.length) log('dep-guard: violations — remove the package or escalate with justification (spec §7)');
  return { ok: violations.length === 0, added, violations };
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  const base = process.argv.includes('--base') ? process.argv[process.argv.indexOf('--base') + 1] : 'main';
  runDepGuard({ cwd: process.cwd(), base }).then((res) => process.exit(res.ok ? 0 : 1));
}
