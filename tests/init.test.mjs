import { describe, it, expect } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInit, parseArgs } from '../plugin/scripts/init.mjs';
import { readJson } from '../plugin/scripts/lib/jsonfile.mjs';
import { fakeGh, fieldsResponse, REPO_VIEW, AUTH_OK } from './helpers/fakegh.mjs';

const noop = () => {};

// Live board #8 shapes (mirrors the committed .claude/forge.json)
const BOARD8 = {
  projectId: 'PVT_kwHOCkJQ784BdZrh',
  fields: [
    { id: 'PVTSSF_lAHOCkJQ784BdZrhzhX7emI', name: 'Status', options: [
      { id: '04db063a', name: 'Backlog' }, { id: '29224f44', name: 'In progress' }, { id: '7d8a60b9', name: 'Done' }] },
    { id: 'PVTSSF_lAHOCkJQ784BdZrhzhX7esI', name: 'Priority', options: [
      { id: '66c7f4b7', name: 'P0' }, { id: '23a624d0', name: 'P1' }, { id: 'd9b45a49', name: 'P2' }] },
    { id: 'PVTSSF_lAHOCkJQ784BdZrhzhX7esU', name: 'Size', options: [
      { id: 'd2a09967', name: 'XS' }, { id: '0a97017a', name: 'S' }, { id: '88715f78', name: 'M' }, { id: 'e0e2c48d', name: 'L' }, { id: 'ec65bb19', name: 'XL' }] },
    { id: 'PVTSSF_lAHOCkJQ784BdZrhzhX7euY', name: 'Type', options: [
      { id: 'cc17fc25', name: 'Epic' }, { id: '54a8e89d', name: 'Item' }, { id: '8b7b608b', name: 'Bug' }, { id: 'd572a031', name: 'Test' }] },
  ],
};

const FRESH_FULL_FIELDS = [
  { id: 'PVTSSF_new1', name: 'Status', options: [
    { id: 's1', name: 'Backlog' }, { id: 's2', name: 'Ready' }, { id: 's3', name: 'In progress' },
    { id: 's4', name: 'In review' }, { id: 's5', name: 'Blocked / Needs decision' }, { id: 's6', name: 'Done' }] },
  { id: 'PVTSSF_new2', name: 'Priority', options: [{ id: 'p1', name: 'P0' }, { id: 'p2', name: 'P1' }, { id: 'p3', name: 'P2' }] },
  { id: 'PVTSSF_new3', name: 'Size', options: [{ id: 'z1', name: 'XS' }, { id: 'z2', name: 'S' }] },
  { id: 'PVTSSF_new4', name: 'Type', options: [{ id: 't1', name: 'Epic' }, { id: 't2', name: 'Item' }] },
];

async function tmpCwd() {
  return mkdtemp(join(tmpdir(), 'forge-init-'));
}

describe('parseArgs', () => {
  it('parses project, create-project, statusline', () => {
    expect(parseArgs(['--project', '8', '--statusline'])).toMatchObject({ project: 8, statusline: true });
    expect(parseArgs(['--create-project', 'my board'])).toMatchObject({ createProject: 'my board' });
  });
});

