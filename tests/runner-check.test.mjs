import { describe, it, expect } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCheck } from '../plugin/scripts/runner/check.mjs';
import { run } from '../plugin/scripts/lib/exec.mjs';
import { fakeGh, REPO_VIEW, AUTH_OK } from './helpers/fakegh.mjs';

const noop = () => {};
const byName = (res, name) => res.results.filter((r) => r.name === name);
const levelOf = (res, name) => byName(res, name)[0]?.level;

async function tmpCwd() {
  return mkdtemp(join(tmpdir(), 'forge-rcheck-'));
}

/** A scripted exec for the host-prereq spawns (git/gh/node/docker). Any unrouted
 *  command defaults to "not found" (ok:false) so a test must opt a tool in. */
function fakeExec(present = { git: true, gh: true, docker: true, dockerInfo: true }) {
  return async (cmd, args) => {
    const joined = `${cmd} ${args.join(' ')}`;
    if (cmd === 'docker' && args[0] === 'info') return mk(present.dockerInfo);
    if (cmd === 'docker') return mk(present.docker);
    if (cmd === 'git') return mk(present.git);
    if (cmd === 'gh') return mk(present.gh);
    return { ok: false, code: -1, stdout: '', stderr: `unrouted exec: ${joined}` };
  };
  function mk(ok) { return { ok: !!ok, code: ok ? 0 : 1, stdout: '', stderr: ok ? '' : 'not found' }; }
}

/** Real git repo in a tmp dir (checkRunnerSecretStore uses real git, like doctor). */
async function gitRepo({ gitignore = '.forge/\nrunner.env\n', files = {} } = {}) {
  const cwd = await tmpCwd();
  await run('git', ['-C', cwd, 'init', '-q']);
  await writeFile(join(cwd, '.gitignore'), gitignore, 'utf8');
  for (const [rel, body] of Object.entries(files)) {
    const abs = join(cwd, rel);
    await mkdir(join(abs, '..'), { recursive: true });
    await writeFile(abs, body, 'utf8');
  }
  await run('git', ['-C', cwd, 'add', '-A']);
  await run('git', ['-C', cwd, '-c', 'user.email=t@t.dev', '-c', 'user.name=t', 'commit', '-q', '-m', 'init']);
  return cwd;
}

/** Write a valid forge.json (from the live one) with the given runner block. */
async function writeCfg(cwd, runner) {
  const committed = JSON.parse(await readFile(join(process.cwd(), '.claude', 'forge.json'), 'utf8'));
  if (runner === undefined) delete committed.runner;
  else committed.runner = runner;
  await mkdir(join(cwd, '.claude'), { recursive: true });
  await writeFile(join(cwd, '.claude', 'forge.json'), JSON.stringify(committed), 'utf8');
}

/** Scaffold the runner/ assets + a verify workflow targeting the label. */
async function writeScaffold(cwd, { version = '2.340.0', label = 'forge-local', withWorkflow = true } = {}) {
  await mkdir(join(cwd, 'runner', 'linux'), { recursive: true });
  await mkdir(join(cwd, 'runner', 'windows'), { recursive: true });
  await writeFile(join(cwd, 'runner', 'linux', 'Dockerfile'), `FROM node:22\nARG RUNNER_VERSION=${version}\n`, 'utf8');
  await writeFile(join(cwd, 'runner', 'linux', 'supervisor.mjs'), '// supervisor\n', 'utf8');
  await writeFile(join(cwd, 'runner', 'windows', 'setup-runner.ps1'), '# setup\n', 'utf8');
  await writeFile(join(cwd, 'runner', 'README.md'), '# runner\n', 'utf8');
  if (withWorkflow) {
    await mkdir(join(cwd, '.github', 'workflows'), { recursive: true });
    await writeFile(join(cwd, '.github', 'workflows', 'verify.yml'), `name: verify\njobs:\n  t:\n    runs-on: [self-hosted, linux, ${label}]\n`, 'utf8');
  }
}

