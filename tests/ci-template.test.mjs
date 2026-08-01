import { describe, it, expect } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInit, parseArgs } from '../plugin/scripts/init.mjs';
import { runLicenseGate } from '../plugin/scripts/gates/license.mjs';
import { fakeGh, fieldsResponse, REPO_VIEW, AUTH_OK } from './helpers/fakegh.mjs';

const noop = () => {};
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const FULL_FIELDS = [
  { id: 'PVTSSF_1', name: 'Status', options: [
    { id: 's1', name: 'Backlog' }, { id: 's2', name: 'Ready' }, { id: 's3', name: 'In progress' },
    { id: 's4', name: 'In review' }, { id: 's5', name: 'Blocked / Needs decision' }, { id: 's6', name: 'Done' }] },
  { id: 'PVTSSF_2', name: 'Priority', options: [{ id: 'p1', name: 'P0' }] },
  { id: 'PVTSSF_3', name: 'Size', options: [{ id: 'z1', name: 'S' }] },
  { id: 'PVTSSF_4', name: 'Type', options: [{ id: 't1', name: 'Epic' }] },
];

function routes() {
  return [
    ['auth status', AUTH_OK],
    ['repo view', REPO_VIEW],
    ['project view 9', { stdout: JSON.stringify({ id: 'PVT_x', number: 9, title: 'x' }) }],
    [(j) => j.includes('fields(first: 50)'), fieldsResponse(1, FULL_FIELDS)],
    ['issue list', { stdout: JSON.stringify([{ number: 15, title: 'Delivery log', state: 'OPEN' }]) }],
  ];
}

describe('consumer CI template (AC-3.5)', () => {
  it('init installs verify.yml with the configured verify command substituted', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'forge-ci-'));
    const { gh } = fakeGh(routes());
    const res = await runInit({ gh, cwd, log: noop, args: parseArgs(['--project', '9', '--skip-doctor']) });
    expect(res.ok).toBe(true);
    const wf = await readFile(join(cwd, '.github', 'workflows', 'verify.yml'), 'utf8');
    expect(wf).toContain('run: pnpm verify');
    expect(wf).not.toContain('{{VERIFY}}');
    expect(wf).toContain('gitleaks/gitleaks-action@ff98106e4c7b2bc287b24eaf42907196329070c7');
    // #103: gitleaks job must grant pull-requests: read or it 403s on the first PR
    expect(wf).toMatch(/gitleaks:[\s\S]*?permissions:[\s\S]*?pull-requests: read/);
  });

  it('init respects an existing verify workflow (no overwrite, any filename)', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'forge-ci-'));
    await mkdir(join(cwd, '.github', 'workflows'), { recursive: true });
    await writeFile(join(cwd, '.github', 'workflows', 'ci.yml'), 'name: verify\non: push\n', 'utf8');
    const { gh } = fakeGh(routes());
    const res = await runInit({ gh, cwd, log: noop, args: parseArgs(['--project', '9', '--skip-doctor']) });
    expect(res.ok).toBe(true);
    const files = await readdir(join(cwd, '.github', 'workflows'));
    expect(files).toEqual(['ci.yml']);
  });

  it('init uses the consumer verify command from an adopted config', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'forge-ci-'));
    await mkdir(join(cwd, '.claude'), { recursive: true });
    await writeFile(join(cwd, '.claude', 'forge.json'), JSON.stringify({
      board: { projectNumber: 9, projectId: 'PVT_x', fields: {
        status: { id: 'PVTSSF_1', options: { backlog: 's1' } },
        priority: { id: 'PVTSSF_2', options: { p0: 'p1' } },
        size: { id: 'PVTSSF_3', options: { s: 'z1' } },
        type: { id: 'PVTSSF_4', options: { epic: 't1' } },
      }, deliveryLogIssue: 15 },
      conventions: { verify: 'npm run check' },
      team: { members: [{ github: 'dngioidev', roles: ['maintainer'] }] },
    }), 'utf8');
    const { gh } = fakeGh(routes());
    const res = await runInit({ gh, cwd, log: noop, args: parseArgs(['--skip-doctor']) });
    expect(res.ok).toBe(true);
    const wf = await readFile(join(cwd, '.github', 'workflows', 'verify.yml'), 'utf8');
    expect(wf).toContain('run: npm run check');
  });
});