describe('runInit — fresh bootstrap (AC-1.2)', () => {
  function freshRoutes() {
    let fieldsCall = 0;
    return [
      ['auth status', AUTH_OK],
      ['repo view', REPO_VIEW],
      ['project create', { stdout: JSON.stringify({ id: 'PVT_new', number: 9, title: 'forge' }) }],
      [(j) => j.startsWith('api graphql') && j.includes('fields(first: 50)'), () => {
        fieldsCall += 1;
        // first discovery: built-in status only, empty project; re-discovery: full set
        return fieldsCall === 1
          ? fieldsResponse(0, [{ id: 'PVTSSF_new1', name: 'Status', options: [{ id: 'a', name: 'Todo' }, { id: 'b', name: 'In Progress' }, { id: 'c', name: 'Done' }] }])
          : fieldsResponse(0, FRESH_FULL_FIELDS);
      }],
      [(j) => j.includes('updateProjectV2Field'), { stdout: JSON.stringify({ data: { updateProjectV2Field: { projectV2Field: { id: 'PVTSSF_new1', options: [] } } } }) }],
      [(j) => j.includes('createProjectV2Field'), { stdout: JSON.stringify({ data: { createProjectV2Field: { projectV2Field: { id: 'PVTSSF_x', options: [] } } } }) }],
      ['issue list', { stdout: '[]' }],
      ['issue create', { stdout: 'https://github.com/dngioidev/forge/issues/42\n' }],
    ];
  }

  it('creates project, standard fields, delivery log, forge.json, gitignore', async () => {
    const cwd = await tmpCwd();
    const { gh, calls } = fakeGh(freshRoutes());
    const res = await runInit({ gh, cwd, log: noop, args: parseArgs(['--create-project', 'forge', '--skip-doctor']) });
    expect(res.ok).toBe(true);

    // status replaced (empty project, ADR-0001) and 3 custom fields created
    expect(calls.some((c) => c.includes('updateProjectV2Field'))).toBe(true);
    expect(calls.filter((c) => c.includes('createProjectV2Field')).length).toBe(3);

    const cfg = await readJson(join(cwd, '.claude', 'forge.json'));
    expect(cfg.board.projectNumber).toBe(9);
    expect(cfg.board.deliveryLogIssue).toBe(42);
    expect(cfg.board.fields.status.options).toMatchObject({ backlog: 's1', ready: 's2', inProgress: 's3', inReview: 's4', blocked: 's5', done: 's6' });
    expect(cfg.team.members[0]).toMatchObject({ github: 'dngioidev', roles: ['maintainer'] });
    expect(cfg.features).toMatchObject({ graph: false, deploy: false });

    const gi = await readFile(join(cwd, '.gitignore'), 'utf8');
    expect(gi).toContain('.forge/');
  });

  it('AC-1.2: re-run is a no-op — no create/update mutations fire', async () => {
    const cwd = await tmpCwd();
    // first run
    const first = fakeGh(freshRoutes());
    await runInit({ gh: first.gh, cwd, log: noop, args: parseArgs(['--create-project', 'forge', '--skip-doctor']) });

    // second run: project now discovered by number from config; fields complete
    const second = fakeGh([
      ['auth status', AUTH_OK],
      ['repo view', REPO_VIEW],
      ['project view 9', { stdout: JSON.stringify({ id: 'PVT_new', number: 9, title: 'forge' }) }],
      [(j) => j.includes('fields(first: 50)'), fieldsResponse(3, FRESH_FULL_FIELDS)],
    ]);
    const res = await runInit({ gh: second.gh, cwd, log: noop, args: parseArgs(['--skip-doctor']) });
    expect(res.ok).toBe(true);
    expect(second.calls.some((c) => c.includes('createProjectV2Field'))).toBe(false);
    expect(second.calls.some((c) => c.includes('updateProjectV2Field'))).toBe(false);
    expect(second.calls.some((c) => c.startsWith('issue create'))).toBe(false);

    const gi = await readFile(join(cwd, '.gitignore'), 'utf8');
    expect(gi.match(/\.forge\//g).length).toBe(1); // appended exactly once
  });

  it('resumes after partial failure: only missing fields get created', async () => {
    const cwd = await tmpCwd();
    const partial = [
      { id: 'PVTSSF_new1', name: 'Status', options: FRESH_FULL_FIELDS[0].options },
      FRESH_FULL_FIELDS[1], // priority already exists from the failed run
    ];
    const { gh, calls } = fakeGh([
      ['auth status', AUTH_OK],
      ['repo view', REPO_VIEW],
      ['project view 9', { stdout: JSON.stringify({ id: 'PVT_new', number: 9, title: 'forge' }) }],
      [(j) => j.includes('fields(first: 50)'), (() => {
        let n = 0;
        return () => { n += 1; return n === 1 ? fieldsResponse(0, partial) : fieldsResponse(0, FRESH_FULL_FIELDS); };
      })()],
      [(j) => j.includes('createProjectV2Field'), { stdout: JSON.stringify({ data: { createProjectV2Field: { projectV2Field: { id: 'x', options: [] } } } }) }],
      ['issue list', { stdout: '[]' }],
      ['issue create', { stdout: 'https://github.com/dngioidev/forge/issues/7\n' }],
    ]);
    const res = await runInit({ gh, cwd, log: noop, args: parseArgs(['--project', '9', '--skip-doctor']) });
    expect(res.ok).toBe(true);
    const creates = calls.filter((c) => c.includes('createProjectV2Field'));
    expect(creates.length).toBe(2); // size + type only — priority not recreated
  });
});

describe('runInit — adopt mode (AC-1.3)', () => {
  it('discovers board #8 into a board block identical to the committed forge.json', async () => {
    const cwd = await tmpCwd();
    // seed the committed config (without deliveryLogIssue, as committed today)
    const committed = JSON.parse(await readFile(join(process.cwd(), '.claude', 'forge.json'), 'utf8'));
    await mkdir(join(cwd, '.claude'), { recursive: true });
    await writeFile(join(cwd, '.claude', 'forge.json'), JSON.stringify(committed, null, 2), 'utf8');

    const { gh, calls } = fakeGh([
      ['auth status', AUTH_OK],
      ['repo view', REPO_VIEW],
      ['project view 8', { stdout: JSON.stringify({ id: BOARD8.projectId, number: 8, title: 'forge - AI dev platform' }) }],
      [(j) => j.includes('fields(first: 50)'), fieldsResponse(14, BOARD8.fields)],
      ['issue list', { stdout: '[]' }],
      ['issue create', { stdout: 'https://github.com/dngioidev/forge/issues/15\n' }],
    ]);
    const res = await runInit({ gh, cwd, log: noop, args: parseArgs(['--skip-doctor']) });
    expect(res.ok).toBe(true);

    // live board has items -> status options must NOT be replaced (ADR-0001)
    expect(calls.some((c) => c.includes('updateProjectV2Field'))).toBe(false);

    const cfg = await readJson(join(cwd, '.claude', 'forge.json'));
    expect(cfg.board.projectNumber).toBe(committed.board.projectNumber);
    expect(cfg.board.projectId).toBe(committed.board.projectId);
    expect(cfg.board.fields).toEqual(committed.board.fields); // AC-1.3 exact match
    expect(cfg.board.deliveryLogIssue).toBe(15);
    // adopt never clobbers existing consumer config
    expect(cfg.conventions).toEqual(committed.conventions);
  });
});

describe('runInit — failure modes', () => {
  it('fails with a clear message when gh is unauthenticated', async () => {
    const cwd = await tmpCwd();
    const { gh } = fakeGh([['auth status', { ok: false, stderr: 'not logged in' }]]);
    const res = await runInit({ gh, cwd, log: noop, args: parseArgs([]) });
    expect(res.ok).toBe(false);
    expect(res.error).toContain('gh auth login');
  });

  it('fails when neither --project nor --create-project resolves', async () => {
    const cwd = await tmpCwd();
    const { gh } = fakeGh([
      ['auth status', AUTH_OK],
      ['repo view', REPO_VIEW],
    ]);
    const res = await runInit({ gh, cwd, log: noop, args: parseArgs(['--skip-doctor']) });
    expect(res.ok).toBe(false);
    expect(res.error).toContain('--project');
  });
});
