import { describe, it, expect } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runDoctor } from '../plugin/scripts/doctor.mjs';
import { run } from '../plugin/scripts/lib/exec.mjs';
import { emitAgyPlugin } from '../plugin/scripts/agy/emit.mjs';
import { fakeGh, fieldsResponse, REPO_VIEW, AUTH_OK } from './helpers/fakegh.mjs';

const noop = () => {};
const byName = (res, name) => res.results.filter((r) => r.name === name);

async function tmpCwd() {
  return mkdtemp(join(tmpdir(), 'forge-doc-'));
}

/** Init a real git repo in a tmp dir with the given tracked files + .gitignore, committed. */
async function gitRepo({ gitignore = '.forge/\n', files = {}, force = [] } = {}) {
  const cwd = await tmpCwd();
  await run('git', ['-C', cwd, 'init', '-q']);
  await writeFile(join(cwd, '.gitignore'), gitignore, 'utf8');
  for (const [rel, body] of Object.entries(files)) {
    const abs = join(cwd, rel);
    await mkdir(join(abs, '..'), { recursive: true });
    await writeFile(abs, body, 'utf8');
  }
  await run('git', ['-C', cwd, 'add', '-A']);
  for (const rel of force) await run('git', ['-C', cwd, 'add', '-f', '--', rel]);
  await run('git', ['-C', cwd, '-c', 'user.email=t@t.dev', '-c', 'user.name=t', 'commit', '-q', '-m', 'init']);
  return cwd;
}

/** Write a valid forge.json (based on the committed one) with a runner block into cwd. */
async function writeCfg(cwd, runner) {
  const committed = JSON.parse(await readFile(join(process.cwd(), '.claude', 'forge.json'), 'utf8'));
  if (runner !== undefined) committed.runner = runner;
  // no runner arg → truly feature-off, regardless of the live repo's committed config
  else delete committed.runner;
  await mkdir(join(cwd, '.claude'), { recursive: true });
  await writeFile(join(cwd, '.claude', 'forge.json'), JSON.stringify(committed), 'utf8');
}

const PRIVATE_VIEW = { stdout: JSON.stringify({ isPrivate: true, owner: { login: 'dngioidev' }, name: 'forge' }) };
const PUBLIC_VIEW = { stdout: JSON.stringify({ isPrivate: false, owner: { login: 'dngioidev' }, name: 'forge' }) };
const runnersResponse = (runners) => ({ stdout: JSON.stringify({ total_count: runners.length, runners }) });
const FORGE_LABELS = [{ name: 'self-hosted' }, { name: 'linux' }, { name: 'forge-local' }];

// #233: an actions/runner release response for the staleness check. SHA markers
// live in the release body; only tag_name matters for version comparison.
const releaseResponse = (version) => ({
  stdout: JSON.stringify({
    tag_name: `v${version}`,
    body: `<!-- BEGIN SHA linux-x64 -->${'a'.repeat(64)}<!-- END SHA linux-x64 -->\n<!-- BEGIN SHA win-x64 -->${'b'.repeat(64)}<!-- END SHA win-x64 -->`,
  }),
});

// Routes shared by the runner tests: auth ok, isPrivate view first, then generic
// repo view + a catch-all so unrelated checks (board/security) don't throw.
function runnerRoutes({ view = PRIVATE_VIEW, runners, release, approval } = {}) {
  // The generic `GET /repos/{owner}/{repo}` response — read by doctor's
  // branch-protection/secret-scanning block AND the #489 fork-pr-exposure check,
  // both from the SAME `sec` call — is kept consistent with `view`'s isPrivate so
  // the two visibility sources inside doctor.mjs can never disagree in a test.
  let viewIsPrivate = true;
  try { viewIsPrivate = JSON.parse(view.stdout ?? '{}').isPrivate !== false; } catch { /* keep the safe default */ }
  const routes = [
    ['auth status', AUTH_OK],
    [(j) => j.startsWith('repo view') && j.includes('isPrivate'), view],
    ['repo view', REPO_VIEW],
    [(j) => j === 'api repos/dngioidev/forge', { stdout: JSON.stringify({ private: viewIsPrivate, security_and_analysis: {} }) }],
  ];
  if (release !== undefined) routes.push([(j) => j.startsWith('api repos/actions/runner/releases/latest'), release]);
  // The approval-policy and runners-list endpoints are both under actions/... but
  // their full path strings never share a substring, so plain ordered predicates
  // route each to its own fixture without ambiguity.
  if (approval !== undefined) routes.push([(j) => j.includes('actions/permissions/fork-pr-contributor-approval'), approval]);
  if (runners !== undefined) routes.push([(j) => j.startsWith('api ') && j.includes('actions/runners'), runners]);
  routes.push([() => true, { ok: false, stderr: 'x' }]);
  return routes;
}

const approvalResponse = (policy) => ({ stdout: JSON.stringify({ approval_policy: policy }) });

/** Write a scaffolded runner Dockerfile pinning RUNNER_VERSION for the staleness check. */
async function writeRunnerDockerfile(cwd, version) {
  await mkdir(join(cwd, 'runner', 'linux'), { recursive: true });
  await writeFile(join(cwd, 'runner', 'linux', 'Dockerfile'), `FROM node:22\nARG RUNNER_VERSION=${version}\nARG RUNNER_SHA256=${'a'.repeat(64)}\n`, 'utf8');
}

