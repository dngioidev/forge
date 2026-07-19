import { describe, it, expect } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runDoctor } from '../plugin/scripts/doctor.mjs';
import { fakeGh, fieldsResponse, REPO_VIEW, AUTH_OK } from './helpers/fakegh.mjs';

const noop = () => {};
const byName = (res, name) => res.results.filter((r) => r.name === name);

async function tmpCwd() {
  return mkdtemp(join(tmpdir(), 'forge-doc-'));
}

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
