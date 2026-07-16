#!/usr/bin/env node
/**
 * /forge:doctor — read-only health check (spec §6, plan T6).
 * One distinct check per failure class; ✗ = exit 1, ⚠ = advisory.
 */
import { join, resolve } from 'node:path';
import { readFile, readdir, stat } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { run, makeGh } from './lib/exec.mjs';
import { loadConfig, CONFIG_RELPATH } from './lib/config.mjs';
import { readJson } from './lib/jsonfile.mjs';
import { getRepoInfo, getProjectFields } from './lib/board.mjs';

const ok = (name, msg) => ({ name, level: 'ok', msg });
const warn = (name, msg, hint) => ({ name, level: 'warn', msg, hint });
const fail = (name, msg, hint) => ({ name, level: 'fail', msg, hint });

export async function runDoctor(ctx) {
  const { gh, cwd, log } = ctx;
  const results = [];

  // gh auth + project scope
  const auth = await gh(['auth', 'status']);
  if (!auth.ok) {
    results.push(fail('gh-auth', 'gh is not authenticated', 'gh auth login -s project'));
  } else {
    const scopeLine = (auth.stdout + auth.stderr).split(/\r?\n/).find((l) => l.includes('Token scopes:')) ?? '';
    if (!/'project'|\bproject\b/.test(scopeLine.replace('Token scopes:', ''))) {
      results.push(fail('gh-scope', "token lacks the 'project' scope", 'gh auth refresh -s project'));
    } else {
      results.push(ok('gh-auth', 'authenticated with project scope'));
    }
  }

  // node version
  const [maj, min] = process.versions.node.split('.').map(Number);
  if (maj > 22 || (maj === 22 && min >= 13)) results.push(ok('node', `node ${process.versions.node}`));
  else results.push(fail('node', `node ${process.versions.node} < 22.13`, 'upgrade Node (>=22.13, spec §6)'));

  // git repo
  const git = await run('git', ['-C', cwd, 'rev-parse', '--is-inside-work-tree']);
  if (git.ok) results.push(ok('git', 'inside a git work tree'));
  else results.push(fail('git', 'not a git repository', 'run inside the consumer repo'));

  // config
  const cfg = await loadConfig(cwd);
  if (!cfg.ok) {
    for (const e of cfg.errors) results.push(fail('config', e, cfg.missing ? 'run /forge:init' : `fix ${CONFIG_RELPATH}`));
  } else {
    results.push(ok('config', `${CONFIG_RELPATH} valid`));
  }

  // board ids resolve
  if (cfg.ok) {
    const pf = await getProjectFields(gh, cfg.config.board.projectId);
    if (!pf.ok) {
      results.push(fail('board', `projectId does not resolve: ${pf.error}`, 're-run /forge:init'));
    } else {
      const dangling = [];
      for (const [key, f] of Object.entries(cfg.config.board.fields)) {
        const live = Object.values(pf.fields).find((x) => x.id === f.id);
        if (!live) { dangling.push(`${key}.id`); continue; }
        const liveOptionIds = new Set((live.options ?? []).map((o) => o.id));
        for (const [optName, optId] of Object.entries(f.options)) {
          if (!liveOptionIds.has(optId)) dangling.push(`${key}.options.${optName}`);
        }
      }
      if (dangling.length) results.push(fail('board', `dangling ids: ${dangling.join(', ')}`, 're-run /forge:init to re-discover'));
      else results.push(ok('board', 'project + all field/option ids resolve'));
    }

    // delivery log
    if (cfg.config.board.deliveryLogIssue != null) {
      const dl = await gh(['issue', 'view', String(cfg.config.board.deliveryLogIssue), '--json', 'state'], { parseJson: true });
      if (!dl.ok) results.push(warn('delivery-log', `issue #${cfg.config.board.deliveryLogIssue} not found`, 're-run /forge:init'));
      else if (dl.json.state !== 'OPEN') results.push(warn('delivery-log', `issue #${cfg.config.board.deliveryLogIssue} is closed`, 'reopen it'));
      else results.push(ok('delivery-log', `issue #${cfg.config.board.deliveryLogIssue} open`));
    }
  }

  // .forge/ gitignored
  let gi = '';
  try { gi = await readFile(join(cwd, '.gitignore'), 'utf8'); } catch { /* missing */ }
  if (gi.split(/\r?\n/).some((l) => l.trim() === '.forge/')) results.push(ok('gitignore', '.forge/ ignored'));
  else results.push(fail('gitignore', '.forge/ not in .gitignore', 'run /forge:init (it appends the entry)'));

  // consumer CI verify workflow present (warn-level; init installs the template)
  let hasVerifyWf = false;
  try {
    const wfDir = join(cwd, '.github', 'workflows');
    for (const f of await readdir(wfDir)) {
      if (/\.ya?ml$/.test(f) && /^name:\s*verify\b/m.test(await readFile(join(wfDir, f), 'utf8'))) { hasVerifyWf = true; break; }
    }
  } catch { /* no workflows dir */ }
  if (hasVerifyWf) results.push(ok('ci-verify', 'verify workflow present'));
  else results.push(warn('ci-verify', 'no verify workflow in .github/workflows', 'run /forge:init (installs the CI template, spec §6)'));

  // deploy layer files (warn-level, only when features.deploy is on)
  if (cfg.ok && cfg.config.features?.deploy === true) {
    const d = cfg.config.deploy ?? {};
    const expected = [
      d.docker?.file ?? 'Dockerfile',
      d.docker?.compose ?? 'docker-compose.yml',
      d.terraform?.dir ?? 'infra/',
      '.github/workflows/deploy-staging.yml',
      '.github/workflows/deploy-production.yml',
      '.github/workflows/deploy-readiness.yml',
      'scripts/forge-smoke.mjs',
    ];
    const missing = [];
    for (const rel of expected) {
      try { await stat(join(cwd, rel)); } catch { missing.push(rel); }
    }
    if (missing.length === 0) results.push(ok('deploy', 'deploy layer files present'));
    else results.push(warn('deploy', `features.deploy is on but missing: ${missing.join(', ')}`, 'run /forge:deploy-init'));
  }

  // statusline wired (info-level) — local settings first (that's where init writes it)
  const settingsLocal = await readJson(join(cwd, '.claude', 'settings.local.json')).catch(() => null);
  const settings = await readJson(join(cwd, '.claude', 'settings.json')).catch(() => null);
  if (settingsLocal?.statusLine || settings?.statusLine) results.push(ok('statusline', 'wired'));
  else results.push(warn('statusline', 'status line not wired', 'run /forge:init with --statusline'));

  // branch protection + secret scanning (warn-level)
  const repo = await getRepoInfo(gh);
  if (repo.ok) {
    const prot = await gh(['api', `repos/${repo.owner}/${repo.name}/branches/${repo.defaultBranch}/protection`]);
    if (prot.ok) results.push(ok('branch-protection', `${repo.defaultBranch} protected`));
    else results.push(warn('branch-protection', `${repo.defaultBranch} has no branch protection`, 'require the verify check before merge (spec §6)'));

    const sec = await gh(['api', `repos/${repo.owner}/${repo.name}`], { parseJson: true });
    const sa = sec.ok ? sec.json.security_and_analysis : null;
    if (sa?.secret_scanning?.status === 'enabled') results.push(ok('secret-scanning', 'enabled'));
    else results.push(warn('secret-scanning', 'secret scanning not enabled', 'enable secret scanning + push protection in repo settings (spec §13)'));
  }

  const failed = results.filter((r) => r.level === 'fail');
  const icon = { ok: '✓', warn: '⚠', fail: '✗' };
  for (const r of results) {
    log(`${icon[r.level]} ${r.name.padEnd(18)} ${r.msg}${r.hint ? `  → ${r.hint}` : ''}`);
  }
  log(failed.length === 0 ? 'doctor: healthy' : `doctor: ${failed.length} problem(s)`);
  return { ok: failed.length === 0, results };
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  runDoctor({ gh: makeGh(run), cwd: process.cwd(), log: console.log }).then((res) => process.exit(res.ok ? 0 : 1));
}