describe('runDoctor — runner health (AC-225.4)', () => {
  it('feature off (no runner block) → runner checks are absent, no noise', async () => {
    const cwd = await gitRepo();
    await writeCfg(cwd); // no runner block
    const { gh } = fakeGh(runnerRoutes());
    const res = await runDoctor({ gh, cwd, log: noop });
    expect(byName(res, 'runner')).toEqual([]);
    expect(byName(res, 'runner-secret')).toEqual([]);
  });

  it('runner.enabled:false → still silent', async () => {
    const cwd = await gitRepo();
    await writeCfg(cwd, { enabled: false });
    const { gh } = fakeGh(runnerRoutes());
    const res = await runDoctor({ gh, cwd, log: noop });
    expect(byName(res, 'runner')).toEqual([]);
    expect(byName(res, 'runner-secret')).toEqual([]);
  });

  it('enabled + a matching runner online → ok', async () => {
    const cwd = await gitRepo({ gitignore: '.forge/\nrunner.env\n' });
    await writeCfg(cwd, { enabled: true });
    const { gh } = fakeGh(runnerRoutes({
      runners: runnersResponse([{ id: 1, name: 'box', status: 'online', labels: FORGE_LABELS }]),
    }));
    const res = await runDoctor({ gh, cwd, log: noop });
    expect(byName(res, 'runner')[0].level).toBe('ok');
    expect(byName(res, 'runner')[0].msg).toMatch(/online/);
    // secret store: gitignored + untracked + no PAT → ok
    expect(byName(res, 'runner-secret')[0].level).toBe('ok');
    expect(res.results.filter((r) => r.level === 'fail').map((r) => r.name)).not.toContain('runner');
  });

  it('enabled + matching runner OFFLINE → warn (not a crash, not ok)', async () => {
    const cwd = await gitRepo({ gitignore: '.forge/\nrunner.env\n' });
    await writeCfg(cwd, { enabled: true });
    const { gh } = fakeGh(runnerRoutes({
      runners: runnersResponse([{ id: 1, name: 'box', status: 'offline', labels: FORGE_LABELS }]),
    }));
    const res = await runDoctor({ gh, cwd, log: noop });
    expect(byName(res, 'runner')[0].level).toBe('warn');
    expect(byName(res, 'runner')[0].msg).toMatch(/offline/);
  });

  it('enabled + NO matching runner registered → warn', async () => {
    const cwd = await gitRepo({ gitignore: '.forge/\nrunner.env\n' });
    await writeCfg(cwd, { enabled: true });
    const { gh } = fakeGh(runnerRoutes({
      // an online runner but WITHOUT the forge-local label → not a match
      runners: runnersResponse([{ id: 9, name: 'other', status: 'online', labels: [{ name: 'self-hosted' }, { name: 'linux' }] }]),
    }));
    const res = await runDoctor({ gh, cwd, log: noop });
    expect(byName(res, 'runner')[0].level).toBe('warn');
    expect(byName(res, 'runner')[0].msg).toMatch(/no self-hosted runner|not registered|register/i);
  });

  it('enabled + gh api lacks scope / 403 → degrades to warn, does not crash', async () => {
    const cwd = await gitRepo({ gitignore: '.forge/\nrunner.env\n' });
    await writeCfg(cwd, { enabled: true });
    const { gh } = fakeGh(runnerRoutes({
      runners: { ok: false, stderr: 'HTTP 403: Resource not accessible by personal access token' },
    }));
    const res = await runDoctor({ gh, cwd, log: noop });
    expect(byName(res, 'runner')[0].level).toBe('warn');
  });

  it('enabled + sharing:org → queries the ORG runners endpoint', async () => {
    const cwd = await gitRepo({ gitignore: '.forge/\nrunner.env\n' });
    await writeCfg(cwd, { enabled: true, sharing: 'org' });
    const { gh, calls } = fakeGh(runnerRoutes({
      runners: runnersResponse([{ id: 1, name: 'box', status: 'online', labels: FORGE_LABELS }]),
    }));
    const res = await runDoctor({ gh, cwd, log: noop });
    expect(byName(res, 'runner')[0].level).toBe('ok');
    expect(calls.some((c) => c.includes('api orgs/dngioidev/actions/runners'))).toBe(true);
  });

  it('enabled on a PUBLIC repo → FAIL with the fork-PR RCE message', async () => {
    const cwd = await tmpCwd();
    await writeCfg(cwd, { enabled: true });
    const { gh } = fakeGh(runnerRoutes({ view: PUBLIC_VIEW }));
    const res = await runDoctor({ gh, cwd, log: noop });
    const r = byName(res, 'runner')[0];
    expect(r.level).toBe('fail');
    expect(r.msg).toMatch(/public|fork/i);
    expect(res.ok).toBe(false);
  });

  it('AC-426.1, AC-426.2: this repo\'s own committed forge.json runner block matches hosted-CI reality — disabled on the PUBLIC repo it actually is, so doctor stays silent (no misleading FAIL)', async () => {
    const committed = JSON.parse(await readFile(join(process.cwd(), '.claude', 'forge.json'), 'utf8'));
    // Pin: this repo's CI runs entirely on GitHub-hosted runners (.github/workflows/verify.yml) —
    // the `runner` block must never silently drift back to "enabled" here (that's what caused
    // doctor to FAIL with a false fork-PR-RCE alarm before #426).
    expect(committed.runner?.enabled).not.toBe(true);
    const cwd = await tmpCwd();
    await mkdir(join(cwd, '.claude'), { recursive: true });
    await writeFile(join(cwd, '.claude', 'forge.json'), JSON.stringify(committed), 'utf8');
    const { gh } = fakeGh(runnerRoutes({ view: PUBLIC_VIEW }));
    const res = await runDoctor({ gh, cwd, log: noop });
    expect(byName(res, 'runner')).toEqual([]);
    expect(byName(res, 'runner-secret')).toEqual([]);
    expect(res.results.filter((r) => r.level === 'fail').map((r) => r.name)).not.toContain('runner');
  });

  it('secret store TRACKED in git → FAIL', async () => {
    // runner.env committed (not ignored) → tracked → fail
    const cwd = await gitRepo({ gitignore: '.forge/\n', files: { 'runner.env': 'FORGE_RUNNER_PAT=redacted\n' } });
    await writeCfg(cwd, { enabled: true });
    const { gh } = fakeGh(runnerRoutes({
      runners: runnersResponse([{ id: 1, name: 'box', status: 'online', labels: FORGE_LABELS }]),
    }));
    const res = await runDoctor({ gh, cwd, log: noop });
    const r = byName(res, 'runner-secret')[0];
    expect(r.level).toBe('fail');
    expect(r.msg).toMatch(/track/i);
  });

  it('secret-store scan is git-only and still runs when gh repo view fails', async () => {
    const token = 'ghp_' + 'y'.repeat(36);
    const cwd = await gitRepo({ gitignore: '.forge/\nrunner.env\n', files: { 'src/leak.js': `const t = "${token}";\n` } });
    await writeCfg(cwd, { enabled: true });
    const { gh } = fakeGh(runnerRoutes({ view: { ok: false, stderr: 'network is unreachable' } }));
    const res = await runDoctor({ gh, cwd, log: noop });
    // registration probe degrades to warn (visibility unknown)…
    expect(byName(res, 'runner')[0].level).toBe('warn');
    // …but the gh-independent secret scan still fires and catches the committed PAT
    expect(byName(res, 'runner-secret')[0].level).toBe('fail');
  });

  it('enabled + store present but runner.env NOT gitignored → warn', async () => {
    const cwd = await gitRepo({ gitignore: '.forge/\n' }); // runner.env pattern absent
    await writeCfg(cwd, { enabled: true });
    const { gh } = fakeGh(runnerRoutes({
      runners: runnersResponse([{ id: 1, name: 'box', status: 'online', labels: FORGE_LABELS }]),
    }));
    const res = await runDoctor({ gh, cwd, log: noop });
    expect(byName(res, 'runner-secret')[0].level).toBe('warn');
    expect(byName(res, 'runner-secret')[0].msg).toMatch(/gitignore/i);
  });

  it('#233: pinned runner version BEHIND latest → warn (deprecation staleness)', async () => {
    const cwd = await gitRepo({ gitignore: '.forge/\nrunner.env\n' });
    await writeCfg(cwd, { enabled: true });
    await writeRunnerDockerfile(cwd, '2.300.0'); // stale pin
    const { gh } = fakeGh(runnerRoutes({
      runners: runnersResponse([{ id: 1, name: 'box', status: 'online', labels: FORGE_LABELS }]),
      release: releaseResponse('2.340.0'),
    }));
    const res = await runDoctor({ gh, cwd, log: noop });
    const r = byName(res, 'runner-version')[0];
    expect(r.level).toBe('warn');
    expect(r.msg).toMatch(/2\.300\.0/);
    expect(r.msg).toMatch(/2\.340\.0/);
    expect(r.msg).toMatch(/deprecat/i);
    // staleness is advisory, never a hard failure
    expect(res.results.filter((x) => x.level === 'fail').map((x) => x.name)).not.toContain('runner-version');
  });

  it('#233: pinned runner version CURRENT (== latest) → ok', async () => {
    const cwd = await gitRepo({ gitignore: '.forge/\nrunner.env\n' });
    await writeCfg(cwd, { enabled: true });
    await writeRunnerDockerfile(cwd, '2.340.0');
    const { gh } = fakeGh(runnerRoutes({
      runners: runnersResponse([{ id: 1, name: 'box', status: 'online', labels: FORGE_LABELS }]),
      release: releaseResponse('2.340.0'),
    }));
    const res = await runDoctor({ gh, cwd, log: noop });
    expect(byName(res, 'runner-version')[0].level).toBe('ok');
  });

  it('#233: release lookup fails → staleness check is a silent skip (no runner-version result)', async () => {
    const cwd = await gitRepo({ gitignore: '.forge/\nrunner.env\n' });
    await writeCfg(cwd, { enabled: true });
    await writeRunnerDockerfile(cwd, '2.300.0');
    const { gh } = fakeGh(runnerRoutes({
      runners: runnersResponse([{ id: 1, name: 'box', status: 'online', labels: FORGE_LABELS }]),
      release: { ok: false, stderr: 'network is unreachable' },
    }));
    const res = await runDoctor({ gh, cwd, log: noop });
    expect(byName(res, 'runner-version')).toEqual([]); // silent — can't judge staleness
    expect(res.results.filter((x) => x.level === 'fail').map((x) => x.name)).not.toContain('runner-version');
  });

  it('#233: no scaffolded runner files → staleness check is a silent skip', async () => {
    const cwd = await gitRepo({ gitignore: '.forge/\nrunner.env\n' });
    await writeCfg(cwd, { enabled: true });
    // no runner/linux/Dockerfile written
    const { gh } = fakeGh(runnerRoutes({
      runners: runnersResponse([{ id: 1, name: 'box', status: 'online', labels: FORGE_LABELS }]),
      release: releaseResponse('2.340.0'),
    }));
    const res = await runDoctor({ gh, cwd, log: noop });
    expect(byName(res, 'runner-version')).toEqual([]);
  });

  it('label matching is case-insensitive (FORGE-LOCAL registered, forge-local configured) → ok', async () => {
    const cwd = await gitRepo({ gitignore: '.forge/\nrunner.env\n' });
    await writeCfg(cwd, { enabled: true, labels: ['self-hosted', 'linux', 'forge-local'] });
    const { gh } = fakeGh(runnerRoutes({
      runners: runnersResponse([{ id: 1, name: 'box', status: 'online', labels: [{ name: 'Self-Hosted' }, { name: 'Linux' }, { name: 'FORGE-LOCAL' }] }]),
    }));
    const res = await runDoctor({ gh, cwd, log: noop });
    expect(byName(res, 'runner')[0].level).toBe('ok');
  });

  it('#260 AC5: service present but 0 online matching runners → mis-target WARN hint', async () => {
    const cwd = await gitRepo({ gitignore: '.forge/\nrunner.env\n' });
    await writeCfg(cwd, { enabled: true });
    // no online runner for the configured repo…
    const { gh } = fakeGh(runnerRoutes({
      runners: runnersResponse([{ id: 1, name: 'box', status: 'offline', labels: FORGE_LABELS }]),
    }));
    // …but a local service is installed targeting a DIFFERENT repo (JIT-ephemeral hides this)
    const detectServices = async () => [{ name: 'forge-runner-dngioidev-iomanage', owner: 'dngioidev', repo: 'iomanage' }];
    const res = await runDoctor({ gh, cwd, log: noop, detectServices });
    const svc = byName(res, 'runner-service')[0];
    expect(svc.level).toBe('warn');
    expect(svc.msg).toMatch(/different repo/i);
    expect(svc.msg).toMatch(/dngioidev\/iomanage/);
    // advisory only — the mis-target hint is a warn, never flips doctor to failing
    expect(res.results.filter((r) => r.level === 'fail').map((r) => r.name)).not.toContain('runner-service');
  });

  it('#260 AC5: online runner + service present → ok surfacing the resolved target', async () => {
    const cwd = await gitRepo({ gitignore: '.forge/\nrunner.env\n' });
    await writeCfg(cwd, { enabled: true });
    const { gh } = fakeGh(runnerRoutes({
      runners: runnersResponse([{ id: 1, name: 'box', status: 'online', labels: FORGE_LABELS }]),
    }));
    const detectServices = async () => [{ name: 'forge-runner-dngioidev-forge', owner: 'dngioidev', repo: 'forge' }];
    const res = await runDoctor({ gh, cwd, log: noop, detectServices });
    const svc = byName(res, 'runner-service')[0];
    expect(svc.level).toBe('ok');
    expect(svc.msg).toMatch(/dngioidev\/forge/);
  });

  it('PAT-looking secret in a committed file → FAIL', async () => {
    const token = 'ghp_' + 'x'.repeat(36); // shape-valid classic PAT, not a real secret
    const cwd = await gitRepo({ gitignore: '.forge/\nrunner.env\n', files: { 'src/leak.js': `const t = "${token}";\n` } });
    await writeCfg(cwd, { enabled: true });
    const { gh } = fakeGh(runnerRoutes({
      runners: runnersResponse([{ id: 1, name: 'box', status: 'online', labels: FORGE_LABELS }]),
    }));
    const res = await runDoctor({ gh, cwd, log: noop });
    const r = byName(res, 'runner-secret')[0];
    expect(r.level).toBe('fail');
    expect(r.msg).toMatch(/PAT|secret/i);
  });
});

