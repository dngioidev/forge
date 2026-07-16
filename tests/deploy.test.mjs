import { describe, it, expect } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runDeployInit, parseArgs } from '../plugin/scripts/deploy/init.mjs';
import { smoke } from '../plugin/scripts/deploy/smoke.mjs';
import { readJson } from '../plugin/scripts/lib/jsonfile.mjs';
import { runDoctor } from '../plugin/scripts/doctor.mjs';
import { fakeGh, REPO_VIEW, AUTH_OK } from './helpers/fakegh.mjs';

const noop = () => {};

const BASE_CFG = {
  board: { projectNumber: 8, projectId: 'PVT_x', fields: {
    status: { id: 'PVTSSF_1', options: { backlog: 'a' } },
    priority: { id: 'PVTSSF_2', options: { p0: 'b' } },
    size: { id: 'PVTSSF_3', options: { s: 'c' } },
    type: { id: 'PVTSSF_4', options: { epic: 'd' } },
  } },
  conventions: { verify: 'pnpm verify' },
};

async function cwdWithConfig() {
  const dir = await mkdtemp(join(tmpdir(), 'forge-deploy-'));
  await mkdir(join(dir, '.claude'), { recursive: true });
  await writeFile(join(dir, '.claude', 'forge.json'), JSON.stringify(BASE_CFG), 'utf8');
  return dir;
}

describe('deploy-init (AC-4b.1, AC-4b.2)', () => {
  it('places the full scaffold with substitutions and wires forge.json', async () => {
    const cwd = await cwdWithConfig();
    const { gh } = fakeGh([['repo view', REPO_VIEW]]);
    const res = await runDeployInit({ gh, cwd }, parseArgs(['--app', 'myapp', '--healthcheck', '/health']), noop);
    expect(res.ok).toBe(true);

    const dockerfile = await readFile(join(cwd, 'Dockerfile'), 'utf8');
    expect(dockerfile).toContain('node:22-alpine@sha256:');
    expect(dockerfile).toContain('USER app');
    expect(dockerfile).toContain('/health ');

    const staging = await readFile(join(cwd, '.github', 'workflows', 'deploy-staging.yml'), 'utf8');
    expect(staging).toContain('branches: [staging]');
    expect(staging).toContain('ghcr.io/dngioidev/myapp:sha-');
    for (const token of ['{{APP}}', '{{HEALTHCHECK}}', '{{REGISTRY}}', '{{VERIFY}}']) {
      expect(staging).not.toContain(token);
    }

    const production = await readFile(join(cwd, '.github', 'workflows', 'deploy-production.yml'), 'utf8');
    expect(production).toContain('branches: [production]');
    expect(production).toContain('docker pull'); // promote path — build only as fallback

    await stat(join(cwd, 'scripts', 'forge-smoke.mjs'));
    await stat(join(cwd, 'infra', 'envs', 'staging', 'main.tf'));
    await stat(join(cwd, 'infra', 'modules', 'observability', 'main.tf'));

    const cfg = await readJson(join(cwd, '.claude', 'forge.json'));
    expect(cfg.features.deploy).toBe(true);
    expect(cfg.deploy.environments[0]).toMatchObject({ name: 'staging', deploy: 'on-push' });
    expect(cfg.deploy.environments[1]).toMatchObject({ name: 'production', deploy: 'promote' });
    expect(cfg.conventions.verify).toBe('pnpm verify'); // untouched

    const gi = await readFile(join(cwd, '.gitignore'), 'utf8');
    expect(gi).toContain('.terraform/');
    expect(gi).toContain('*.tfstate');
  });

  it('never overwrites existing files (re-run = all kept, none placed)', async () => {
    const cwd = await cwdWithConfig();
    const { gh } = fakeGh([['repo view', REPO_VIEW]]);
    await runDeployInit({ gh, cwd }, parseArgs([]), noop);
    // user customizes their Dockerfile
    await writeFile(join(cwd, 'Dockerfile'), '# customized\n', 'utf8');
    const second = await runDeployInit({ gh, cwd }, parseArgs([]), noop);
    expect(second.ok).toBe(true);
    expect(second.placed).toEqual([]);
    expect((await readFile(join(cwd, 'Dockerfile'), 'utf8'))).toBe('# customized\n');
  });

  it('unknown stack errors with the available list', async () => {
    const cwd = await cwdWithConfig();
    const { gh } = fakeGh([['repo view', REPO_VIEW]]);
    const res = await runDeployInit({ gh, cwd }, parseArgs(['--stack', 'rust']), noop);
    expect(res.ok).toBe(false);
    expect(res.error).toContain('node');
  });
});

describe('smoke (AC-4b.4)', () => {
  it('healthy on first 200', async () => {
    const res = await smoke({ url: 'http://x/healthz', retries: 3, timeout: 5000, sleepMs: 1, log: noop, fetchFn: async () => ({ ok: true, status: 200 }) });
    expect(res).toMatchObject({ code: 0, attempts: 1 });
  });

  it('retries through failures then succeeds', async () => {
    let n = 0;
    const res = await smoke({ url: 'http://x/healthz', retries: 5, timeout: 5000, sleepMs: 1, log: noop, fetchFn: async () => (++n < 3 ? { ok: false, status: 503 } : { ok: true, status: 200 }) });
    expect(res).toMatchObject({ code: 0, attempts: 3 });
  });

  it('exit 1 when never healthy; exit 2 on bad args', async () => {
    const res = await smoke({ url: 'http://x/healthz', retries: 2, timeout: 1000, sleepMs: 1, log: noop, fetchFn: async () => { throw new Error('ECONNREFUSED'); } });
    expect(res.code).toBe(1);
    expect((await smoke({ url: 'not-a-url', retries: 2, timeout: 1000, log: noop })).code).toBe(2);
  });
});

describe('doctor deploy checks (AC-4b.5)', () => {
  it('warns with the missing list when features.deploy is on but files absent', async () => {
    const cwd = await cwdWithConfig();
    const cfg = { ...BASE_CFG, features: { deploy: true } };
    await writeFile(join(cwd, '.claude', 'forge.json'), JSON.stringify(cfg), 'utf8');
    await writeFile(join(cwd, '.gitignore'), '.forge/\n', 'utf8');
    const { gh } = fakeGh([['auth status', AUTH_OK], ['repo view', REPO_VIEW], [() => true, { ok: false, stderr: 'x' }]]);
    const res = await runDoctor({ gh, cwd, log: noop });
    const dep = res.results.find((r) => r.name === 'deploy');
    expect(dep.level).toBe('warn');
    expect(dep.msg).toContain('Dockerfile');
    expect(dep.hint).toContain('deploy-init');
  });

  it('ok after deploy-init has run', async () => {
    const cwd = await cwdWithConfig();
    const { gh } = fakeGh([['repo view', REPO_VIEW]]);
    await runDeployInit({ gh, cwd }, parseArgs([]), noop);
    await writeFile(join(cwd, '.gitignore'), (await readFile(join(cwd, '.gitignore'), 'utf8')) + '.forge/\n', 'utf8');
    const d = fakeGh([['auth status', AUTH_OK], ['repo view', REPO_VIEW], [() => true, { ok: false, stderr: 'x' }]]);
    const res = await runDoctor({ gh: d.gh, cwd, log: noop });
    const dep = res.results.find((r) => r.name === 'deploy');
    expect(dep.level).toBe('ok');
  });
});
