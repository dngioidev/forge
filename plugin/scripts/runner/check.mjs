#!/usr/bin/env node
/**
 * /forge:runner-check (#245, Refs #180) — an end-to-end ADOPTION-READINESS preflight
 * for the local self-hosted runner (ADR-0005). It RESOLVES the runner config
 * (defaults applied) and runs one go/no-go pass so someone adopting the runner on
 * another project can confirm their whole setup in a single shot — broader than the
 * single runner-health line `forge:doctor` prints.
 *
 * It REUSES the shared runner-checks lib (the same code driving doctor's runner
 * line, #225/#233): the private-repo guard, the registration/online probe, the
 * secret-store assertion, and the version-staleness check. Every gh/git/exec call
 * is argv-only (no shell) and degrades to a warn (never a crash); the PAT value is
 * never read or printed.
 *
 * Checks (each: ok / warn / fail + a fix hint):
 *   1. private-repo guard  — FAIL on a public repo (fork-PR RCE).
 *   1b. fork-PR exposure   — FAIL on a public repo with ANY self-hosted runner already
 *                            registered (any project's, not just this one) unless the
 *                            live fork-PR-approval policy is the strictest (#489 AC.2).
 *   2. runner block        — present + enabled in forge.json; effective config echoed.
 *   3. host prerequisites  — git, gh, node (>=22.13) on PATH; docker reachable for
 *                            the Linux container leg; native-runner note for windows:native.
 *   4. secret store        — ~/.forge/runner.env gitignored + untracked, no committed PAT.
 *   5. runner online       — registered + online for the configured labels (+ the
 *                            windows label set when windows:native).
 *   6. scaffold present    — runner/ assets exist + a verify workflow targets the label.
 *   7. version staleness   — warn when the pinned actions-runner version is behind latest.
 *
 * Ends with a single READY / NOT READY verdict: NOT READY on any FAIL, else
 * READY (with warnings noted).
 */
import { join, resolve } from 'node:path';
import { readFile, readdir, stat } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { run, makeGh } from '../lib/exec.mjs';
import { loadConfig, normalizeRunner, CONFIG_RELPATH } from '../lib/config.mjs';
import {
  ok, warn, fail,
  fetchRepoVisibility, probeRunnerOnline, checkRunnerSecretStore, checkRunnerVersion, windowsLabels,
  detectRunnerServices, serviceTargetResults, checkForkPrExposure,
} from '../lib/runner-checks.mjs';

const MIN_NODE = [22, 13];

/** Is `cmd` resolvable on PATH? `<cmd> --version` argv-only; any spawn/exec error → not found. */
async function onPath(exec, cmd, args = ['--version']) {
  const res = await exec(cmd, args);
  return res.ok;
}

/**
 * Host prerequisites (#245 check 3). git/gh/node must be present; node must be
 * >=22.13 (checked in-process, no spawn). docker must be REACHABLE for the Linux
 * container leg — `docker info` (not just on PATH) so a stopped daemon is caught.
 * A missing/unreachable docker is a FAIL (the Linux leg can't run without it); a
 * native-Windows note is advisory. Each degrades gracefully — a spawn error is just
 * "not found", never a throw. `exec` is injectable for testability (defaults to run).
 */
async function checkPrereqs({ exec, runner, results }) {
  for (const cmd of ['git', 'gh']) {
    if (await onPath(exec, cmd)) results.push(ok(`prereq-${cmd}`, `${cmd} on PATH`));
    else results.push(fail(`prereq-${cmd}`, `${cmd} not found on PATH`, `install ${cmd} and re-run inside the repo`));
  }

  // node: in-process version — no spawn needed, and it's the version actually running.
  const [maj, min] = process.versions.node.split('.').map(Number);
  if (maj > MIN_NODE[0] || (maj === MIN_NODE[0] && min >= MIN_NODE[1])) {
    results.push(ok('prereq-node', `node ${process.versions.node} (>=22.13)`));
  } else {
    results.push(fail('prereq-node', `node ${process.versions.node} < 22.13`, 'upgrade Node to >=22.13 (spec §6)'));
  }

  // docker: reachable daemon, required for the Linux container leg. `docker info`
  // fails (nonzero) when the binary is absent OR the daemon is down — both block
  // the Linux runner, so both are a FAIL with a targeted hint.
  const dockerInfo = await exec('docker', ['info']);
  if (dockerInfo.ok) {
    results.push(ok('prereq-docker', 'docker daemon reachable (Linux container leg)'));
  } else if (!(await onPath(exec, 'docker'))) {
    results.push(fail('prereq-docker', 'docker not found on PATH — the Linux container runner needs Docker', 'install Docker (Docker Desktop + WSL integration, or native docker.io in WSL)'));
  } else {
    results.push(fail('prereq-docker', 'docker is installed but the daemon is not reachable', 'start the Docker daemon (Docker Desktop → Engine running, or systemctl start docker) and confirm with `docker info`'));
  }

  // Windows leg note (advisory): native runs on the host, hosted on windows-latest.
  if (runner.windows === 'native') {
    results.push(ok('prereq-windows', 'windows:native — the Windows leg runs on a native host runner (runner/windows/setup-runner.ps1, PowerShell + Git Bash on PATH); no container'));
  } else {
    results.push(ok('prereq-windows', 'windows:hosted — the Windows leg runs as a per-PR check on hosted windows-latest'));
  }
}