describe('runDoctor — fork-PR execution-surface check (AC-489.2) — also the public+registered warn/fail case for AC-490.2/AC-490.4 (#490); do not duplicate here, see the reconciliation describe block below', () => {
  it('private repo → skip (not applicable), never a failure', async () => {
    const cwd = await gitRepo();
    await writeCfg(cwd); // no runner block — this check must fire regardless
    const { gh } = fakeGh(runnerRoutes());
    const res = await runDoctor({ gh, cwd, log: noop });
    const r = byName(res, 'fork-pr-exposure')[0];
    expect(r.level).toBe('skip');
  });

  it('public repo, zero self-hosted runners registered → ok', async () => {
    const cwd = await gitRepo();
    await writeCfg(cwd);
    const { gh } = fakeGh(runnerRoutes({ view: PUBLIC_VIEW, runners: runnersResponse([]) }));
    const res = await runDoctor({ gh, cwd, log: noop });
    const r = byName(res, 'fork-pr-exposure')[0];
    expect(r.level).toBe('ok');
    expect(r.msg).toMatch(/no fork-PR execution surface/);
  });

  it('public repo + a runner registered + approval_policy:all_external_contributors → ok (gated)', async () => {
    const cwd = await gitRepo();
    await writeCfg(cwd);
    const { gh } = fakeGh(runnerRoutes({
      view: PUBLIC_VIEW,
      runners: runnersResponse([{ id: 9001, name: 'runner-example-01', status: 'online', labels: [{ name: 'self-hosted' }, { name: 'forge-local' }, { name: 'windows' }] }]),
      approval: approvalResponse('all_external_contributors'),
    }));
    const res = await runDoctor({ gh, cwd, log: noop });
    const r = byName(res, 'fork-pr-exposure')[0];
    expect(r.level).toBe('ok');
    expect(r.msg).toMatch(/ALL external contributors/);
    expect(res.results.filter((x) => x.level === 'fail').map((x) => x.name)).not.toContain('fork-pr-exposure');
  });

  it('public repo + a runner registered + approval_policy:first_time_contributors (less strict than required) → FAIL', async () => {
    const cwd = await gitRepo();
    await writeCfg(cwd);
    const { gh } = fakeGh(runnerRoutes({
      view: PUBLIC_VIEW,
      runners: runnersResponse([{ id: 9001, name: 'runner-example-01', status: 'online', labels: [{ name: 'self-hosted' }, { name: 'forge-local' }, { name: 'windows' }] }]),
      approval: approvalResponse('first_time_contributors'),
    }));
    const res = await runDoctor({ gh, cwd, log: noop });
    const r = byName(res, 'fork-pr-exposure')[0];
    expect(r.level).toBe('fail');
    expect(r.msg).toMatch(/first_time_contributors/);
    expect(r.msg).toMatch(/runner-example-01/);
    expect(res.ok).toBe(false);
  });

  it('BREAK IT: runners-list API call fails → warn fallback, never a silent ok', async () => {
    const cwd = await gitRepo();
    await writeCfg(cwd);
    const { gh } = fakeGh(runnerRoutes({
      view: PUBLIC_VIEW,
      runners: { ok: false, stderr: 'HTTP 403: Resource not accessible by personal access token' },
    }));
    const res = await runDoctor({ gh, cwd, log: noop });
    const r = byName(res, 'fork-pr-exposure')[0];
    expect(r.level).toBe('warn');
    expect(r.msg).toMatch(/could not query registered self-hosted runners/);
  });

  it('BREAK IT: a runner is registered but the approval-policy API call fails → warn naming the manual fallback + #490, not a silent ok', async () => {
    const cwd = await gitRepo();
    await writeCfg(cwd);
    const { gh } = fakeGh(runnerRoutes({
      view: PUBLIC_VIEW,
      runners: runnersResponse([{ id: 1, name: 'box', status: 'online', labels: FORGE_LABELS }]),
      approval: { ok: false, stderr: 'HTTP 404' },
    }));
    const res = await runDoctor({ gh, cwd, log: noop });
    const r = byName(res, 'fork-pr-exposure')[0];
    expect(r.level).toBe('warn');
    expect(r.msg).toMatch(/could not be read via the API/);
    expect(r.hint).toMatch(/manually verify/i);
    expect(r.hint).toMatch(/#490/);
  });

  it('fires regardless of this repo\'s OWN runner.enabled:false — the config/reality drift #489 was filed over', async () => {
    const cwd = await gitRepo();
    await writeCfg(cwd, { enabled: false }); // this repo's own config disabled, like real forge.json
    const { gh } = fakeGh(runnerRoutes({
      view: PUBLIC_VIEW,
      runners: runnersResponse([{ id: 9001, name: 'runner-example-01', status: 'online', labels: [{ name: 'self-hosted' }, { name: 'forge-local' }, { name: 'windows' }] }]),
      approval: approvalResponse('first_time_contributors'),
    }));
    const res = await runDoctor({ gh, cwd, log: noop });
    // the OLD runner.enabled-gated check stays silent (as designed, AC-426)…
    expect(byName(res, 'runner')).toEqual([]);
    // …but the NEW check still fires and catches the live exposure.
    expect(byName(res, 'fork-pr-exposure')[0].level).toBe('fail');
  });

  it('BREAK IT: runners-list API call succeeds (200) but the response shape is unexpected (no .runners array) → warn, never a silent ok (fail-closed like the approval-policy path)', async () => {
    const cwd = await gitRepo();
    await writeCfg(cwd);
    const { gh } = fakeGh(runnerRoutes({
      view: PUBLIC_VIEW,
      // total_count present, but no `runners` array — a schema-drift/malformed shape
      runners: { stdout: JSON.stringify({ total_count: 3 }) },
    }));
    const res = await runDoctor({ gh, cwd, log: noop });
    const r = byName(res, 'fork-pr-exposure')[0];
    expect(r.level).toBe('warn');
    expect(r.msg).toMatch(/unexpected shape/);
    expect(res.results.filter((x) => x.level === 'fail').map((x) => x.name)).not.toContain('fork-pr-exposure');
  });

  it('the repo API call (sec) fails → fork-pr-exposure WARNs naming the cause, never silently dropped (no redundant second gh repo view call)', async () => {
    const cwd = await gitRepo();
    await writeCfg(cwd);
    // 'repo view' resolves fine (repo.ok), but the plain `api repos/<owner>/<name>`
    // call (sec) is deliberately left unrouted so it falls to the generic catch-all.
    const routes = [
      ['auth status', AUTH_OK],
      ['repo view', REPO_VIEW],
      [(j) => j.startsWith('api repos/') && j.includes('/protection'), { ok: false, stderr: '404' }],
      [() => true, { ok: false, stderr: 'x' }],
    ];
    const { gh, calls } = fakeGh(routes);
    const res = await runDoctor({ gh, cwd, log: noop });
    const r = byName(res, 'fork-pr-exposure')[0];
    expect(r).toBeDefined();
    expect(r.level).toBe('warn');
    expect(r.msg).toMatch(/could not determine repo visibility/);
    // exactly one `repo view` call — no second, independent fetchRepoVisibility round trip
    expect(calls.filter((c) => c.startsWith('repo view')).length).toBe(1);
  });
});

// #490 AC.1/AC.3/AC.5 — reconcileRunnerRegistrations, wired into runDoctor near the
// sec/repo block that already drives fork-pr-exposure (reusing owner/name/isPrivate,
// not a fresh fetchRepoVisibility round trip). Deliberately runs INDEPENDENT of this
// repo's own `runner.enabled` — that gate is exactly the blind spot #490 reports: a
// private repo with runner.enabled:false but a live orphaned registration gets ZERO
// rows from doctor today (the old `checkRunner` block only runs when enabled).
// Never a `fail` level — additive to the existing hard-fail paths, only warn/ok/absent.
describe('runDoctor — live registration reconciliation (#490 AC.1/AC.3/AC.5)', () => {
  it('AC-490.1a: runner.enabled:false + a live registration (any label) -> new row warns "registered-but-config-disabled" (the blind spot #490 reports)', async () => {
    const cwd = await gitRepo();
    await writeCfg(cwd, { enabled: false });
    const { gh } = fakeGh(runnerRoutes({
      runners: runnersResponse([{ id: 1, name: 'orphan', status: 'online', labels: [{ name: 'self-hosted' }] }]),
    }));
    const res = await runDoctor({ gh, cwd, log: noop });
    // the OLD runner.enabled-gated check stays silent (as designed, AC-426)…
    expect(byName(res, 'runner')).toEqual([]);
    // …but the NEW reconciliation row still fires and catches the live orphan.
    const r = byName(res, 'runner-reconcile')[0];
    expect(r).toBeDefined();
    expect(r.level).toBe('warn');
    expect(r.msg).toMatch(/registered-but-config-disabled/);
  });

  it('AC-490.5: runner.enabled:false + nothing registered (ordinary consumer) -> silent, no new row at all', async () => {
    const cwd = await gitRepo();
    await writeCfg(cwd, { enabled: false });
    const { gh } = fakeGh(runnerRoutes({ runners: runnersResponse([]) }));
    const res = await runDoctor({ gh, cwd, log: noop });
    expect(byName(res, 'runner-reconcile')).toEqual([]);
  });

  it('AC-490.5: no runner block at all + nothing registered -> silent, no new row', async () => {
    const cwd = await gitRepo();
    await writeCfg(cwd); // no runner block
    const { gh } = fakeGh(runnerRoutes({ runners: runnersResponse([]) }));
    const res = await runDoctor({ gh, cwd, log: noop });
    expect(byName(res, 'runner-reconcile')).toEqual([]);
  });

  it('AC-490.1b: runner.enabled:true + 0 live registrations matching configured labels -> warn "config-enabled-but-none-registered"', async () => {
    const cwd = await gitRepo({ gitignore: '.forge/\nrunner.env\n' });
    await writeCfg(cwd, { enabled: true });
    const { gh } = fakeGh(runnerRoutes({ runners: runnersResponse([]) }));
    const res = await runDoctor({ gh, cwd, log: noop });
    const r = byName(res, 'runner-reconcile')[0];
    expect(r).toBeDefined();
    expect(r.level).toBe('warn');
    expect(r.msg).toMatch(/config-enabled-but-none-registered/);
  });

  it('AC-490.1c: runner.enabled:true + matching registrations all offline -> warn "stale/offline"', async () => {
    const cwd = await gitRepo({ gitignore: '.forge/\nrunner.env\n' });
    await writeCfg(cwd, { enabled: true });
    const { gh } = fakeGh(runnerRoutes({
      runners: runnersResponse([{ id: 1, name: 'box', status: 'offline', labels: FORGE_LABELS }]),
    }));
    const res = await runDoctor({ gh, cwd, log: noop });
    const r = byName(res, 'runner-reconcile')[0];
    expect(r).toBeDefined();
    expect(r.level).toBe('warn');
    expect(r.msg).toMatch(/stale|offline/i);
  });

  it('AC-490.4: runner.enabled:true + matching + an online registration -> ok (clean case); no-duplicate-fetch: reuses checkRunner\'s already-fetched list', async () => {
    const cwd = await gitRepo({ gitignore: '.forge/\nrunner.env\n' });
    await writeCfg(cwd, { enabled: true });
    const { gh, calls } = fakeGh(runnerRoutes({
      runners: runnersResponse([{ id: 1, name: 'box', status: 'online', labels: FORGE_LABELS }]),
    }));
    const res = await runDoctor({ gh, cwd, log: noop });
    const r = byName(res, 'runner-reconcile')[0];
    expect(r).toBeDefined();
    expect(r.level).toBe('ok');
    // the existing runner.enabled-gated check (checkRunner -> probeRunnerOnline)
    // already queried actions/runners in this scenario — reconciliation must
    // reuse that result, not issue a second, redundant fetch of the same endpoint.
    expect(calls.filter((c) => c.includes('actions/runners')).length).toBe(1);
  });

  it('AC-490.3: live lookup fails (config enabled) -> warn "could not verify", never a fail, never silently absent', async () => {
    const cwd = await gitRepo({ gitignore: '.forge/\nrunner.env\n' });
    await writeCfg(cwd, { enabled: true });
    const { gh } = fakeGh(runnerRoutes({
      runners: { ok: false, stderr: 'HTTP 403: Resource not accessible by personal access token' },
    }));
    const res = await runDoctor({ gh, cwd, log: noop });
    const r = byName(res, 'runner-reconcile')[0];
    expect(r).toBeDefined();
    expect(r.level).toBe('warn');
    expect(r.msg).toMatch(/could not verify/i);
    expect(res.results.filter((x) => x.level === 'fail').map((x) => x.name)).not.toContain('runner-reconcile');
  });

  it('AC-490.3: live lookup fails (config disabled) -> still warns "could not verify" — degrades regardless of config state', async () => {
    const cwd = await gitRepo();
    await writeCfg(cwd, { enabled: false });
    const { gh } = fakeGh(runnerRoutes({
      runners: { ok: false, stderr: 'network is unreachable' },
    }));
    const res = await runDoctor({ gh, cwd, log: noop });
    const r = byName(res, 'runner-reconcile')[0];
    expect(r).toBeDefined();
    expect(r.level).toBe('warn');
    expect(r.msg).toMatch(/could not verify/i);
  });

  it('AC-490.3: live lookup returns a malformed (non-array) body (config disabled) -> warns "could not verify", never a silent AC.5 skip', async () => {
    const cwd = await gitRepo();
    await writeCfg(cwd, { enabled: false });
    const { gh } = fakeGh(runnerRoutes({
      runners: { stdout: JSON.stringify({ total_count: 0 }) },
    }));
    const res = await runDoctor({ gh, cwd, log: noop });
    const r = byName(res, 'runner-reconcile')[0];
    expect(r).toBeDefined();
    expect(r.level).toBe('warn');
    expect(r.msg).toMatch(/could not verify/i);
  });

  it('runner.sharing:"org" -> reconciliation queries the ORG-scoped endpoint, not the repo-scoped one', async () => {
    const cwd = await gitRepo({ gitignore: '.forge/\nrunner.env\n' });
    await writeCfg(cwd, { enabled: true, sharing: 'org' });
    const { gh, calls } = fakeGh(runnerRoutes({
      runners: runnersResponse([{ id: 1, name: 'box', status: 'online', labels: FORGE_LABELS }]),
    }));
    const res = await runDoctor({ gh, cwd, log: noop });
    expect(byName(res, 'runner-reconcile')[0]).toBeDefined();
    expect(calls.some((c) => c.includes('api orgs/dngioidev/actions/runners'))).toBe(true);
    expect(calls.some((c) => c.includes('repos/dngioidev/forge/actions/runners'))).toBe(false);
  });
});

describe('runDoctor — failure classes (AC-1.4)', () => {
  it('missing gh auth is a distinct ✗', async () => {
    const { gh } = fakeGh([['auth status', { ok: false, stderr: 'not logged in' }]]);
    const res = await runDoctor({ gh, cwd: await tmpCwd(), log: noop });
    expect(res.ok).toBe(false);
    expect(byName(res, 'gh-auth')[0]).toMatchObject({ level: 'fail' });
    expect(byName(res, 'gh-auth')[0].hint).toContain('gh auth login');
  });

  it('missing project scope is a distinct ✗ with the refresh hint', async () => {
    const { gh } = fakeGh([
      ['auth status', { stdout: "  - Token scopes: 'gist', 'read:org', 'repo', 'workflow'\n" }],
      ['repo view', REPO_VIEW],
      [() => true, { ok: false, stderr: 'x' }],
    ]);
    const res = await runDoctor({ gh, cwd: await tmpCwd(), log: noop });
    expect(byName(res, 'gh-scope')[0]).toMatchObject({ level: 'fail' });
    expect(byName(res, 'gh-scope')[0].hint).toContain('gh auth refresh');
  });

  it('missing forge.json is a ✗ pointing at /forge:init', async () => {
    const { gh } = fakeGh([['auth status', AUTH_OK], ['repo view', REPO_VIEW], [() => true, { ok: false, stderr: 'x' }]]);
    const res = await runDoctor({ gh, cwd: await tmpCwd(), log: noop });
    const cfgFails = byName(res, 'config');
    expect(cfgFails[0]).toMatchObject({ level: 'fail' });
    expect(cfgFails[0].hint).toContain('/forge:init');
  });

  it('dangling field/option ids are a ✗ naming each dangling path', async () => {
    const cwd = await tmpCwd();
    const committed = JSON.parse(await readFile(join(process.cwd(), '.claude', 'forge.json'), 'utf8'));
    await mkdir(join(cwd, '.claude'), { recursive: true });
    await writeFile(join(cwd, '.claude', 'forge.json'), JSON.stringify(committed), 'utf8');
    await writeFile(join(cwd, '.gitignore'), '.forge/\n', 'utf8');

    // live board is missing the size field and one status option
    const liveFields = [
      { id: committed.board.fields.status.id, name: 'Status', options: [
        { id: committed.board.fields.status.options.backlog, name: 'Backlog' },
        { id: committed.board.fields.status.options.done, name: 'Done' }] },
      { id: committed.board.fields.priority.id, name: 'Priority', options: Object.entries(committed.board.fields.priority.options).map(([n, id]) => ({ id, name: n })) },
      { id: committed.board.fields.type.id, name: 'Type', options: Object.entries(committed.board.fields.type.options).map(([n, id]) => ({ id, name: n })) },
    ];
    const { gh } = fakeGh([
      ['auth status', AUTH_OK],
      ['repo view', REPO_VIEW],
      [(j) => j.includes('fields(first: 50)'), fieldsResponse(14, liveFields)],
      [() => true, { ok: false, stderr: '404' }],
    ]);
    const res = await runDoctor({ gh, cwd, log: noop });
    const board = byName(res, 'board')[0];
    expect(board.level).toBe('fail');
    expect(board.msg).toContain('size.id');
    expect(board.msg).toContain('status.options.inProgress');
  });

  it('AC-550.4 (#550): a board missing the kind field under BOTH names is a distinct, named ✗ (not silent, not folded into a vaguer message)', async () => {
    const cwd = await tmpCwd();
    const committed = JSON.parse(await readFile(join(process.cwd(), '.claude', 'forge.json'), 'utf8'));
    await mkdir(join(cwd, '.claude'), { recursive: true });
    await writeFile(join(cwd, '.claude', 'forge.json'), JSON.stringify(committed), 'utf8');
    await writeFile(join(cwd, '.gitignore'), '.forge/\n', 'utf8');

    // live board resolves status/priority/size fine but has neither "Kind" nor "Type"
    const liveFields = [
      { id: committed.board.fields.status.id, name: 'Status', options: Object.entries(committed.board.fields.status.options).map(([n, id]) => ({ id, name: n })) },
      { id: committed.board.fields.priority.id, name: 'Priority', options: Object.entries(committed.board.fields.priority.options).map(([n, id]) => ({ id, name: n })) },
      { id: committed.board.fields.size.id, name: 'Size', options: Object.entries(committed.board.fields.size.options).map(([n, id]) => ({ id, name: n })) },
    ];
    const { gh } = fakeGh([
      ['auth status', AUTH_OK],
      ['repo view', REPO_VIEW],
      [(j) => j.includes('fields(first: 50)'), fieldsResponse(14, liveFields)],
      [() => true, { ok: false, stderr: '404' }],
    ]);
    const res = await runDoctor({ gh, cwd, log: noop });
    const kind = byName(res, 'kind-field')[0];
    expect(kind.level).toBe('fail');
    expect(kind.msg).toMatch(/no kind field/i);
    expect(kind.msg).toMatch(/"Kind"/);
    expect(kind.msg).toMatch(/"Type"/);
    expect(kind.hint).toMatch(/re-run \/forge:init/);
    expect(kind.hint).toMatch(/reserves the literal name "Type"/);
    expect(res.ok).toBe(false);
  });

  it('AC-550.4 (#550): a board with a grandfathered "Type" field (this repo\'s own board #8 shape) resolves the kind field cleanly → ok', async () => {
    const cwd = await tmpCwd();
    const committed = JSON.parse(await readFile(join(process.cwd(), '.claude', 'forge.json'), 'utf8'));
    await mkdir(join(cwd, '.claude'), { recursive: true });
    await writeFile(join(cwd, '.claude', 'forge.json'), JSON.stringify(committed), 'utf8');
    await writeFile(join(cwd, '.gitignore'), '.forge/\n', 'utf8');

    const liveFields = Object.entries(committed.board.fields).map(([key, f]) => ({
      id: f.id,
      name: key[0].toUpperCase() + key.slice(1), // 'type' -> 'Type', the grandfathered legacy name
      options: Object.entries(f.options).map(([n, id]) => ({ id, name: n })),
    }));
    const { gh } = fakeGh([
      ['auth status', AUTH_OK],
      ['repo view', REPO_VIEW],
      [(j) => j.includes('fields(first: 50)'), fieldsResponse(14, liveFields)],
      ['issue view 15', { stdout: JSON.stringify({ state: 'OPEN' }) }],
      [() => true, { ok: false, stderr: '404' }],
    ]);
    const res = await runDoctor({ gh, cwd, log: noop });
    const kind = byName(res, 'kind-field')[0];
    expect(kind.level).toBe('ok');
    expect(kind.msg).toContain('Type');
    expect(res.results.filter((r) => r.level === 'fail').map((r) => r.name)).not.toContain('kind-field');
  });

  it('missing .forge/ gitignore entry is a ✗', async () => {
    const { gh } = fakeGh([['auth status', AUTH_OK], ['repo view', REPO_VIEW], [() => true, { ok: false, stderr: 'x' }]]);
    const res = await runDoctor({ gh, cwd: await tmpCwd(), log: noop });
    expect(byName(res, 'gitignore')[0]).toMatchObject({ level: 'fail' });
  });

  it('branch protection / secret scanning absent are ⚠ not ✗', async () => {
    const cwd = await tmpCwd();
    await writeFile(join(cwd, '.gitignore'), '.forge/\n', 'utf8');
    const { gh } = fakeGh([
      ['auth status', AUTH_OK],
      ['repo view', REPO_VIEW],
      [(j) => j.startsWith('api repos/') && j.includes('/protection'), { ok: false, stderr: '404' }],
      [(j) => j.startsWith('api repos/'), { stdout: JSON.stringify({ security_and_analysis: { secret_scanning: { status: 'disabled' } } }) }],
      [() => true, { ok: false, stderr: 'x' }],
    ]);
    const res = await runDoctor({ gh, cwd, log: noop });
    expect(byName(res, 'branch-protection')[0].level).toBe('warn');
    expect(byName(res, 'secret-scanning')[0].level).toBe('warn');
  });

  it('AC-89.2: private repo without secret scanning available → skip (n/a), not warn', async () => {
    const cwd = await tmpCwd();
    await writeFile(join(cwd, '.gitignore'), '.forge/\n', 'utf8');
    const { gh } = fakeGh([
      ['auth status', AUTH_OK],
      ['repo view', REPO_VIEW],
      [(j) => j.startsWith('api repos/') && j.includes('/protection'), { ok: false, stderr: '404' }],
      // private repo, no secret_scanning offered (free plan, no GHAS)
      [(j) => j.startsWith('api repos/'), { stdout: JSON.stringify({ private: true, security_and_analysis: {} }) }],
      [() => true, { ok: false, stderr: 'x' }],
    ]);
    const res = await runDoctor({ gh, cwd, log: noop });
    const ss = byName(res, 'secret-scanning')[0];
    expect(ss.level).toBe('skip');
    expect(ss.msg).toMatch(/n\/a on this plan/);
    // skip is never a failure — secret-scanning must not appear among failed checks
    expect(res.results.filter((r) => r.level === 'fail').map((r) => r.name)).not.toContain('secret-scanning');
  });
});

describe('runDoctor — graph availability notice (#386)', () => {
  const routes = [['auth status', AUTH_OK], ['repo view', REPO_VIEW], [() => true, { ok: false, stderr: 'x' }]];

  /** Write a valid forge.json with a `features` block override (undefined = omit it entirely). */
  async function writeCfgFeatures(cwd, features) {
    const committed = JSON.parse(await readFile(join(process.cwd(), '.claude', 'forge.json'), 'utf8'));
    delete committed.runner; // keep runner checks silent/out of scope for these tests
    if (features !== undefined) committed.features = features;
    else delete committed.features;
    await mkdir(join(cwd, '.claude'), { recursive: true });
    await writeFile(join(cwd, '.claude', 'forge.json'), JSON.stringify(committed), 'utf8');
  }

  it('AC.1: tsconfig.json present + features.graph:false → advisory warn naming the 3-step enable sequence', async () => {
    const cwd = await gitRepo({ files: { 'tsconfig.json': '{}' } });
    await writeCfgFeatures(cwd, { graph: false });
    const { gh } = fakeGh(routes);
    const res = await runDoctor({ gh, cwd, log: noop });
    const r = byName(res, 'graph-availability')[0];
    expect(r.level).toBe('warn');
    expect(r.msg).toMatch(/tsconfig/i);
    expect(r.hint).toMatch(/features\.graph:\s*true/);
    expect(r.hint).toMatch(/ts-morph/);
    expect(r.hint).toMatch(/graphctl\.mjs rebuild/);
    // advisory only — never flips doctor to failing
    expect(res.results.filter((x) => x.level === 'fail').map((x) => x.name)).not.toContain('graph-availability');
  });

  it('never configured (no features block at all, e.g. an adopted repo) is treated the same as off', async () => {
    const cwd = await gitRepo({ files: { 'tsconfig.json': '{}' } });
    await writeCfgFeatures(cwd, undefined); // no features block
    const { gh } = fakeGh(routes);
    const res = await runDoctor({ gh, cwd, log: noop });
    expect(byName(res, 'graph-availability')[0].level).toBe('warn');
  });

  it('AC.2: features.graph already true → no advisory (the existing "graph" check owns that state)', async () => {
    const cwd = await gitRepo({ files: { 'tsconfig.json': '{}' } });
    await writeCfgFeatures(cwd, { graph: true });
    const { gh } = fakeGh(routes);
    const res = await runDoctor({ gh, cwd, log: noop });
    expect(byName(res, 'graph-availability')).toEqual([]);
  });

  it('AC.2: no tsconfig.json (non-TS repo) → no advisory even with graph off', async () => {
    const cwd = await gitRepo();
    await writeCfgFeatures(cwd, { graph: false });
    const { gh } = fakeGh(routes);
    const res = await runDoctor({ gh, cwd, log: noop });
    expect(byName(res, 'graph-availability')).toEqual([]);
  });

  it('AC.2: .forge/graph.db already built → no advisory (deliberately turned off after trying, don\'t nag)', async () => {
    const cwd = await gitRepo({ files: { 'tsconfig.json': '{}', '.forge/graph.db': '' } });
    await writeCfgFeatures(cwd, { graph: false });
    const { gh } = fakeGh(routes);
    const res = await runDoctor({ gh, cwd, log: noop });
    expect(byName(res, 'graph-availability')).toEqual([]);
  });

  it('AC.3: read-only — running doctor never mutates forge.json', async () => {
    const cwd = await gitRepo({ files: { 'tsconfig.json': '{}' } });
    await writeCfgFeatures(cwd, { graph: false });
    const before = await readFile(join(cwd, '.claude', 'forge.json'), 'utf8');
    const { gh } = fakeGh(routes);
    await runDoctor({ gh, cwd, log: noop });
    const after = await readFile(join(cwd, '.claude', 'forge.json'), 'utf8');
    expect(after).toBe(before);
  });
});

describe('runDoctor — agy adapter health (#431 AC.1/AC.2/AC.4/AC.5)', () => {
  const routes = [['auth status', AUTH_OK], ['repo view', REPO_VIEW], [() => true, { ok: false, stderr: 'x' }]];
  const okExec = async () => ({ ok: true, stdout: 'agy 1.1.7', stderr: '', code: 0 });
  const missingExec = async () => ({ ok: false, stdout: '', stderr: 'ENOENT', code: -1 });

  /** Write a valid forge.json with a `features` block override (undefined = omit it entirely). */
  async function writeCfgAgy(cwd, features) {
    const committed = JSON.parse(await readFile(join(process.cwd(), '.claude', 'forge.json'), 'utf8'));
    delete committed.runner; // keep runner checks out of scope for these tests
    if (features !== undefined) committed.features = features;
    else delete committed.features;
    await mkdir(join(cwd, '.claude'), { recursive: true });
    await writeFile(join(cwd, '.claude', 'forge.json'), JSON.stringify(committed), 'utf8');
  }

  it('AC-431.5 negative case: no emitted agy package, features.agy off → zero agy-* rows anywhere in the report', async () => {
    const cwd = await gitRepo();
    await writeCfgAgy(cwd, undefined);
    const { gh } = fakeGh(routes);
    const res = await runDoctor({ gh, cwd, log: noop, exec: missingExec });
    expect(res.results.filter((r) => r.name.startsWith('agy'))).toEqual([]);
  });

  it('AC-431.1: an emitted package present, agy on PATH → agy-cli/agy-package/agy-rewrite all ok', async () => {
    const cwd = await gitRepo();
    await writeCfgAgy(cwd, undefined);
    await emitAgyPlugin({ destRoot: join(cwd, '.agents', 'plugins', 'forge'), log: noop });
    const { gh } = fakeGh(routes);
    const res = await runDoctor({ gh, cwd, log: noop, exec: okExec });
    expect(byName(res, 'agy-cli')[0].level).toBe('ok');
    expect(byName(res, 'agy-package')[0].level).toBe('ok');
    expect(byName(res, 'agy-rewrite')[0].level).toBe('ok');
  });

  it('an emitted package present, agy NOT on PATH → agy-cli warns (never fails doctor outright)', async () => {
    const cwd = await gitRepo();
    await writeCfgAgy(cwd, undefined);
    await emitAgyPlugin({ destRoot: join(cwd, '.agents', 'plugins', 'forge'), log: noop });
    const { gh } = fakeGh(routes);
    const res = await runDoctor({ gh, cwd, log: noop, exec: missingExec });
    expect(byName(res, 'agy-cli')[0].level).toBe('warn');
    expect(res.results.filter((r) => r.level === 'fail').map((r) => r.name)).not.toContain('agy-cli');
  });

  it('AC-431.4: features.agy on, no package emitted → ONLY agy-offload fires; the adapter block stays silent (decoupled gating)', async () => {
    const cwd = await gitRepo();
    await writeCfgAgy(cwd, { agy: true });
    const { gh } = fakeGh(routes);
    const res = await runDoctor({ gh, cwd, log: noop, exec: missingExec });
    expect(byName(res, 'agy-offload')[0].level).toBe('warn');
    expect(byName(res, 'agy-cli')).toEqual([]);
    expect(byName(res, 'agy-package')).toEqual([]);
  });

  it('features.agy off, package emitted → agy-offload absent, adapter block still runs', async () => {
    const cwd = await gitRepo();
    await writeCfgAgy(cwd, undefined);
    await emitAgyPlugin({ destRoot: join(cwd, '.agents', 'plugins', 'forge'), log: noop });
    const { gh } = fakeGh(routes);
    const res = await runDoctor({ gh, cwd, log: noop, exec: okExec });
    expect(byName(res, 'agy-offload')).toEqual([]);
    expect(byName(res, 'agy-cli')[0].level).toBe('ok');
  });

  it('AC-431.2: BREAK IT: a stale emitted package (old version) → agy-staleness warns without failing doctor', async () => {
    const cwd = await gitRepo();
    await writeCfgAgy(cwd, undefined);
    const pkgDir = join(cwd, '.agents', 'plugins', 'forge');
    await emitAgyPlugin({ destRoot: pkgDir, log: noop });
    const markerPath = join(pkgDir, 'plugin.json');
    const marker = JSON.parse(await readFile(markerPath, 'utf8'));
    marker.version = '0.0.1';
    await writeFile(markerPath, JSON.stringify(marker), 'utf8');
    const { gh } = fakeGh(routes);
    const res = await runDoctor({ gh, cwd, log: noop, exec: okExec });
    const row = byName(res, 'agy-staleness')[0];
    expect(row.level).toBe('warn');
    expect(row.msg).toMatch(/stale/);
    expect(res.results.filter((r) => r.level === 'fail').map((r) => r.name)).not.toContain('agy-staleness');
  });
});

describe('runDoctor — denylist staleness (#447 AC.3)', () => {
  const routes = [['auth status', AUTH_OK], ['repo view', REPO_VIEW], [() => true, { ok: false, stderr: 'x' }]];

  it('AC-447.3: no working-tree plugin/hooks/denylist.mjs -> silent (plain consumer install shape, no false noise)', async () => {
    const cwd = await gitRepo();
    const { gh } = fakeGh(routes);
    const res = await runDoctor({ gh, cwd, log: noop });
    expect(byName(res, 'denylist-staleness')).toEqual([]);
  });

  it('AC-447.3: working-tree copy identical to the live (this checkout\'s own) denylist.mjs -> ok', async () => {
    const live = await readFile(join(process.cwd(), 'plugin', 'hooks', 'denylist.mjs'), 'utf8');
    const cwd = await gitRepo({ files: { 'plugin/hooks/denylist.mjs': live } });
    const { gh } = fakeGh(routes);
    const res = await runDoctor({ gh, cwd, log: noop });
    expect(byName(res, 'denylist-staleness')[0].level).toBe('ok');
  });

  it('AC-447.3: BREAK IT: working-tree copy diverges from the live denylist.mjs -> warn, never fails doctor outright', async () => {
    const live = await readFile(join(process.cwd(), 'plugin', 'hooks', 'denylist.mjs'), 'utf8');
    const cwd = await gitRepo({ files: { 'plugin/hooks/denylist.mjs': `${live}\n// hand-edited, diverged from the live copy\n` } });
    const { gh } = fakeGh(routes);
    const res = await runDoctor({ gh, cwd, log: noop });
    const row = byName(res, 'denylist-staleness')[0];
    expect(row.level).toBe('warn');
    expect(res.results.filter((r) => r.level === 'fail').map((r) => r.name)).not.toContain('denylist-staleness');
  });
});

describe('runDoctor — healthy repo shape', () => {
  it('all green (✓/⚠ only) against a fully consistent setup', async () => {
    const cwd = await tmpCwd();
    const committed = JSON.parse(await readFile(join(process.cwd(), '.claude', 'forge.json'), 'utf8'));
    committed.board.deliveryLogIssue = 15;
    delete committed.runner; // feature-off shape regardless of the live repo's runner block
    await mkdir(join(cwd, '.claude'), { recursive: true });
    await writeFile(join(cwd, '.claude', 'forge.json'), JSON.stringify(committed), 'utf8');
    await writeFile(join(cwd, '.gitignore'), '.forge/\n', 'utf8');
    // make it a git repo so the git check passes
    const { run } = await import('../plugin/scripts/lib/exec.mjs');
    await run('git', ['-C', cwd, 'init', '-q']);

    const liveFields = Object.entries(committed.board.fields).map(([key, f]) => ({
      id: f.id,
      name: key[0].toUpperCase() + key.slice(1),
      options: Object.entries(f.options).map(([n, id]) => ({ id, name: n })),
    }));
    const { gh } = fakeGh([
      ['auth status', AUTH_OK],
      ['repo view', REPO_VIEW],
      [(j) => j.includes('fields(first: 50)'), fieldsResponse(14, liveFields)],
      ['issue view 15', { stdout: JSON.stringify({ state: 'OPEN' }) }],
      [(j) => j.startsWith('api repos/') && j.includes('/protection'), { stdout: '{}' }],
      [(j) => j.startsWith('api repos/'), { stdout: JSON.stringify({ security_and_analysis: { secret_scanning: { status: 'enabled' } } }) }],
    ]);
    const res = await runDoctor({ gh, cwd, log: noop });
    expect(res.results.filter((r) => r.level === 'fail')).toEqual([]);
    expect(res.ok).toBe(true);
  });
});
