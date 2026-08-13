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
import {
  ok, warn, fail, skip,
  fetchRepoVisibility, probeRunnerOnline, checkRunnerSecretStore, checkRunnerVersion,
  detectRunnerServices, serviceTargetResults,
} from './lib/runner-checks.mjs';
import { checkAgyAdapter, checkAgyOffload } from './lib/agy-checks.mjs';
import { checkDenylistStaleness } from './lib/denylist-checks.mjs';

/**
 * Local self-hosted-runner health (ADR-0005 decisions 1 & 3, #225/AC4). Appends
 * results ONLY when `runner.enabled` — an absent/disabled block is fully silent
 * (no noise for the majority who don't run a local runner). Built entirely from the
 * shared runner-checks lib (also driving /forge:runner-check, #245): every gh/git
 * call is argv-only (no shell), degrades to a warn (never a crash) when gh lacks
 * scope or the API 4xxs, and never echoes a discovered secret's value.
 */
async function checkRunner({ gh, cwd, runner, results, exec = run, detect = detectRunnerServices }) {
  // Private-only guard (decision 3): a self-hosted runner on a PUBLIC repo is a
  // fork-PR RCE. Belt-and-suspenders with init's refusal (#224). Resolved first,
  // but the registration probe is the only gh-dependent leg — the secret-store
  // scan below is git-only and always runs (a committed PAT is unsafe on any repo).
  const vis = await fetchRepoVisibility(gh);
  let online = null;
  if (!vis.ok) {
    results.push(warn('runner', `enabled, but repo visibility could not be determined (${vis.stderr})`, 'run inside the repo with gh authenticated'));
  } else if (!vis.isPrivate) {
    results.push(fail('runner', 'runner.enabled on a PUBLIC repo — forks can run untrusted code on your machine (fork-PR RCE)', 'set runner.enabled=false, or keep the repo private (ADR-0005 decision 3)'));
  } else {
    online = await probeRunnerOnline({ gh, owner: vis.owner, name: vis.name, runner, checkName: 'runner' });
    results.push(online);
  }

  results.push(await checkRunnerSecretStore({ cwd }));
  const version = await checkRunnerVersion({ gh, cwd });
  if (version) results.push(version);

  // Mis-target diagnosis (#260 AC5): surface the local service's resolved owner/repo
  // and, when the configured repo shows 0 online matching runners, hint that the
  // service may be targeting a different repo (JIT-ephemeral hides this). Best-effort:
  // never crashes, degrades to nothing when no service is detectable.
  try {
    const services = await detect({ exec });
    for (const r of serviceTargetResults({ services, hasOnline: online?.level === 'ok', configuredOwner: vis.owner, configuredName: vis.name })) {
      results.push(r);
    }
  } catch { /* diagnosis is advisory only */ }
}

export async function runDoctor(ctx) {
  const { gh, cwd, log, exec = run, detectServices = detectRunnerServices } = ctx;
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

  // graph layer (warn-level, only when features.graph is on)
  if (cfg.ok && cfg.config.features?.graph === true) {
    const { loadTsMorph } = await import('../mcp/graph/indexer.mjs');
    const tsconfigExists = await stat(join(cwd, 'tsconfig.json')).then(() => true, () => false);
    if (!tsconfigExists) {
      results.push(warn('graph', 'features.graph is on but no tsconfig.json — the graph indexes TypeScript repos only', 'turn features.graph off; grep-first is the permanent fallback (spec §9)'));
    } else {
      const tm = await loadTsMorph(cwd);
      if (!tm.ok) results.push(warn('graph', 'features.graph is on but ts-morph is not resolvable from this repo', 'npm i -D ts-morph, then node plugin/scripts/graph/graphctl.mjs rebuild'));
      else {
        const dbExists = await stat(join(cwd, '.forge', 'graph.db')).then(() => true, () => false);
        if (dbExists) results.push(ok('graph', 'ts-morph resolvable, graph.db present'));
        else results.push(warn('graph', 'graph.db not built yet', 'node plugin/scripts/graph/graphctl.mjs rebuild'));
      }
    }
  }

  // graph availability notice (#386): the inverse of the check above. A TS repo
  // that has never turned graph-RAG on has no way to learn it exists — deliver/
  // autopilot silently fall back to grep and forge:doctor previously only spoke
  // up once features.graph was ALREADY true. One-time, low-noise advisory: fires
  // whenever a tsconfig.json is present and features.graph isn't explicitly true,
  // EXCEPT when .forge/graph.db already exists — that's cheap evidence the repo
  // built the index before and then turned it off on purpose (AC.2: don't nag a
  // deliberate opt-out). "Never configured" (features block absent, e.g. adopted
  // repos) is treated the same as "off" — that repo needs the notice most.
  if (cfg.ok && cfg.config.features?.graph !== true) {
    const tsconfigExists = await stat(join(cwd, 'tsconfig.json')).then(() => true, () => false);
    if (tsconfigExists) {
      const dbExists = await stat(join(cwd, '.forge', 'graph.db')).then(() => true, () => false);
      if (!dbExists) {
        results.push(warn(
          'graph-availability',
          'tsconfig.json found but features.graph is off — graph-RAG (find_component/who_uses/blast_radius/reuse_candidates) is available for this repo',
          'set features.graph:true in .claude/forge.json, npm i -D ts-morph, then node plugin/scripts/graph/graphctl.mjs rebuild (docs/guides/install.md)',
        ));
      }
    }
  }

  // local self-hosted runner (ADR-0005 / #225 AC4) — silent unless runner.enabled
  if (cfg.ok && cfg.runner?.enabled === true) {
    await checkRunner({ gh, cwd, runner: cfg.runner, results, exec, detect: detectServices });
  }

  // agy adapter health (#431 AC.1/AC.2) — silent unless an emitted package is found
  // at .agents/plugins/forge/, mirroring the runner.enabled precedent immediately
  // above: no adapter present means no agy output at all.
  if (cfg.ok) {
    await checkAgyAdapter({ cwd, exec, results });
    // features.agy offload reachability (AC.4) — independently gated; see agy-checks.mjs
    // for why this is deliberately NOT folded into the block above.
    const offload = await checkAgyOffload({ cfg: cfg.config, exec });
    if (offload) results.push(offload);
  }

  // denylist staleness (#447 AC.3) — silent unless cwd has its own working-tree
  // copy of plugin/hooks/denylist.mjs (a forge checkout, not a plain consumer
  // install); diagnostic only, changes no resolution behaviour (that decision
  // is #484, still open).
  const denylistStaleness = await checkDenylistStaleness({ cwd });
  if (denylistStaleness) results.push(denylistStaleness);

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
    const isPrivate = sec.ok && (sec.json.private === true || sec.json.visibility === 'private');
    if (sa?.secret_scanning?.status === 'enabled') results.push(ok('secret-scanning', 'enabled'));
    // private repos without GitHub Advanced Security can't offer secret scanning — that's a plan
    // limitation, not a misconfiguration, so don't nag (#89).
    else if (isPrivate && !sa?.secret_scanning) results.push(skip('secret-scanning', 'n/a on this plan — needs a public repo or GitHub Advanced Security'));
    else results.push(warn('secret-scanning', 'secret scanning not enabled', 'enable secret scanning + push protection in repo settings (spec §13)'));
  }

  const failed = results.filter((r) => r.level === 'fail');
  const icon = { ok: '✓', warn: '⚠', fail: '✗', skip: '·' };
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
