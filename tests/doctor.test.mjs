import { describe, it, expect } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runDoctor } from '../plugin/scripts/doctor.mjs';
import { run } from '../plugin/scripts/lib/exec.mjs';
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

// Routes shared by the runner tests: auth ok, isPrivate view first, then generic
// repo view + a catch-all so unrelated checks (board/security) don't throw.
function runnerRoutes({ view = PRIVATE_VIEW, runners } = {}) {
  const routes = [
    ['auth status', AUTH_OK],
    [(j) => j.startsWith('repo view') && j.includes('isPrivate'), view],
    ['repo view', REPO_VIEW],
  ];
  if (runners !== undefined) routes.push([(j) => j.startsWith('api ') && j.includes('actions/runners'), runners]);
  routes.push([() => true, { ok: false, stderr: 'x' }]);
  return routes;
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

  it('label matching is case-insensitive (FORGE-LOCAL registered, forge-local configured) → ok', async () => {
    const cwd = await gitRepo({ gitignore: '.forge/\nrunner.env\n' });
    await writeCfg(cwd, { enabled: true, labels: ['self-hosted', 'linux', 'forge-local'] });
    const { gh } = fakeGh(runnerRoutes({
      runners: runnersResponse([{ id: 1, name: 'box', status: 'online', labels: [{ name: 'Self-Hosted' }, { name: 'Linux' }, { name: 'FORGE-LOCAL' }] }]),
    }));
    const res = await runDoctor({ gh, cwd, log: noop });
    expect(byName(res, 'runner')[0].level).toBe('ok');
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
