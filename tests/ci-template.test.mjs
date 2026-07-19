import { describe, it, expect } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInit, parseArgs } from '../plugin/scripts/init.mjs';
import { fakeGh, fieldsResponse, REPO_VIEW, AUTH_OK } from './helpers/fakegh.mjs';

const noop = () => {};

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