/**
 * Scaffold presence (#245 check 6): the runner/ assets must exist and a verify
 * workflow must target the configured label. Missing assets → FAIL (nothing to run);
 * a verify workflow that doesn't reference the label → warn (Linux legs won't route
 * to the local runner yet). File reads degrade to "absent", never a throw.
 */
async function checkScaffold({ cwd, runner, results }) {
  const expected = ['runner/linux/Dockerfile', 'runner/linux/supervisor.mjs', 'runner/windows/setup-runner.ps1', 'runner/README.md'];
  const missing = [];
  for (const rel of expected) {
    try { await stat(join(cwd, rel)); } catch { missing.push(rel); }
  }
  if (missing.length) {
    results.push(fail('scaffold', `runner assets missing: ${missing.join(', ')}`, 'run /forge:init --runner to scaffold the runner/ assets'));
  } else {
    results.push(ok('scaffold', 'runner/ assets present (Dockerfile, supervisor, setup-runner.ps1, README)'));
  }

  // A verify workflow targeting the label — the label is what routes jobs onto the
  // local runner. Scan .github/workflows for a `name: verify` file mentioning it.
  const label = runner.labels[runner.labels.length - 1]; // the distinctive forge-local label (last)
  let hasVerify = false;
  let labelled = false;
  try {
    const wfDir = join(cwd, '.github', 'workflows');
    for (const f of await readdir(wfDir)) {
      if (!/\.ya?ml$/.test(f)) continue;
      const body = await readFile(join(wfDir, f), 'utf8');
      if (!/^name:\s*verify\b/m.test(body)) continue;
      hasVerify = true;
      if (body.includes(label)) { labelled = true; break; }
    }
  } catch { /* no workflows dir */ }
  if (labelled) {
    results.push(ok('scaffold-workflow', `a verify workflow targets the [${label}] runner label`));
  } else if (hasVerify) {
    results.push(warn('scaffold-workflow', `a verify workflow exists but none targets the [${label}] runner label`, 'route the Linux jobs to runs-on: [self-hosted, linux, ' + label + '] (see verify.runner.yml)'));
  } else {
    results.push(warn('scaffold-workflow', 'no verify workflow found in .github/workflows', 'run /forge:init --runner (installs a verify.yml targeting the runner label)'));
  }
}

/**
 * The adoption-readiness preflight. Resolves the runner config (defaults applied)
 * and runs every check, returning `{ ok, ready, results }` — `ready` false iff any
 * result is a FAIL. Designed to never throw: config load, gh, git, and exec failures
 * all degrade to a warn/fail result rather than crashing the command.
 */
