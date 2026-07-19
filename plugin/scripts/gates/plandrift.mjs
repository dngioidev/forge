#!/usr/bin/env node
/**
 * Plan-drift gate (spec §13): the branch's touched files vs the plan's
 * declared **Files:** lists + scoper extensions (.forge/scope.json) +
 * default-allowed globs. Deviation ⇒ escalate, not silently accept.
 */
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { run } from '../lib/exec.mjs';
import { readJson } from '../lib/jsonfile.mjs';

/** Always allowed: the artifacts every task legitimately produces. */
export const DEFAULT_ALLOW = ['tests/', 'docs/', '.forge/', 'CHANGELOG.md', 'pnpm-lock.yaml', 'package-lock.json'];

/**
 * Pull file paths from every `**Files:**` line in the plan. Shorthand where a
 * bare filename follows a full path on the same line (e.g.
 * `packages/ui/src/Button.tsx, TextField.tsx`) resolves the bare name against
 * the preceding path's directory (#106) — otherwise it read as off-plan.
 */
export function extractPlanFiles(planText) {
  const files = [];
  for (const m of (planText ?? '').matchAll(/\*\*Files:\*\*\s*(.+)$/gm)) {
    let lastDir = null; // dir of the most recent path token on THIS line
    for (const raw of m[1].split(/[,\s]+/)) {
      const f = raw.replace(/[`()]/g, '').trim();
      if (!f || f.startsWith('+')) continue;
      if (f.includes('/')) {
        files.push(f);
        lastDir = f.endsWith('/') ? f.replace(/\/$/, '') : f.slice(0, f.lastIndexOf('/'));
      } else {
        files.push(lastDir ? `${lastDir}/${f}` : f);
      }
    }
  }
  return [...new Set(files)];
}

export function isAllowed(file, declared, scopeExtra, allowPrefixes) {
  const norm = file.replaceAll('\\', '/');
  if (allowPrefixes.some((p) => (p.endsWith('/') ? norm.startsWith(p) : norm === p))) return true;
  const all = [...declared, ...scopeExtra];
  return all.some((d) => {
    const dn = d.replaceAll('\\', '/');
    return dn === norm || (dn.endsWith('/') && norm.startsWith(dn)) || norm.startsWith(dn.replace(/\*+$/, ''));
  });
}

export async function runPlanDrift({ cwd, planPath, base = 'main', execFn = run, log = console.log }) {
  const planText = await readFile(resolve(cwd, planPath), 'utf8').catch(() => null);
  if (!planText) return { ok: false, error: `plan not readable: ${planPath}` };
  const declared = extractPlanFiles(planText);
  if (declared.length === 0) return { ok: false, error: 'plan declares no **Files:** lists — plan-drift needs them (forge:plan template)' };

  const scope = (await readJson(join(cwd, '.forge', 'scope.json')).catch(() => null)) ?? {};
  const scopeExtra = scope.files ?? [];

  const diff = await execFn('git', ['-C', cwd, 'diff', '--name-only', `${base}...HEAD`]);
  if (!diff.ok) return { ok: false, error: `git diff failed: ${diff.stderr}` };
  const touched = diff.stdout.split(/\r?\n/).filter(Boolean);

  const deviations = touched.filter((f) => !isAllowed(f, declared, scopeExtra, DEFAULT_ALLOW));
  for (const d of deviations) log(`✗ off-plan: ${d}`);
  if (deviations.length) {
    log(`plan-drift: ${deviations.length} file(s) outside the plan + blast radius — escalate (spec §7) or update the plan/scope before shipping`);
  } else {
    log(`plan-drift: clean (${touched.length} touched, all declared/allowed)`);
  }
  return { ok: deviations.length === 0, deviations, touched: touched.length };
}

export function parseArgs(argv) {
  const a = { plan: null, base: 'main' };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--plan') a.plan = argv[++i];
    else if (argv[i] === '--base') a.base = argv[++i];
  }
  return a;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  const args = parseArgs(process.argv.slice(2));
  if (!args.plan) { console.error('--plan <file> is required'); process.exit(2); }
  runPlanDrift({ cwd: process.cwd(), planPath: args.plan, base: args.base }).then((res) => {
    if (res.error) console.error(res.error);
    process.exit(res.ok ? 0 : 1);
  });
}
