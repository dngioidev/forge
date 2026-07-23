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
import { fetchRunnerPin, parsePinnedVersion, compareVersions } from './lib/runner-release.mjs';
import { readJson } from './lib/jsonfile.mjs';
import { getRepoInfo, getProjectFields } from './lib/board.mjs';

const ok = (name, msg) => ({ name, level: 'ok', msg });
const warn = (name, msg, hint) => ({ name, level: 'warn', msg, hint });
const fail = (name, msg, hint) => ({ name, level: 'fail', msg, hint });
const skip = (name, msg) => ({ name, level: 'skip', msg }); // not applicable — never a failure (#89)

const firstLine = (s) => String(s ?? '').split(/\r?\n/).find((l) => l.trim()) ?? '';

// PAT shapes for the secret-store scan (ADR-0005 decision 1): classic
// gh{p,o,s,u}_ + 36 chars, and fine-grained github_pat_ tokens. Assembled from
// parts so this literal never itself matches (no self-flagging in a git grep).
const RUNNER_PAT_RE = ['gh', '[opsu]_', '[A-Za-z0-9]{36}', '|', 'github', '_pat_', '[A-Za-z0-9_]{22,}'].join('');

/**
 * Local self-hosted-runner health (ADR-0005 decisions 1 & 3, #225/AC4). Appends
 * results ONLY when `runner.enabled` — an absent/disabled block is fully silent
 * (no noise for the majority who don't run a local runner). Every gh/git call is
 * argv-only (no shell), degrades to a warn (never a crash) when gh lacks scope or
 * the API 4xxs, and never echoes a discovered secret's value into the output.
 */
async function checkRunner({ gh, cwd, runner, results }) {
  // Private-only guard (decision 3): a self-hosted runner on a PUBLIC repo is a
  // fork-PR RCE. Belt-and-suspenders with init's refusal (#224). Resolved first,
  // but the registration probe is the only gh-dependent leg — the secret-store
  // scan below is git-only and always runs (a committed PAT is unsafe on any repo).
  const view = await gh(['repo', 'view', '--json', 'isPrivate,owner,name'], { parseJson: true });
  if (!view.ok) {
    results.push(warn('runner', `enabled, but repo visibility could not be determined (${firstLine(view.stderr) || 'gh repo view failed'})`, 'run inside the repo with gh authenticated'));
  } else if (view.json?.isPrivate !== true) {
    results.push(fail('runner', 'runner.enabled on a PUBLIC repo — forks can run untrusted code on your machine (fork-PR RCE)', 'set runner.enabled=false, or keep the repo private (ADR-0005 decision 3)'));
  } else {
    const owner = view.json.owner?.login;
    const name = view.json.name;

    // Registered + online? (decision 3 label routing). Repo endpoint by default;
    // the org runners endpoint when sharing:"org" (decision 2). per_page=100 so a
    // box with many registrations isn't truncated to a false "not registered".
    const isOrg = runner.sharing === 'org';
    const base = isOrg ? `orgs/${owner}/actions/runners` : `repos/${owner}/${name}/actions/runners`;
    const api = await gh(['api', `${base}?per_page=100`], { parseJson: true });
    const wanted = runner.labels.map((l) => l.toLowerCase()); // GitHub matches labels case-insensitively
    if (!api.ok) {
      results.push(warn('runner', `enabled, but could not query ${isOrg ? 'org' : 'repo'} runners (${firstLine(api.stderr) || 'gh api failed'})`, "grant the token repo/admin:org scope, or confirm the runner is registered"));
    } else {
      const list = Array.isArray(api.json?.runners) ? api.json.runners : [];
      const labelNames = (r) => new Set((r.labels ?? []).map((l) => (typeof l === 'string' ? l : l?.name)).filter(Boolean).map((s) => s.toLowerCase()));
      const matches = list.filter((r) => { const ns = labelNames(r); return wanted.every((w) => ns.has(w)); });
      if (matches.length === 0) {
        results.push(warn('runner', `no self-hosted runner registered with labels [${runner.labels.join(', ')}]`, 'register the local runner (/forge:init --runner, then the printed enable steps)'));
      } else if (matches.some((r) => r.status === 'online')) {
        const online = matches.filter((r) => r.status === 'online').length;
        results.push(ok('runner', `registered + online (${online}/${matches.length} matching runner${matches.length === 1 ? '' : 's'} online)`));
      } else {
        results.push(warn('runner', `runner registered but offline (labels [${runner.labels.join(', ')}])`, 'start the runner service on the host'));
      }
    }
  }

  await checkRunnerSecretStore({ cwd, results });
  await checkRunnerVersion({ gh, cwd, results });
}