const PRIVATE_VIEW = { stdout: JSON.stringify({ isPrivate: true, owner: { login: 'dngioidev' }, name: 'forge' }) };
const PUBLIC_VIEW = { stdout: JSON.stringify({ isPrivate: false, owner: { login: 'dngioidev' }, name: 'forge' }) };
const runnersResponse = (runners) => ({ stdout: JSON.stringify({ total_count: runners.length, runners }) });
const FORGE_LINUX = [{ name: 'self-hosted' }, { name: 'linux' }, { name: 'forge-local' }];
const FORGE_WINDOWS = [{ name: 'self-hosted' }, { name: 'windows' }, { name: 'forge-local' }];
const releaseResponse = (version) => ({
  stdout: JSON.stringify({
    tag_name: `v${version}`,
    body: `<!-- BEGIN SHA linux-x64 -->${'a'.repeat(64)}<!-- END SHA linux-x64 -->\n<!-- BEGIN SHA win-x64 -->${'b'.repeat(64)}<!-- END SHA win-x64 -->`,
  }),
});

/** gh routes: isPrivate view, generic view, runners endpoint, release. */
function routes({ view = PRIVATE_VIEW, runners, release = releaseResponse('2.340.0') } = {}) {
  const r = [
    ['auth status', AUTH_OK],
    [(j) => j.startsWith('repo view') && j.includes('isPrivate'), view],
    ['repo view', REPO_VIEW],
    [(j) => j.startsWith('api repos/actions/runner/releases/latest'), release],
  ];
  if (runners !== undefined) r.push([(j) => j.startsWith('api ') && j.includes('actions/runners'), runners]);
  r.push([() => true, { ok: false, stderr: 'unrouted' }]);
  return r;
}