export async function runCheck(ctx) {
  const { gh, cwd, log, exec = run, detectServices = detectRunnerServices } = ctx;
  const results = [];

  const cfg = await loadConfig(cwd);

  // Check 2 — runner block present + valid. loadConfig already validated the shape
  // (validateConfig rejects malformed runner blocks) and resolved defaults into
  // cfg.runner. A missing file / invalid config is a FAIL; a valid-but-disabled
  // block is a FAIL for THIS command (you ran the adoption preflight — the runner is
  // meant to be on), distinct from doctor's silent-when-disabled behaviour.
  // cfg.runner is present + normalized on a successful load; a missing/broken
  // forge.json omits it, so fall back to the documented defaults so the remaining
  // checks (prereqs/labels) still run against a well-formed block.
  const runner = cfg.runner ?? normalizeRunner(undefined);
  if (!cfg.ok) {
    for (const e of cfg.errors) results.push(fail('config', e, cfg.missing ? 'run /forge:init' : `fix ${CONFIG_RELPATH}`));
  } else if (!runner.enabled) {
    results.push(fail('runner-block', 'runner block is absent or disabled in forge.json (runner.enabled != true)', 'add a runner block with "enabled": true (see docs/guides/runner-adoption.md)'));
  } else {
    results.push(ok('runner-block', `runner enabled — labels [${runner.labels.join(', ')}], sharing:${runner.sharing}, windows:${runner.windows}`));
  }

  // Check 1 — private-repo guard (resolved first; the online probe reuses the view).
  const vis = await fetchRepoVisibility(gh);
  if (!vis.ok) {
    results.push(warn('private-repo', `repo visibility could not be determined (${vis.stderr})`, 'run inside the repo with gh authenticated (gh auth login)'));
  } else if (!vis.isPrivate) {
    results.push(fail('private-repo', 'this is a PUBLIC repo — a self-hosted runner would let forks run untrusted code on your machine (fork-PR RCE)', 'keep the repo private, or do not adopt the local runner (ADR-0005 decision 3)'));
  } else {
    results.push(ok('private-repo', 'repo is private (self-hosted runner is safe from fork-PR RCE)'));
  }

  // Check 1b — fork-PR execution-surface (#489 AC.2). Distinct from check 1: this
  // fires for ANY self-hosted runner already registered to a public repo — including
  // a leftover registration from a different project on the same box — not just
  // whether THIS adoption attempt is safe to proceed with.
  if (vis.ok && vis.owner && vis.name) {
    results.push(await checkForkPrExposure({ gh, owner: vis.owner, name: vis.name, isPrivate: vis.isPrivate }));
  }

  // Check 3 — host prerequisites.
  await checkPrereqs({ exec, runner, results });

  // Check 4 — PAT store safety (git-only; reused from doctor). Always runs.
  results.push(await checkRunnerSecretStore({ cwd }));

  // Check 5 — registration + online for the configured labels (reused). Skipped only
  // when the private-repo guard couldn't resolve owner/name (no repo → can't probe).
  let online = null;
  if (vis.ok && vis.owner && vis.name) {
    // offlineLevel:'fail' — for the adoption gate, no online runner means you can't
    // actually run CI, so it's a blocker (not doctor's advisory warn). A gh-api
    // failure still degrades to a warn inside the probe (graceful degradation).
    online = await probeRunnerOnline({ gh, owner: vis.owner, name: vis.name, runner, checkName: 'runner-online', legNote: '(linux leg)', offlineLevel: 'fail' });
    results.push(online);
    // Windows leg: when native, a Windows runner must be online too — probe the
    // windows label set (linux → windows). Hosted needs no self-hosted registration.
    if (runner.windows === 'native') {
      results.push(await probeRunnerOnline({ gh, owner: vis.owner, name: vis.name, runner, checkName: 'runner-online-windows', labels: windowsLabels(runner.labels), legNote: '(windows leg)', offlineLevel: 'fail' }));
    }
  } else {
    results.push(warn('runner-online', 'skipped the runner registration probe — repo owner/name unresolved', 'confirm gh is authenticated and you are inside the repo'));
  }

  // Mis-target diagnosis (#260 AC5): surface the local service's resolved owner/repo,
  // and when a service is present but the configured repo shows 0 online matching
  // runners, hint that it may be targeting a different repo (JIT-ephemeral hides it).
  // Best-effort + argv-only (exec is injectable); never crashes, never prints the PAT.
  try {
    const services = await detectServices({ exec });
    for (const r of serviceTargetResults({ services, hasOnline: online?.level === 'ok', configuredOwner: vis.owner, configuredName: vis.name })) {
      results.push(r);
    }
  } catch { /* diagnosis is advisory only */ }

  // Check 6 — scaffold present.
  await checkScaffold({ cwd, runner, results });

  // Check 7 — version staleness (reused; silent skip when not scaffolded / gh down).
  const version = await checkRunnerVersion({ gh, cwd });
  if (version) results.push(version);

  const failed = results.filter((r) => r.level === 'fail');
  const warned = results.filter((r) => r.level === 'warn');
  const icon = { ok: '✓', warn: '⚠', fail: '✗', skip: '·' };
  for (const r of results) {
    log(`${icon[r.level]} ${r.name.padEnd(22)} ${r.msg}${r.hint ? `  → ${r.hint}` : ''}`);
  }
  const ready = failed.length === 0;
  if (!ready) {
    log(`\nNOT READY — ${failed.length} blocker(s): ${failed.map((r) => r.name).join(', ')}. Fix the ✗ items above, then re-run.`);
  } else if (warned.length) {
    log(`\nREADY (with ${warned.length} warning(s): ${warned.map((r) => r.name).join(', ')}) — the runner setup is adoption-ready; the ⚠ items are advisory.`);
  } else {
    log('\nREADY — the local runner setup is fully adoption-ready.');
  }
  return { ok: ready, ready, results };
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  runCheck({ gh: makeGh(run), cwd: process.cwd(), log: console.log }).then((res) => process.exit(res.ok ? 0 : 1));
}
