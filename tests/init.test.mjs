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
      // six-status set since the #32 migration; Won't do appended in #117 (ids preserved)
      { id: '8a1e2226', name: 'Backlog' }, { id: 'e90d0eb6', name: 'Ready' }, { id: '2a209b69', name: 'In progress' },
      { id: 'a9159ac9', name: 'In review' }, { id: '5b1d391c', name: 'Blocked / Needs decision' }, { id: '7c5d9faa', name: 'Done' }, { id: '68b3526e', name: "Won't do" }] },
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
    { id: 's4', name: 'In review' }, { id: 's5', name: 'Blocked / Needs decision' }, { id: 's6', name: 'Done' }, { id: 's7', name: "Won't do" }] },
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
      ['project link', { stdout: '' }], // #64: fresh create links the board to the repo

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

    // #109: init writes a .gitattributes normalizing line endings to LF
    const ga = await readFile(join(cwd, '.gitattributes'), 'utf8');
    expect(ga).toMatch(/^\* text=auto eol=lf$/m);
  });

  it('AC-114.5: maps an optional Phase field into forge.json when the project has one (#114)', async () => {
    const cwd = await tmpCwd();
    const withPhase = [...FRESH_FULL_FIELDS, { id: 'PVTSSF_ph', name: 'Phase', options: [{ id: 'ph1', name: 'Alpha' }, { id: 'ph2', name: 'Beta' }] }];
    let fieldsCall = 0;
    const { gh } = fakeGh([
      ['auth status', AUTH_OK],
      ['repo view', REPO_VIEW],
      ['project create', { stdout: JSON.stringify({ id: 'PVT_new', number: 9, title: 'forge' }) }],
      ['project link', { stdout: '' }],
      [(j) => j.startsWith('api graphql') && j.includes('fields(first: 50)'), () => {
        fieldsCall += 1;
        return fieldsCall === 1
          ? fieldsResponse(0, [{ id: 'PVTSSF_new1', name: 'Status', options: [{ id: 'a', name: 'Todo' }, { id: 'b', name: 'In Progress' }, { id: 'c', name: 'Done' }] }])
          : fieldsResponse(0, withPhase);
      }],
      [(j) => j.includes('updateProjectV2Field'), { stdout: JSON.stringify({ data: { updateProjectV2Field: { projectV2Field: { id: 'PVTSSF_new1', options: [] } } } }) }],
      [(j) => j.includes('createProjectV2Field'), { stdout: JSON.stringify({ data: { createProjectV2Field: { projectV2Field: { id: 'PVTSSF_x', options: [] } } } }) }],
      ['issue list', { stdout: '[]' }],
      ['issue create', { stdout: 'https://github.com/dngioidev/forge/issues/42\n' }],
    ]);
    const res = await runInit({ gh, cwd, log: noop, args: parseArgs(['--create-project', 'forge', '--skip-doctor']) });
    expect(res.ok).toBe(true);
    const cfg = await readJson(join(cwd, '.claude', 'forge.json'));
    expect(cfg.board.fields.phase).toEqual({ id: 'PVTSSF_ph', options: { alpha: 'ph1', beta: 'ph2' } });
  });

  it('AC-146.1: maps an optional Area field into forge.json when the project has one (#146)', async () => {
    const cwd = await tmpCwd();
    const withArea = [...FRESH_FULL_FIELDS, { id: 'PVTSSF_ar', name: 'Area', options: [{ id: 'ar1', name: 'Frontend' }, { id: 'ar2', name: 'API' }] }];
    let fieldsCall = 0;
    const { gh } = fakeGh([
      ['auth status', AUTH_OK],
      ['repo view', REPO_VIEW],
      ['project create', { stdout: JSON.stringify({ id: 'PVT_new', number: 9, title: 'forge' }) }],
      ['project link', { stdout: '' }],
      [(j) => j.startsWith('api graphql') && j.includes('fields(first: 50)'), () => {
        fieldsCall += 1;
        return fieldsCall === 1
          ? fieldsResponse(0, [{ id: 'PVTSSF_new1', name: 'Status', options: [{ id: 'a', name: 'Todo' }, { id: 'b', name: 'In Progress' }, { id: 'c', name: 'Done' }] }])
          : fieldsResponse(0, withArea);
      }],
      [(j) => j.includes('updateProjectV2Field'), { stdout: JSON.stringify({ data: { updateProjectV2Field: { projectV2Field: { id: 'PVTSSF_new1', options: [] } } } }) }],
      [(j) => j.includes('createProjectV2Field'), { stdout: JSON.stringify({ data: { createProjectV2Field: { projectV2Field: { id: 'PVTSSF_x', options: [] } } } }) }],
      ['issue list', { stdout: '[]' }],
      ['issue create', { stdout: 'https://github.com/dngioidev/forge/issues/42\n' }],
    ]);
    const res = await runInit({ gh, cwd, log: noop, args: parseArgs(['--create-project', 'forge', '--skip-doctor']) });
    expect(res.ok).toBe(true);
    const cfg = await readJson(join(cwd, '.claude', 'forge.json'));
    expect(cfg.board.fields.area).toEqual({ id: 'PVTSSF_ar', options: { frontend: 'ar1', api: 'ar2' } });
  });

  it('AC-B64.2: fresh create links the new board to the repo (#64)', async () => {
    const cwd = await tmpCwd();
    const { gh, calls } = fakeGh(freshRoutes());
    const res = await runInit({ gh, cwd, log: noop, args: parseArgs(['--create-project', 'forge', '--skip-doctor']) });
    expect(res.ok).toBe(true);
    // the link call names the created number, this owner, and the owner/name slug
    const link = calls.find((c) => c.startsWith('project link'));
    expect(link).toBeTruthy();
    expect(link).toContain('project link 9');
    expect(link).toContain('--owner dngioidev');
    expect(link).toContain('--repo dngioidev/forge');
  });

  it('AC-B64.2: a link failure is a warning, not a fatal init error (#64)', async () => {
    const cwd = await tmpCwd();
    const routes = freshRoutes().map((r) => (r[0] === 'project link' ? ['project link', { ok: false, stderr: 'boom' }] : r));
    const { gh } = fakeGh(routes);
    const logs = [];
    const res = await runInit({ gh, cwd, log: (m) => logs.push(m), args: parseArgs(['--create-project', 'forge', '--skip-doctor']) });
    expect(res.ok).toBe(true); // init still succeeds
    expect(logs.join(' ')).toMatch(/could not link .* link manually/i);
    // forge.json still written despite the link warning
    expect((await readJson(join(cwd, '.claude', 'forge.json'))).board.projectNumber).toBe(9);
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
  it('discovers board #8 into a board block identical to the committed forge.json; adopt never auto-links (AC-B64.3)', async () => {
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
    // AC-B64.3: adopt mode never auto-links — the owner may track an existing board elsewhere
    expect(calls.some((c) => c.startsWith('project link'))).toBe(false);

    const cfg = await readJson(join(cwd, '.claude', 'forge.json'));
    expect(cfg.board.projectNumber).toBe(committed.board.projectNumber);
    expect(cfg.board.projectId).toBe(committed.board.projectId);
    expect(cfg.board.fields).toEqual(committed.board.fields); // AC-1.3 exact match
    expect(cfg.board.deliveryLogIssue).toBe(15);
    // adopt never clobbers existing consumer config
    expect(cfg.conventions).toEqual(committed.conventions);
  });
});