// #343 — wire the enforcing license gate (#342) into CI: forge's own verify.yml
// runs the gate script directly; the consumer template ships a self-contained
// inline enforcing equivalent (the gate script is NOT vendored into consumers).
describe('license gate CI wiring (#343)', () => {
  const ALLOWLIST_IDS = ['MIT', 'ISC', 'Apache-2.0', 'BSD-2-Clause', 'BSD-3-Clause', 'BlueOak-1.0.0', '0BSD', 'Unlicense', 'CC0-1.0'];

  it('AC-343.1: forge\'s own verify.yml has a `license` job that runs the gate script on the self-hosted linux runner', async () => {
    const wf = await readFile(join(REPO_ROOT, '.github', 'workflows', 'verify.yml'), 'utf8');
    // A dedicated job keyed `license:` exists.
    expect(wf).toMatch(/^ {2}license:$/m);
    // It runs the in-repo gate script directly (the script lives in this repo).
    expect(wf).toContain('node plugin/scripts/gates/license.mjs');
    // Modelled on the other jobs: same free self-hosted linux runner + pinned actions.
    const licenseJob = wf.slice(wf.indexOf('\n  license:'));
    expect(licenseJob).toContain('runs-on: [self-hosted, linux, forge-local]');
    expect(licenseJob).toContain('actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1');
    expect(licenseJob).toContain('pnpm/action-setup@a7487c7e89a18df4991f7f222e4898a00d66ddda');
    expect(licenseJob).toContain('actions/setup-node@820762786026740c76f36085b0efc47a31fe5020');
    expect(licenseJob).toContain('pnpm install --frozen-lockfile');
  });

  it('AC-343.2: the consumer template `licenses` job is upgraded from non-enforcing to an enforcing, self-contained check', async () => {
    const tpl = await readFile(join(REPO_ROOT, 'plugin', 'templates', 'verify.yml'), 'utf8');
    // No longer merely lists licenses — the old non-enforcing terminal step is gone.
    expect(tpl).not.toMatch(/- run: pnpm licenses list --prod\s*$/m);
    // It now FAILS on a violation (fail-closed enforcement).
    expect(tpl).toContain('process.exit(1)');
    // It carries the SAME permissive allowlist the gate uses — inline & self-contained.
    for (const id of ALLOWLIST_IDS) expect(tpl).toContain(`'${id}'`);
    // Self-contained: it must NOT depend on forge's gate script being present.
    expect(tpl).not.toContain('plugin/scripts/gates/license.mjs');
    // Still drives it off `pnpm licenses list` output.
    expect(tpl).toContain("'licenses', 'list'");
  });

  it('AC-343.3: the exact gate the CI job runs FAILS (exit non-zero) on a disallowed (GPL) dependency', async () => {
    // Mirrors #342: drive the real gate with an injected fake pnpm returning a GPL
    // license. This is the same script `node plugin/scripts/gates/license.mjs` runs
    // in the AC-343.1 CI job, so a green tree + this failing fixture proves the wiring
    // is genuinely enforcing (not merely present).
    const execGpl = async () => ({ ok: true, stdout: JSON.stringify({ 'GPL-3.0-only': [{ name: 'copyleft-lib', versions: ['1'], license: 'GPL-3.0-only' }] }), stderr: '' });
    const bad = await runLicenseGate({ cwd: REPO_ROOT, execFn: execGpl, log: noop });
    expect(bad.ok).toBe(false);
    expect(bad.violations.some((v) => v.name === 'copyleft-lib')).toBe(true);

    // ...and stays GREEN on the current all-permissive tree (the CI job's happy path).
    const permissive = JSON.stringify({
      MIT: [{ name: 'vitest', versions: ['3'], license: 'MIT' }],
      'Apache-2.0': [{ name: 'ts-morph', versions: ['28'], license: 'Apache-2.0' }],
    });
    const good = await runLicenseGate({ cwd: REPO_ROOT, execFn: async () => ({ ok: true, stdout: permissive, stderr: '' }), log: noop });
    expect(good.ok).toBe(true);
    expect(good.violations).toEqual([]);
  });
});