/**
 * Runner staleness (#233): GitHub DEPRECATES old actions/runner versions ("Runner
 * version vX is deprecated and cannot receive messages") and the ephemeral/JIT
 * runner can't auto-update, so a fixed pin silently stops receiving jobs. Parse the
 * scaffolded RUNNER_VERSION (Dockerfile, then setup-runner.ps1) and WARN when it is
 * behind the latest release. Degrades to a SILENT skip when the runner files are
 * absent (nothing scaffolded yet) or the gh lookup fails (can't determine latest) —
 * never a crash, never a fail.
 */
async function checkRunnerVersion({ gh, cwd, results }) {
  const dockerfile = await readFile(join(cwd, 'runner', 'linux', 'Dockerfile'), 'utf8').catch(() => null);
  const ps1 = await readFile(join(cwd, 'runner', 'windows', 'setup-runner.ps1'), 'utf8').catch(() => null);
  const pinned = parsePinnedVersion(dockerfile) ?? parsePinnedVersion(ps1);
  if (!pinned) return; // no scaffolded runner files → silent skip

  const latest = await fetchRunnerPin(gh); // no log — doctor is read-only/quiet here
  if (latest.source !== 'live') return; // gh unreachable → can't judge staleness → silent skip

  if (compareVersions(pinned, latest.version) < 0) {
    results.push(warn('runner-version',
      `pinned actions-runner v${pinned} is behind the latest v${latest.version} — GitHub deprecates old runners; the ephemeral runner will stop receiving jobs`,
      're-run /forge:init --runner (or bump RUNNER_VERSION + SHA-256 in runner/linux/Dockerfile and runner/windows/setup-runner.ps1)'));
  } else {
    results.push(ok('runner-version', `pinned actions-runner v${pinned} is current`));
  }
}

/**
 * Secret-store assertion (ADR-0005 decision 1): the ~/.forge/runner.env PAT store
 * must be gitignored + untracked, and no PAT may sit in a committed file. gh-free
 * (git-only) so it runs regardless of the registration probe's outcome. All calls
 * are argv-only; a non-git cwd simply degrades to a warn, never a throw. Only file
 * NAMES are ever surfaced — a discovered secret's value is never echoed.
 */
async function checkRunnerSecretStore({ cwd, results }) {
  const trackedRes = await run('git', ['-C', cwd, 'ls-files']);
  const tracked = (trackedRes.stdout || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const storeTracked = tracked.filter((p) => /(^|\/)runner\.env$/.test(p) || /(^|\/)[^/]*\.runner\.env$/.test(p) || /(^|\/)\.forge\//.test(p));
  const grep = await run('git', ['-C', cwd, 'grep', '-I', '-l', '-E', RUNNER_PAT_RE]);
  // git grep: exit 0 = matches, 1 = clean (no match), anything else = real error.
  const patHits = grep.code === 0 ? (grep.stdout || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean) : [];
  const ignored = await run('git', ['-C', cwd, 'check-ignore', '-q', 'runner.env']);

  if (storeTracked.length) {
    results.push(fail('runner-secret', `runner secret store is tracked in git: ${storeTracked.slice(0, 3).join(', ')}`, 'git rm --cached it; the PAT belongs only in ~/.forge/runner.env (ADR-0005 decision 1)'));
  } else if (patHits.length) {
    results.push(fail('runner-secret', `PAT-looking secret found in committed file(s): ${patHits.slice(0, 3).join(', ')}`, 'rotate the token and purge it from git history (never commit a PAT)'));
  } else if (!ignored.ok) {
    results.push(warn('runner-secret', 'runner.env is not gitignored', 'add runner.env / **/.forge/ to .gitignore (/forge:init --runner does this)'));
  } else {
    results.push(ok('runner-secret', 'runner.env gitignored + untracked; no PAT in committed files'));
  }
}

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

  // local self-hosted runner (ADR-0005 / #225 AC4) — silent unless runner.enabled
  if (cfg.ok && cfg.runner?.enabled === true) {
    await checkRunner({ gh, cwd, runner: cfg.runner, results });
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