describe('runInit — statusline wiring (#181)', () => {
  // A fresh-bootstrap route set (mirrors the fresh-bootstrap describe) so runInit
  // reaches the statusline step and writes .claude/settings.local.json.
  function bootstrapRoutes() {
    let fieldsCall = 0;
    return [
      ['auth status', AUTH_OK],
      ['repo view', REPO_VIEW],
      ['project create', { stdout: JSON.stringify({ id: 'PVT_new', number: 9, title: 'forge' }) }],
      ['project link', { stdout: '' }],
      [(j) => j.startsWith('api graphql') && j.includes('fields(first: 50)'), () => {
        fieldsCall += 1;
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

  // AC-1 / AC-4: the wired statusLine.command embeds the absolute node binary
  // (process.execPath), never a bare `node`, and both paths are quoted so a
  // space in the path (e.g. C:\Program Files\nodejs\node.exe) survives.
  it('AC-181.1/AC-181.4: wires the absolute process.execPath, quoted, not a bare `node`', async () => {
    const cwd = await tmpCwd();
    const { gh } = fakeGh(bootstrapRoutes());
    const res = await runInit({ gh, cwd, log: noop, args: parseArgs(['--create-project', 'forge', '--statusline', '--skip-doctor']) });
    expect(res.ok).toBe(true);

    const settings = await readJson(join(cwd, '.claude', 'settings.local.json'));
    const cmd = settings.statusLine.command;
    expect(settings.statusLine.type).toBe('command');
    // AC-1: the absolute node binary currently running the test is embedded.
    expect(cmd).toContain(process.execPath);
    // AC-2 (unit-checkable slice): it is NOT a bare `node` invocation — that is
    // exactly the wiring that renders blank when node is off the spawned PATH.
    expect(cmd).not.toMatch(/^node\s/);
    // AC-4: the node binary is quoted, so a space in the path cannot split the arg.
    expect(cmd).toContain(`"${process.execPath}"`);
    // the script argument is also quoted.
    expect(cmd).toMatch(/"[^"]*statusline\.mjs"$/);
  });

  // AC-3: re-running --statusline heals a pre-existing bare-`node` wiring — the
  // statusLine.command key is idempotently overwritten with the absolute path.
  it('AC-181.3: re-init overwrites a stale bare-`node` command in place', async () => {
    const cwd = await tmpCwd();
    // seed a settings.local.json carrying the OLD broken bare-`node` wiring
    await mkdir(join(cwd, '.claude'), { recursive: true });
    await writeFile(
      join(cwd, '.claude', 'settings.local.json'),
      JSON.stringify({ statusLine: { type: 'command', command: 'node "C:/old/statusline.mjs"' }, other: { keep: true } }, null, 2),
      'utf8',
    );

    const { gh } = fakeGh(bootstrapRoutes());
    const res = await runInit({ gh, cwd, log: noop, args: parseArgs(['--create-project', 'forge', '--statusline', '--skip-doctor']) });
    expect(res.ok).toBe(true);

    const settings = await readJson(join(cwd, '.claude', 'settings.local.json'));
    expect(settings.statusLine.command).toContain(`"${process.execPath}"`);
    expect(settings.statusLine.command).not.toContain('node "C:/old/statusline.mjs"');
    // unrelated keys survive the merge (no-clobber rule)
    expect(settings.other).toEqual({ keep: true });
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