describe('runCheck — adoption readiness (#245)', () => {
  it('all green → READY (ok:true, no failures)', async () => {
    const cwd = await gitRepo();
    await writeCfg(cwd, { enabled: true, windows: 'hosted' });
    await writeScaffold(cwd, { version: '2.340.0' });
    const { gh } = fakeGh(routes({ runners: runnersResponse([{ id: 1, status: 'online', labels: FORGE_LINUX }]) }));
    const res = await runCheck({ gh, cwd, log: noop, exec: fakeExec() });
    expect(res.ready).toBe(true);
    expect(res.ok).toBe(true);
    expect(res.results.filter((r) => r.level === 'fail')).toEqual([]);
    expect(levelOf(res, 'private-repo')).toBe('ok');
    expect(levelOf(res, 'runner-block')).toBe('ok');
    expect(levelOf(res, 'runner-online')).toBe('ok');
    expect(levelOf(res, 'runner-secret')).toBe('ok');
    expect(levelOf(res, 'scaffold')).toBe('ok');
    expect(levelOf(res, 'runner-version')).toBe('ok');
  });

  it('PUBLIC repo → NOT READY, private-repo guard fails (fork-PR RCE)', async () => {
    const cwd = await gitRepo();
    await writeCfg(cwd, { enabled: true, windows: 'hosted' });
    await writeScaffold(cwd);
    const { gh } = fakeGh(routes({ view: PUBLIC_VIEW, runners: runnersResponse([{ id: 1, status: 'online', labels: FORGE_LINUX }]) }));
    const res = await runCheck({ gh, cwd, log: noop, exec: fakeExec() });
    expect(res.ready).toBe(false);
    expect(byName(res, 'private-repo')[0].level).toBe('fail');
    expect(byName(res, 'private-repo')[0].msg).toMatch(/public|fork/i);
  });

  it('AC-426.1, AC-426.2: this repo\'s own committed forge.json runner block, run against its real PUBLIC topology → honest NOT READY (never a false READY for an inactive, unsafe-to-adopt config)', async () => {
    const cwd = await gitRepo();
    const committed = JSON.parse(await readFile(join(process.cwd(), '.claude', 'forge.json'), 'utf8'));
    // Pin: the committed block must not claim "enabled" on this public repo (#426) —
    // CI here runs entirely on GitHub-hosted runners (.github/workflows/verify.yml).
    expect(committed.runner?.enabled).not.toBe(true);
    await mkdir(join(cwd, '.claude'), { recursive: true });
    await writeFile(join(cwd, '.claude', 'forge.json'), JSON.stringify(committed), 'utf8');
    await writeScaffold(cwd);
    const { gh } = fakeGh(routes({ view: PUBLIC_VIEW, runners: runnersResponse([{ id: 1, status: 'online', labels: FORGE_LINUX }]) }));
    const res = await runCheck({ gh, cwd, log: noop, exec: fakeExec() });
    // Never a false READY for a config that is both disabled and unsafe to enable here.
    expect(res.ready).toBe(false);
    expect(byName(res, 'runner-block')[0].level).toBe('fail');
    expect(byName(res, 'runner-block')[0].msg).toMatch(/disabled/i);
    expect(byName(res, 'private-repo')[0].level).toBe('fail');
    expect(byName(res, 'private-repo')[0].msg).toMatch(/public|fork/i);
  });

  it('runner block missing/disabled → NOT READY (runner-block fail)', async () => {
    const cwd = await gitRepo();
    await writeCfg(cwd, { enabled: false });
    await writeScaffold(cwd);
    const { gh } = fakeGh(routes({ runners: runnersResponse([{ id: 1, status: 'online', labels: FORGE_LINUX }]) }));
    const res = await runCheck({ gh, cwd, log: noop, exec: fakeExec() });
    expect(res.ready).toBe(false);
    expect(byName(res, 'runner-block')[0].level).toBe('fail');
  });

  it('a prereq absent (docker not reachable) → NOT READY (prereq-docker fail)', async () => {
    const cwd = await gitRepo();
    await writeCfg(cwd, { enabled: true, windows: 'hosted' });
    await writeScaffold(cwd);
    const { gh } = fakeGh(routes({ runners: runnersResponse([{ id: 1, status: 'online', labels: FORGE_LINUX }]) }));
    const res = await runCheck({ gh, cwd, log: noop, exec: fakeExec({ git: true, gh: true, docker: false, dockerInfo: false }) });
    expect(res.ready).toBe(false);
    expect(byName(res, 'prereq-docker')[0].level).toBe('fail');
    expect(byName(res, 'prereq-docker')[0].msg).toMatch(/not found/i);
  });

  it('docker installed but daemon down → prereq-docker fail with a daemon hint', async () => {
    const cwd = await gitRepo();
    await writeCfg(cwd, { enabled: true, windows: 'hosted' });
    await writeScaffold(cwd);
    const { gh } = fakeGh(routes({ runners: runnersResponse([{ id: 1, status: 'online', labels: FORGE_LINUX }]) }));
    const res = await runCheck({ gh, cwd, log: noop, exec: fakeExec({ git: true, gh: true, docker: true, dockerInfo: false }) });
    expect(byName(res, 'prereq-docker')[0].level).toBe('fail');
    expect(byName(res, 'prereq-docker')[0].msg).toMatch(/daemon/i);
  });

  it('gh missing on PATH → NOT READY (prereq-gh fail)', async () => {
    const cwd = await gitRepo();
    await writeCfg(cwd, { enabled: true, windows: 'hosted' });
    await writeScaffold(cwd);
    const { gh } = fakeGh(routes({ runners: runnersResponse([{ id: 1, status: 'online', labels: FORGE_LINUX }]) }));
    const res = await runCheck({ gh, cwd, log: noop, exec: fakeExec({ git: true, gh: false, docker: true, dockerInfo: true }) });
    expect(res.ready).toBe(false);
    expect(byName(res, 'prereq-gh')[0].level).toBe('fail');
  });

  it('secret store unsafe (runner.env committed) → NOT READY (runner-secret fail)', async () => {
    const cwd = await gitRepo({ gitignore: '.forge/\n', files: { 'runner.env': 'FORGE_RUNNER_PAT=redacted\n' } });
    await writeCfg(cwd, { enabled: true, windows: 'hosted' });
    await writeScaffold(cwd);
    const { gh } = fakeGh(routes({ runners: runnersResponse([{ id: 1, status: 'online', labels: FORGE_LINUX }]) }));
    const res = await runCheck({ gh, cwd, log: noop, exec: fakeExec() });
    expect(res.ready).toBe(false);
    expect(byName(res, 'runner-secret')[0].level).toBe('fail');
    expect(byName(res, 'runner-secret')[0].msg).toMatch(/track/i);
  });

  it('no runner online → NOT READY (runner-online fail, adoption gate)', async () => {
    const cwd = await gitRepo();
    await writeCfg(cwd, { enabled: true, windows: 'hosted' });
    await writeScaffold(cwd);
    const { gh } = fakeGh(routes({ runners: runnersResponse([{ id: 1, status: 'offline', labels: FORGE_LINUX }]) }));
    const res = await runCheck({ gh, cwd, log: noop, exec: fakeExec() });
    expect(res.ready).toBe(false);
    expect(byName(res, 'runner-online')[0].level).toBe('fail');
    expect(byName(res, 'runner-online')[0].msg).toMatch(/offline/i);
  });

  it('no matching runner registered → NOT READY (runner-online fail)', async () => {
    const cwd = await gitRepo();
    await writeCfg(cwd, { enabled: true, windows: 'hosted' });
    await writeScaffold(cwd);
    const { gh } = fakeGh(routes({ runners: runnersResponse([{ id: 9, status: 'online', labels: [{ name: 'self-hosted' }, { name: 'linux' }] }]) }));
    const res = await runCheck({ gh, cwd, log: noop, exec: fakeExec() });
    expect(res.ready).toBe(false);
    expect(byName(res, 'runner-online')[0].level).toBe('fail');
    expect(byName(res, 'runner-online')[0].msg).toMatch(/no self-hosted runner|register/i);
  });

  it('graceful-degrade: gh api runners call fails → runner-online WARN (not a crash, not a fail)', async () => {
    const cwd = await gitRepo();
    await writeCfg(cwd, { enabled: true, windows: 'hosted' });
    await writeScaffold(cwd);
    const { gh } = fakeGh(routes({ runners: { ok: false, stderr: 'HTTP 403: Resource not accessible by personal access token' } }));
    const res = await runCheck({ gh, cwd, log: noop, exec: fakeExec() });
    expect(byName(res, 'runner-online')[0].level).toBe('warn');
    // a transient gh failure must not, by itself, flip the verdict to NOT READY
    expect(res.results.filter((r) => r.level === 'fail').map((r) => r.name)).not.toContain('runner-online');
  });

  it('graceful-degrade: gh repo view fails → private-repo WARN, secret scan still runs, no crash', async () => {
    const cwd = await gitRepo();
    await writeCfg(cwd, { enabled: true, windows: 'hosted' });
    await writeScaffold(cwd);
    const { gh } = fakeGh(routes({ view: { ok: false, stderr: 'network is unreachable' } }));
    const res = await runCheck({ gh, cwd, log: noop, exec: fakeExec() });
    expect(byName(res, 'private-repo')[0].level).toBe('warn');
    // secret store is git-only → still evaluated
    expect(byName(res, 'runner-secret')[0].level).toBe('ok');
    // online probe skipped (no owner/name) → surfaced as a warn, never a throw
    expect(byName(res, 'runner-online')[0].level).toBe('warn');
  });

  it('windows:native → probes the windows label set too; offline windows runner → NOT READY', async () => {
    const cwd = await gitRepo();
    await writeCfg(cwd, { enabled: true, windows: 'native' });
    await writeScaffold(cwd);
    // only the linux runner is online; the windows leg has no online runner
    const { gh, calls } = fakeGh(routes({ runners: runnersResponse([{ id: 1, status: 'online', labels: FORGE_LINUX }]) }));
    const res = await runCheck({ gh, cwd, log: noop, exec: fakeExec() });
    expect(byName(res, 'runner-online')[0].level).toBe('ok');
    expect(byName(res, 'runner-online-windows')[0].level).toBe('fail');
    expect(res.ready).toBe(false);
    // it did query the runners endpoint (both legs share it)
    expect(calls.some((c) => c.includes('actions/runners'))).toBe(true);
  });

  it('windows:native with an online windows runner → READY', async () => {
    const cwd = await gitRepo();
    await writeCfg(cwd, { enabled: true, windows: 'native' });
    await writeScaffold(cwd);
    const { gh } = fakeGh(routes({
      runners: runnersResponse([
        { id: 1, status: 'online', labels: FORGE_LINUX },
        { id: 2, status: 'online', labels: FORGE_WINDOWS },
      ]),
    }));
    const res = await runCheck({ gh, cwd, log: noop, exec: fakeExec() });
    expect(byName(res, 'runner-online-windows')[0].level).toBe('ok');
    expect(res.ready).toBe(true);
  });

  it('scaffold missing → scaffold fail; version check silently skipped', async () => {
    const cwd = await gitRepo();
    await writeCfg(cwd, { enabled: true, windows: 'hosted' });
    // no writeScaffold
    const { gh } = fakeGh(routes({ runners: runnersResponse([{ id: 1, status: 'online', labels: FORGE_LINUX }]) }));
    const res = await runCheck({ gh, cwd, log: noop, exec: fakeExec() });
    expect(byName(res, 'scaffold')[0].level).toBe('fail');
    expect(byName(res, 'runner-version')).toEqual([]); // nothing scaffolded → silent skip
    expect(res.ready).toBe(false);
  });

  it('stale pinned runner version → warn (advisory, not a blocker on its own)', async () => {
    const cwd = await gitRepo();
    await writeCfg(cwd, { enabled: true, windows: 'hosted' });
    await writeScaffold(cwd, { version: '2.300.0' }); // behind
    const { gh } = fakeGh(routes({
      runners: runnersResponse([{ id: 1, status: 'online', labels: FORGE_LINUX }]),
      release: releaseResponse('2.340.0'),
    }));
    const res = await runCheck({ gh, cwd, log: noop, exec: fakeExec() });
    expect(byName(res, 'runner-version')[0].level).toBe('warn');
    expect(byName(res, 'runner-version')[0].msg).toMatch(/2\.300\.0/);
    expect(res.results.filter((r) => r.level === 'fail').map((r) => r.name)).not.toContain('runner-version');
  });

  it('#260 AC5: a service present but 0 online matching runners → mis-target WARN hint', async () => {
    const cwd = await gitRepo();
    await writeCfg(cwd, { enabled: true, windows: 'hosted' });
    await writeScaffold(cwd);
    // no online runner for this repo…
    const { gh } = fakeGh(routes({ runners: runnersResponse([{ id: 1, status: 'offline', labels: FORGE_LINUX }]) }));
    // …but a local service IS installed, targeting a DIFFERENT repo (JIT-ephemeral hides this)
    const detectServices = async () => [{ name: 'forge-runner-dngioidev-iomanage', owner: 'dngioidev', repo: 'iomanage' }];
    const res = await runCheck({ gh, cwd, log: noop, exec: fakeExec(), detectServices });
    const svc = byName(res, 'runner-service')[0];
    expect(svc.level).toBe('warn');
    expect(svc.msg).toMatch(/different repo/i);
    expect(svc.msg).toMatch(/dngioidev\/iomanage/); // resolved service target surfaced
  });

  it('#260 AC5: no local service detected → no runner-service result (silent)', async () => {
    const cwd = await gitRepo();
    await writeCfg(cwd, { enabled: true, windows: 'hosted' });
    await writeScaffold(cwd);
    const { gh } = fakeGh(routes({ runners: runnersResponse([{ id: 1, status: 'online', labels: FORGE_LINUX }]) }));
    const res = await runCheck({ gh, cwd, log: noop, exec: fakeExec(), detectServices: async () => [] });
    expect(byName(res, 'runner-service')).toEqual([]);
  });

  it('missing forge.json → NOT READY (config fail pointing at init)', async () => {
    const cwd = await gitRepo();
    // no forge.json written
    const { gh } = fakeGh(routes({ runners: runnersResponse([{ id: 1, status: 'online', labels: FORGE_LINUX }]) }));
    const res = await runCheck({ gh, cwd, log: noop, exec: fakeExec() });
    expect(res.ready).toBe(false);
    expect(byName(res, 'config')[0].level).toBe('fail');
    expect(byName(res, 'config')[0].hint).toContain('/forge:init');
  });
});
