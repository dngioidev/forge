import { describe, it, expect } from 'vitest';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeBoardCtx } from '../plugin/scripts/lib/boardctx.mjs';
import { runCreate, runCreateBatch, parseArgs as createArgs } from '../plugin/scripts/board/create.mjs';
import { buildAddSubIssue, addSubIssue } from '../plugin/scripts/lib/issues.mjs';
import { runReparent, parseArgs as reparentArgs } from '../plugin/scripts/board/reparent.mjs';
import { runMove, parseArgs as moveArgs } from '../plugin/scripts/board/move.mjs';
import { runComment, parseArgs as commentArgs } from '../plugin/scripts/board/comment.mjs';
import { runClose, runCloseBatch, parseArgs as closeArgs } from '../plugin/scripts/board/close.mjs';
import { runReceipt } from '../plugin/scripts/board/receipt.mjs';
import { runLog } from '../plugin/scripts/board/log.mjs';
import { runDigest, renderChildTable, computeFlowMetrics, renderFlow, cycleDays } from '../plugin/scripts/board/digest.mjs';
import { runStatus } from '../plugin/scripts/board/status.mjs';
import { findIssueByTitle, titleSearchQuery } from '../plugin/scripts/lib/board.mjs';
import { fakeGh, REPO_VIEW } from './helpers/fakegh.mjs';

const noop = () => {};

const CFG = {
  board: {
    projectNumber: 8,
    projectId: 'PVT_test',
    fields: {
      status: { id: 'PVTSSF_s', options: { backlog: 'sb', ready: 'sr', inProgress: 'sp', inReview: 'sv', blocked: 'sk', done: 'sd', wontDo: 'sw' } },
      priority: { id: 'PVTSSF_p', options: { p0: 'a', p1: 'b', p2: 'c' } },
      size: { id: 'PVTSSF_z', options: { xs: '1', s: '2', m: '3', l: '4', xl: '5' } },
      type: { id: 'PVTSSF_t', options: { epic: 'e', item: 'i', bug: 'g', test: 't' } },
      phase: { id: 'PVTSSF_ph', options: { alpha: 'ph1', beta: 'ph2' } }, // #114 optional Phase
      area: { id: 'PVTSSF_ar', options: { frontend: 'ar1', api: 'ar2' } }, // #146 optional Area
    },
    deliveryLogIssue: 15,
  },
  team: { members: [{ github: 'dngioidev', roles: ['maintainer'] }] },
};

async function cwdWithConfig() {
  const dir = await mkdtemp(join(tmpdir(), 'forge-board-'));
  await mkdir(join(dir, '.claude'), { recursive: true });
  await writeFile(join(dir, '.claude', 'forge.json'), JSON.stringify(CFG), 'utf8');
  return dir;
}

function itemList(items) {
  return { stdout: JSON.stringify({ items }) };
}

// Stateful item-list/item-edit pair (#178/#201): item-edit updates each seeded
// item's status by the option id it sets, and a later item-list reads it back —
// so a verify-after-mutation re-read reflects what actually persisted. Seed
// entries are { id, number, status } (status is the display name).
const OPT_TO_NAME = { sb: 'Backlog', sr: 'Ready', sp: 'In progress', sv: 'In review', sk: 'Blocked / Needs decision', sd: 'Done', sw: "Won't do" };
function statefulItems(seed) {
  const state = seed.map((s) => ({ ...s }));
  return [
    [(j) => j.startsWith('project item-list'), () => itemList(state.map((s) => ({ id: s.id, content: { number: s.number }, status: s.status })))],
    [(j) => j.startsWith('project item-edit'), (j, args) => {
      const id = args[args.indexOf('--id') + 1];
      const optId = args[args.indexOf('--single-select-option-id') + 1];
      const it = state.find((s) => s.id === id);
      if (it && OPT_TO_NAME[optId]) it.status = OPT_TO_NAME[optId];
      return { stdout: '' };
    }],
  ];
}

async function ctxWith(routes) {
  const f = fakeGh([['repo view', REPO_VIEW], ...routes]);
  const ctx = await makeBoardCtx({ gh: f.gh, cwd: await cwdWithConfig() });
  expect(ctx.ok).toBe(true);
  return { ctx, calls: f.calls };
}

describe('boardctx', () => {
  it('AC-2.2: unknown option key errors with the valid keys', async () => {
    const { ctx } = await ctxWith([]);
    const r = ctx.resolveOption('status', 'doing');
    expect(r.ok).toBe(false);
    expect(r.error).toContain('backlog');
    expect(r.error).toContain('done');
  });

  it('AC-114.1: findItemByIssue falls back to the issue side when item-list lags (#114)', async () => {
    // item-list index lag: empty, but the issue is attached on the project
    const { ctx } = await ctxWith([
      [(j) => j.startsWith('project item-list'), itemList([])],
      [(j) => j.startsWith('api graphql') && j.includes('projectItems'),
        { stdout: JSON.stringify({ data: { repository: { issue: { projectItems: { nodes: [{ id: 'ITEM_X', project: { number: 8 } }] } } } } }) }],
    ]);
    expect(await ctx.findItemByIssue(5)).toMatchObject({ ok: true, item: { id: 'ITEM_X', viaFallback: true } });

    // genuinely absent → null (not on this project)
    const { ctx: ctx2 } = await ctxWith([
      [(j) => j.startsWith('project item-list'), itemList([])],
      [(j) => j.startsWith('api graphql') && j.includes('projectItems'),
        { stdout: JSON.stringify({ data: { repository: { issue: { projectItems: { nodes: [] } } } } }) }],
    ]);
    expect((await ctx2.findItemByIssue(9)).item).toBe(null);
  });

  it('AC-360.3: listItems is memoized per ctx — repeated reads hit gh once', async () => {
    const { ctx, calls } = await ctxWith([
      [(j) => j.startsWith('project item-list'), itemList([{ id: 'ITEM_1', content: { number: 7 }, status: 'Ready' }])],
    ]);
    await ctx.listItems();
    await ctx.listItems();
    await ctx.findItemByIssue(7); // also reads the list
    expect(calls.filter((c) => c.startsWith('project item-list')).length).toBe(1);
  });

  it('AC-360.3: a mutation invalidates the memo so a re-read is fresh (preserves #178)', async () => {
    let status = 'Ready';
    const { ctx, calls } = await ctxWith([
      [(j) => j.startsWith('project item-list'), () => itemList([{ id: 'ITEM_1', content: { number: 7 }, status }])],
      [(j) => j.startsWith('project item-edit'), () => { status = 'Done'; return { stdout: '' }; }],
    ]);
    expect(ctx.itemFieldKey((await ctx.listItems()).items[0], 'status')).toBe('ready');
    await ctx.setSelect('ITEM_1', 'status', 'done'); // busts the memo
    expect(ctx.itemFieldKey((await ctx.listItems()).items[0], 'status')).toBe('done'); // fresh, not stale
    expect(calls.filter((c) => c.startsWith('project item-list')).length).toBe(2);
  });

  it('AC-360.3: refresh:true forces a re-fetch', async () => {
    const { ctx, calls } = await ctxWith([
      [(j) => j.startsWith('project item-list'), itemList([{ id: 'ITEM_1', content: { number: 7 }, status: 'Ready' }])],
    ]);
    await ctx.listItems();
    await ctx.listItems({ refresh: true });
    expect(calls.filter((c) => c.startsWith('project item-list')).length).toBe(2);
  });
});

describe('create (AC-2.1)', () => {
  const createdIssueUrl = 'https://github.com/dngioidev/forge/issues/20\n';
  const issueNodes = (child, parent) => [
    [(j) => j.includes('issue(number: $number)') === false && j.includes('addSubIssue'), { stdout: JSON.stringify({ data: { addSubIssue: { issue: { number: 2 } } } }) }],
    [(j) => j.startsWith('api graphql') && j.includes('parent { number }') && j.includes('number=20'), { stdout: JSON.stringify({ data: { repository: { issue: { id: 'I_child', parent: parent ? { number: parent } : null } } } }) }],
    [(j) => j.startsWith('api graphql') && j.includes('parent { number }') && j.includes('number=2'), { stdout: JSON.stringify({ data: { repository: { issue: { id: 'I_parent', parent: null } } } }) }],
  ];

  it('full flow: issue + parent link + board add + all fields', async () => {
    const { ctx, calls } = await ctxWith([
      ['issue list', { stdout: '[]' }],
      ['issue create', { stdout: createdIssueUrl }],
      ...issueNodes('I_child', null),
      [(j) => j.startsWith('project item-list'), itemList([])],
      ['project item-add', { stdout: JSON.stringify({ id: 'ITEM_1' }) }],
      ['project item-edit', { stdout: '' }],
    ]);
    const res = await runCreate(ctx, createArgs(['--title', 'Build widget', '--parent', '2', '--type', 'item', '--priority', 'p1', '--size', 'm']), noop);
    expect(res.ok).toBe(true);
    expect(res.number).toBe(20);
    expect(calls.some((c) => c.includes('addSubIssue'))).toBe(true);
    expect(calls.filter((c) => c.startsWith('project item-edit')).length).toBe(4);
  });

  it('re-run duplicates nothing and resumes only missing steps', async () => {
    // issue exists, already parented, item on board, type+priority already set — only size+status missing
    const { ctx, calls } = await ctxWith([
      ['issue list', { stdout: JSON.stringify([{ number: 20, title: 'Build widget', url: 'https://github.com/dngioidev/forge/issues/20' }]) }],
      [(j) => j.startsWith('api graphql') && j.includes('parent { number }'), { stdout: JSON.stringify({ data: { repository: { issue: { id: 'I_child', parent: { number: 2 } } } } }) }],
      [(j) => j.startsWith('project item-list'), itemList([{ id: 'ITEM_1', content: { number: 20 }, type: 'Item', priority: 'P1', size: null, status: null }])],
      ['project item-edit', { stdout: '' }],
    ]);
    const res = await runCreate(ctx, createArgs(['--title', 'Build widget', '--parent', '2']), noop);
    expect(res.ok).toBe(true);
    expect(calls.some((c) => c.startsWith('issue create'))).toBe(false);
    expect(calls.some((c) => c.includes('addSubIssue'))).toBe(false);
    expect(calls.some((c) => c.startsWith('project item-add'))).toBe(false);
    expect(calls.filter((c) => c.startsWith('project item-edit')).length).toBe(2); // size + status only
  });

  it('validates option keys before creating anything', async () => {
    const { ctx, calls } = await ctxWith([]);
    const res = await runCreate(ctx, createArgs(['--title', 'X', '--priority', 'urgent']), noop);
    expect(res.ok).toBe(false);
    expect(res.error).toContain('valid priority keys');
    expect(calls.some((c) => c.startsWith('issue'))).toBe(false);
  });

  it('AC-104.1: unrecognized flags fail fast — never a silent empty-body ticket (#104)', async () => {
    const { ctx, calls } = await ctxWith([]);
    const res = await runCreate(ctx, createArgs(['--title', 'X', '--bogus']), noop);
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/unrecognized flag/);
    expect(res.error).toContain('--bogus');
    expect(calls.some((c) => c.startsWith('issue'))).toBe(false); // created nothing
  });

  it('AC-104.2: --body-file loads the body from a file (#104)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'forge-bodyfile-'));
    const bf = join(dir, 'body.md');
    await writeFile(bf, 'Body loaded from file, not empty.', 'utf8');
    const { ctx, calls } = await ctxWith([
      ['issue list', { stdout: '[]' }],
      ['issue create', { stdout: createdIssueUrl }],
      [(j) => j.startsWith('api graphql') && j.includes('parent { number }'), { stdout: JSON.stringify({ data: { repository: { issue: { id: 'I_c', parent: null } } } }) }],
      [(j) => j.startsWith('project item-list'), itemList([])],
      ['project item-add', { stdout: JSON.stringify({ id: 'ITEM_1' }) }],
      ['project item-edit', { stdout: '' }],
    ]);
    const res = await runCreate(ctx, createArgs(['--title', 'X', '--body-file', bf]), noop);
    expect(res.ok).toBe(true);
    expect(calls.some((c) => c.includes('Body loaded from file, not empty.'))).toBe(true);
  });

  it('AC-114.2: --phase sets the configured Phase field (#114)', async () => {
    const { ctx, calls } = await ctxWith([
      ['issue list', { stdout: '[]' }],
      ['issue create', { stdout: createdIssueUrl }],
      [(j) => j.startsWith('api graphql') && j.includes('parent { number }'), { stdout: JSON.stringify({ data: { repository: { issue: { id: 'I_c', parent: null } } } }) }],
      [(j) => j.startsWith('project item-list'), itemList([])],
      [(j) => j.startsWith('api graphql') && j.includes('projectItems'), { stdout: JSON.stringify({ data: { repository: { issue: { projectItems: { nodes: [] } } } } }) }],
      ['project item-add', { stdout: JSON.stringify({ id: 'ITEM_1' }) }],
      ['project item-edit', { stdout: '' }],
    ]);
    const res = await runCreate(ctx, createArgs(['--title', 'X', '--phase', 'alpha']), noop);
    expect(res.ok).toBe(true);
    expect(calls.some((c) => c.includes('PVTSSF_ph') && c.includes('ph1'))).toBe(true); // phase field set to alpha
  });

  it('AC-114.3: --phase without a configured Phase field errors clearly (#114)', async () => {
    const ctx = { fields: {}, resolveOption: () => ({ ok: true }) }; // no phase configured
    const res = await runCreate(ctx, createArgs(['--title', 'X', '--phase', 'alpha']), noop);
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/no Phase field is configured/);
  });

  it('AC-146.2: --area sets the configured Area field (#146)', async () => {
    const { ctx, calls } = await ctxWith([
      ['issue list', { stdout: '[]' }],
      ['issue create', { stdout: createdIssueUrl }],
      [(j) => j.startsWith('api graphql') && j.includes('parent { number }'), { stdout: JSON.stringify({ data: { repository: { issue: { id: 'I_c', parent: null } } } }) }],
      [(j) => j.startsWith('project item-list'), itemList([])],
      [(j) => j.startsWith('api graphql') && j.includes('projectItems'), { stdout: JSON.stringify({ data: { repository: { issue: { projectItems: { nodes: [] } } } } }) }],
      ['project item-add', { stdout: JSON.stringify({ id: 'ITEM_1' }) }],
      ['project item-edit', { stdout: '' }],
    ]);
    const res = await runCreate(ctx, createArgs(['--title', 'X', '--area', 'api']), noop);
    expect(res.ok).toBe(true);
    expect(calls.some((c) => c.includes('PVTSSF_ar') && c.includes('ar2'))).toBe(true); // Area set to api
  });

  it('AC-146.2: --area without a configured Area field errors clearly (#146)', async () => {
    const ctx = { fields: {}, resolveOption: () => ({ ok: true }) }; // no area configured
    const res = await runCreate(ctx, createArgs(['--title', 'X', '--area', 'api']), noop);
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/no Area field is configured/);
  });

  it('AC-146.4/5: --label (repeatable) + --milestone reconcile via one idempotent issue edit (#146)', async () => {
    const { ctx, calls } = await ctxWith([
      ['issue list', { stdout: '[]' }],
      ['issue create', { stdout: createdIssueUrl }],
      ['issue edit', { stdout: '' }],
      [(j) => j.startsWith('api graphql') && j.includes('parent { number }'), { stdout: JSON.stringify({ data: { repository: { issue: { id: 'I_c', parent: null } } } }) }],
      [(j) => j.startsWith('project item-list'), itemList([])],
      ['project item-add', { stdout: JSON.stringify({ id: 'ITEM_1' }) }],
      ['project item-edit', { stdout: '' }],
    ]);
    const res = await runCreate(ctx, createArgs(['--title', 'X', '--label', 'bug', '--label', 'p0', '--milestone', 'v1']), noop);
    expect(res.ok).toBe(true);
    const edit = calls.find((c) => c.startsWith('issue edit'));
    expect(edit).toContain('--add-label bug');
    expect(edit).toContain('--add-label p0');
    expect(edit).toContain('--milestone v1');
  });

  it('AC-146.4: a failed label/milestone edit surfaces clearly (missing label)', async () => {
    const { ctx } = await ctxWith([
      ['issue list', { stdout: '[]' }],
      ['issue create', { stdout: createdIssueUrl }],
      ['issue edit', { ok: false, stderr: "could not add label: 'ghost' not found" }],
    ]);
    const res = await runCreate(ctx, createArgs(['--title', 'X', '--label', 'ghost']), noop);
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/issue edit|not found/);
  });

  // #178 AC3: parentless follow-ups (real: #185, #192) are the board-hierarchy
  // smell — a non-epic must be a child of an epic. Warn loudly at create time.
  // Genuinely-orphaned issue: getIssueNode reports no parent → warning fires.
  const parentlessRoutes = [
    ['issue list', { stdout: '[]' }],
    ['issue create', { stdout: createdIssueUrl }],
    [(j) => j.startsWith('api graphql') && j.includes('parent { number }'), { stdout: JSON.stringify({ data: { repository: { issue: { id: 'I_child', parent: null } } } }) }],
    [(j) => j.startsWith('project item-list'), itemList([])],
    ['project item-add', { stdout: JSON.stringify({ id: 'ITEM_1' }) }],
    ['project item-edit', { stdout: '' }],
  ];

  it('AC-178.3: a non-epic with no actual parent emits a parentless warning (#178)', async () => {
    const logs = [];
    const { ctx } = await ctxWith(parentlessRoutes);
    const res = await runCreate(ctx, createArgs(['--title', 'Follow-up', '--type', 'bug']), (m) => logs.push(m));
    expect(res).toMatchObject({ ok: true, parentless: true });
    expect(logs.some((m) => /parentless/i.test(m) && /reparent/.test(m))).toBe(true);
  });

  it('AC-178.3: an epic created WITHOUT --parent does NOT warn (top-level is legitimate) (#178)', async () => {
    const logs = [];
    // epics are top-level → the parent state is never even queried
    const { ctx, calls } = await ctxWith(parentlessRoutes);
    const res = await runCreate(ctx, createArgs(['--title', 'New epic', '--type', 'epic']), (m) => logs.push(m));
    expect(res).toMatchObject({ ok: true, parentless: false });
    expect(logs.some((m) => /parentless/i.test(m))).toBe(false);
    expect(calls.some((c) => c.includes('parent { number }'))).toBe(false); // no needless lookup
  });

  it('AC-178.3: a child created WITH --parent does NOT warn (#178)', async () => {
    const logs = [];
    const { ctx } = await ctxWith([
      ['issue list', { stdout: '[]' }],
      ['issue create', { stdout: createdIssueUrl }],
      ...issueNodes('I_child', null),
      [(j) => j.startsWith('project item-list'), itemList([])],
      ['project item-add', { stdout: JSON.stringify({ id: 'ITEM_1' }) }],
      ['project item-edit', { stdout: '' }],
    ]);
    const res = await runCreate(ctx, createArgs(['--title', 'Child', '--type', 'bug', '--parent', '2']), (m) => logs.push(m));
    expect(res).toMatchObject({ ok: true, parentless: false });
    expect(logs.some((m) => /parentless/i.test(m))).toBe(false);
  });

  it('AC-178.3: a resumed create without --parent does NOT warn when the ticket is already parented (#178)', async () => {
    // reviewer catch: reconcile against the ACTUAL parent, not this call's flag —
    // a follow-up already reparented (via `board reparent`) must not re-warn.
    const logs = [];
    const { ctx } = await ctxWith([
      ['issue list', { stdout: JSON.stringify([{ number: 20, title: 'Follow-up', url: 'https://github.com/dngioidev/forge/issues/20' }]) }],
      [(j) => j.startsWith('api graphql') && j.includes('parent { number }'), { stdout: JSON.stringify({ data: { repository: { issue: { id: 'I_child', parent: { number: 2 } } } } }) }],
      [(j) => j.startsWith('project item-list'), itemList([{ id: 'ITEM_1', content: { number: 20 }, type: 'Bug', priority: 'P1', size: 'M', status: 'Backlog' }])],
      ['project item-edit', { stdout: '' }],
    ]);
    const res = await runCreate(ctx, createArgs(['--title', 'Follow-up', '--type', 'bug']), (m) => logs.push(m));
    expect(res).toMatchObject({ ok: true, parentless: false });
    expect(logs.some((m) => /parentless/i.test(m))).toBe(false);
  });
});

describe('quoted-title idempotency (AC-173, #173)', () => {
  // The exact repro from the ticket: a title carrying a literal double-quote.
  const QT = 'Remove stale "Console daemon" section from troubleshooting.md (ADR-0003)';
  const CLEANED = '"Remove stale Console daemon section from troubleshooting.md (ADR-0003)" in:title';

  // A STATEFUL gh registry so the round-trip is real: `issue create` appends to
  // `issues` and the idempotency search reads it back, so a SECOND runCreate can
  // resume. The search route returns the WHOLE registry (a superset) on purpose
  // — it proves the resume is decided by the code's exact `title ===` match, not
  // by the fragile search string.
  function statefulRoutes() {
    const issues = [];
    const items = [];
    let nextIssue = 40;
    let nextItem = 1;
    return [
      [(j) => j.startsWith('issue list'), () => ({ stdout: JSON.stringify(issues.map((i) => ({ number: i.number, title: i.title, url: i.url }))) })],
      [(j) => j.startsWith('issue create'), (j, args) => {
        const title = args[args.indexOf('--title') + 1];
        const number = nextIssue++;
        const url = `https://github.com/dngioidev/forge/issues/${number}`;
        issues.push({ number, title, url });
        return { stdout: `${url}\n` };
      }],
      [(j) => j.startsWith('api graphql') && j.includes('parent { number }'), { stdout: JSON.stringify({ data: { repository: { issue: { id: 'I_c', parent: null } } } }) }],
      [(j) => j.startsWith('project item-list'), () => ({ stdout: JSON.stringify({ items: items.slice() }) })],
      [(j) => j.startsWith('api graphql') && j.includes('projectItems'), { stdout: JSON.stringify({ data: { repository: { issue: { projectItems: { nodes: [] } } } } }) }],
      [(j) => j.startsWith('project item-add'), (j, args) => {
        const number = Number((/\/issues\/(\d+)/.exec(args[args.indexOf('--url') + 1]) ?? [])[1]);
        const id = `ITEM_${nextItem++}`;
        items.push({ id, content: { number }, type: null, priority: null, size: null, status: null });
        return { stdout: JSON.stringify({ id }) };
      }],
      ['project item-edit', { stdout: '' }],
    ];
  }

  it('AC1/AC2: creating twice from a quoted title resumes the SAME issue — no duplicate', async () => {
    const { ctx, calls } = await ctxWith(statefulRoutes());
    const flags = ['--title', QT, '--type', 'bug', '--priority', 'p2', '--size', 's'];

    const first = await runCreate(ctx, createArgs(flags), noop);
    expect(first).toMatchObject({ ok: true, number: 40, resumed: false });

    const second = await runCreate(ctx, createArgs(flags), noop);
    expect(second).toMatchObject({ ok: true, number: 40, resumed: true }); // resumed #40, not a duplicate

    // the crux: exactly one create + one board-add across BOTH runs
    expect(calls.filter((c) => c.startsWith('issue create')).length).toBe(1);
    expect(calls.filter((c) => c.startsWith('project item-add')).length).toBe(1);

    // the search reaching gh is well-formed and quote-safe — the malformed
    // `"…"Console daemon"…" in:title` form (the #173 bug) never appears
    expect(calls.some((c) => c.includes(`--search ${CLEANED}`))).toBe(true);
    expect(calls.some((c) => c.includes(`"${QT}" in:title`))).toBe(false);
  });

  it('AC2: titleSearchQuery strips embedded quotes into a coarse, well-formed phrase', () => {
    expect(titleSearchQuery(QT)).toBe(CLEANED);
    expect(titleSearchQuery('Plain title')).toBe('"Plain title" in:title'); // quote-free is unchanged
    expect(titleSearchQuery('  a   b  ')).toBe('"a b" in:title');           // whitespace collapsed
    expect(titleSearchQuery('""')).toBe('in:title');                        // degenerate → no phrase, still valid
  });

  it('AC3: findIssueByTitle (lib/board.mjs) resolves a quoted title too — same-class fix', async () => {
    let searchArg = null;
    const f = fakeGh([
      [(j) => j.startsWith('issue list'), (j, args) => {
        searchArg = args[args.indexOf('--search') + 1];
        return { stdout: JSON.stringify([{ number: 40, title: QT, state: 'OPEN' }]) };
      }],
    ]);
    const res = await findIssueByTitle(f.gh, QT);
    expect(res).toMatchObject({ ok: true, issue: { number: 40 } });
    expect(searchArg).toBe(CLEANED);
    expect(searchArg).not.toContain('"Console daemon"'); // no raw embedded quote leaked into the query
  });
});

describe('batch create --from (AC-87.1, #87)', () => {
  it('AC-87.1: creates each spec, continues past a per-entry failure, returns a summary', async () => {
    const { ctx } = await ctxWith([
      ['issue list', { stdout: '[]' }],
      ['issue create', { stdout: 'https://github.com/dngioidev/forge/issues/20\n' }],
      [(j) => j.startsWith('api graphql') && j.includes('parent { number }'), { stdout: JSON.stringify({ data: { repository: { issue: { id: 'I_c', parent: null } } } }) }],
      [(j) => j.startsWith('project item-list'), itemList([])],
      ['project item-add', { stdout: JSON.stringify({ id: 'ITEM_1' }) }],
      ['project item-edit', { stdout: '' }],
    ]);
    const res = await runCreateBatch(ctx, [
      { title: 'Alpha' },                     // valid → created
      { title: 'Beta', priority: 'urgent' },  // invalid option → fails before any gh, batch continues
    ], noop);
    expect(res).toMatchObject({ ok: false, created: 1, failed: 1 });
    expect(res.results[0]).toMatchObject({ ok: true, title: 'Alpha' });
    expect(res.results[1]).toMatchObject({ ok: false, title: 'Beta' });
  });

  it('AC-87.1: a non-array / empty file is refused', async () => {
    const { ctx } = await ctxWith([]);
    expect((await runCreateBatch(ctx, [], noop)).ok).toBe(false);
    expect((await runCreateBatch(ctx, null, noop)).ok).toBe(false);
  });
});

describe('reparent (AC-87.2, AC-87.3, #87)', () => {
  it('AC-87.2: addSubIssue carries replaceParent only when asked', async () => {
    expect(buildAddSubIssue(true)).toContain('replaceParent: true');
    expect(buildAddSubIssue(false)).not.toContain('replaceParent');
    let seen = null;
    const gh = async (a) => { seen = a; return { ok: true, json: { data: { addSubIssue: { issue: { number: 5 } } } } }; };
    await addSubIssue(gh, 'P', 'C', { replaceParent: true });
    expect(seen.find((x) => x.startsWith('query='))).toContain('replaceParent: true');
  });

  it('AC-87.3: moves a child to a new parent via replaceParent', async () => {
    const f = fakeGh([
      [(j) => j.includes('parent { number }') && j.includes('number=5'), { stdout: JSON.stringify({ data: { repository: { issue: { id: 'I5', parent: { number: 9 } } } } }) }],
      [(j) => j.includes('parent { number }') && j.includes('number=3'), { stdout: JSON.stringify({ data: { repository: { issue: { id: 'I3', parent: null } } } }) }],
      [(j) => j.includes('addSubIssue'), { stdout: JSON.stringify({ data: { addSubIssue: { issue: { number: 5 } } } }) }],
    ]);
    const res = await runReparent(f.gh, 'dngioidev', 'forge', reparentArgs(['--issue', '5', '--parent', '3']), noop);
    expect(res).toMatchObject({ ok: true, moved: true, from: 9, to: 3 });
    expect(f.calls.some((c) => c.includes('replaceParent: true'))).toBe(true);
  });

  it('AC-87.3: no-op when already under the parent; refuses missing/self args', async () => {
    const f = fakeGh([
      [(j) => j.includes('parent { number }') && j.includes('number=5'), { stdout: JSON.stringify({ data: { repository: { issue: { id: 'I5', parent: { number: 3 } } } } }) }],
    ]);
    expect(await runReparent(f.gh, 'o', 'r', reparentArgs(['--issue', '5', '--parent', '3']), noop)).toMatchObject({ ok: true, moved: false });
    expect((await runReparent(f.gh, 'o', 'r', reparentArgs(['--issue', '5']), noop)).ok).toBe(false);
    expect((await runReparent(f.gh, 'o', 'r', reparentArgs(['--issue', '5', '--parent', '5']), noop)).ok).toBe(false);
  });
});

describe('move (AC-2.2)', () => {
  // A stateful board so a re-read reflects the mutation (#178 verify-after-move):
  // item-edit updates `status` by the option id it sets, item-list reads it back.
  const OPT_TO_NAME = { sb: 'Backlog', sr: 'Ready', sp: 'In progress', sv: 'In review', sk: 'Blocked / Needs decision', sd: 'Done', sw: "Won't do" };
  function statefulItem(number, initial) {
    let status = initial;
    return [
      [(j) => j.startsWith('project item-list'), () => itemList([{ id: 'ITEM_2', content: { number }, status }])],
      [(j) => j.startsWith('project item-edit'), (j, args) => {
        const id = args[args.indexOf('--single-select-option-id') + 1];
        if (OPT_TO_NAME[id]) status = OPT_TO_NAME[id];
        return { stdout: '' };
      }],
    ];
  }

  it('moves, verifies the field actually moved, and is a no-op when already there', async () => {
    const { ctx, calls } = await ctxWith(statefulItem(5, 'In progress'));
    const moved = await runMove(ctx, moveArgs(['--issue', '5', '--status', 'done']), noop);
    expect(moved).toMatchObject({ ok: true, changed: true, verified: true });
    // now genuinely at Done → moving to done again is a no-op (no second edit)
    const same = await runMove(ctx, moveArgs(['--issue', '5', '--status', 'done']), noop);
    expect(same).toMatchObject({ ok: true, changed: false });
    expect(calls.filter((c) => c.startsWith('project item-edit')).length).toBe(1);
  });

  it('AC-178.1/AC-178.2: a silently-dropped move (re-read still shows the OLD status) fails loudly (#178)', async () => {
    // item-list ALWAYS reports the old status; item-edit "succeeds" but never persists.
    const { ctx, calls } = await ctxWith([
      [(j) => j.startsWith('project item-list'), itemList([{ id: 'ITEM_2', content: { number: 5 }, status: 'In review' }])],
      ['project item-edit', { stdout: '' }],
    ]);
    const res = await runMove(ctx, moveArgs(['--issue', '5', '--status', 'done']), noop);
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/did NOT persist/);
    expect(res.error).toContain('inReview'); // names the stuck status (resolved key)
    // it retried the mutation once before giving up (2 edits, not 1)
    expect(calls.filter((c) => c.startsWith('project item-edit')).length).toBe(2);
  });

  it('AC-178.1: an unreadable re-read (item-list lag) warns but does not false-fail (#178)', async () => {
    // First list has the item (old status) so the move fires; every later list
    // lags empty AND the issue-side fallback returns no status field → unverifiable.
    let listCalls = 0;
    const logs = [];
    const { ctx } = await ctxWith([
      [(j) => j.startsWith('project item-list'), () => itemList(listCalls++ === 0 ? [{ id: 'ITEM_2', content: { number: 5 }, status: 'In review' }] : [])],
      [(j) => j.startsWith('api graphql') && j.includes('projectItems'),
        { stdout: JSON.stringify({ data: { repository: { issue: { projectItems: { nodes: [{ id: 'ITEM_2', project: { number: 8 } }] } } } } }) }],
      ['project item-edit', { stdout: '' }],
    ]);
    const res = await runMove(ctx, moveArgs(['--issue', '5', '--status', 'done']), (m) => logs.push(m));
    expect(res).toMatchObject({ ok: true, changed: true, verified: false });
    expect(logs.some((m) => /could not confirm/.test(m))).toBe(true);
  });

  it('unknown status errors listing valid keys; off-board issue says run create', async () => {
    const { ctx } = await ctxWith([[(j) => j.startsWith('project item-list'), itemList([])]]);
    const bad = await runMove(ctx, moveArgs(['--issue', '5', '--status', 'doing']), noop);
    expect(bad.error).toContain('valid status keys');
    const missing = await runMove(ctx, moveArgs(['--issue', '5', '--status', 'done']), noop);
    expect(missing.error).toContain('board create');
  });

  it('AC-108.1: accepts kebab-case status aliases (in-progress -> inProgress) (#108)', async () => {
    const { ctx, calls } = await ctxWith(statefulItem(5, 'Ready'));
    const moved = await runMove(ctx, moveArgs(['--issue', '5', '--status', 'in-progress']), noop);
    expect(moved).toMatchObject({ ok: true, changed: true }); // resolved to inProgress, not rejected as unknown
    expect(calls.filter((c) => c.startsWith('project item-edit')).length).toBe(1);
  });
});

describe('comment (AC-2.3)', () => {
  it('creates then updates in place for the same phase', async () => {
    let comments = [];
    const { ctx, calls } = await ctxWith([
      [(j) => j.startsWith('api repos/') && j.includes('/comments?'), () => ({ stdout: JSON.stringify(comments) })],
      [(j) => j.startsWith('api -X PATCH'), { stdout: '{}' }],
      [(j) => j.startsWith('api repos/') && j.endsWith('/comments') === false && j.includes('-f'), (j) => {
        comments = [{ id: 77, body: '<!-- forge:trail:pr -->\nold' }];
        return { stdout: JSON.stringify({ id: 77 }) };
      }],
    ]);
    const first = await runComment(ctx, commentArgs(['--issue', '2', '--phase', 'pr', '--body', 'PR #9 opened']), noop);
    expect(first).toMatchObject({ ok: true, action: 'created' });
    const second = await runComment(ctx, commentArgs(['--issue', '2', '--phase', 'pr', '--body', 'PR #9 updated']), noop);
    expect(second).toMatchObject({ ok: true, action: 'updated', id: 77 });
    expect(calls.filter((c) => c.startsWith('api -X PATCH')).length).toBe(1);
  });

  it('AC-108.2: --actor/--session embed a provenance footer (#108)', async () => {
    let comments = [];
    const { ctx, calls } = await ctxWith([
      [(j) => j.startsWith('api repos/') && j.includes('/comments?'), () => ({ stdout: JSON.stringify(comments) })],
      [(j) => j.startsWith('api repos/') && j.endsWith('/comments') === false && j.includes('-f'), () => {
        comments = [{ id: 88, body: '<!-- forge:trail:started -->' }];
        return { stdout: JSON.stringify({ id: 88 }) };
      }],
    ]);
    const res = await runComment(ctx, commentArgs(['--issue', '3', '--phase', 'started', '--body', 'picked', '--actor', 'iomanage', '--session', 'sess-1']), noop);
    expect(res.ok).toBe(true);
    expect(calls.some((c) => c.includes('by @iomanage'))).toBe(true);
    expect(calls.some((c) => c.includes('session'))).toBe(true);
  });

  it('rejects unknown phases', async () => {
    const { ctx } = await ctxWith([]);
    const res = await runComment(ctx, commentArgs(['--issue', '2', '--phase', 'vibes', '--body', 'x']), noop);
    expect(res.ok).toBe(false);
    expect(res.error).toContain('valid:');
  });
});

describe('close (AC-117)', () => {
  const commentRoutes = (ref) => [
    [(j) => j.startsWith('api repos/') && j.includes('/comments?'), () => ({ stdout: JSON.stringify(ref.comments) })],
    [(j) => j.startsWith('api repos/') && j.endsWith('/comments') === false && j.includes('-f'), () => { ref.comments = [{ id: 5, body: '<!-- forge:trail:closed -->' }]; return { stdout: JSON.stringify({ id: 5 }) }; }],
  ];

  it('AC-117.1: --reason not-planned closes NOT_PLANNED, sets Won\'t do, trails (#117)', async () => {
    const ref = { comments: [] };
    const { ctx, calls } = await ctxWith([
      ['issue view', { stdout: JSON.stringify({ state: 'OPEN' }) }],
      ['issue close', { stdout: '' }],
      ...statefulItems([{ id: 'ITEM_9', number: 12, status: 'Done' }]),
      ...commentRoutes(ref),
    ]);
    const res = await runClose(ctx, closeArgs(['--issue', '12', '--reason', 'not-planned', '--note', 'superseded by ADR-0003']), noop);
    expect(res).toMatchObject({ ok: true, status: 'wontDo' });
    expect(calls.some((c) => c.startsWith('issue close') && c.includes('not planned'))).toBe(true);
    expect(calls.some((c) => c.startsWith('project item-edit') && c.includes('sw'))).toBe(true); // wontDo option id
    expect(calls.some((c) => c.includes('closed — not planned'))).toBe(true);
  });

  it('AC-117.2: already-closed issue reconciles the board without re-closing; completed -> Done (#117)', async () => {
    const ref = { comments: [] };
    const { ctx, calls } = await ctxWith([
      ['issue view', { stdout: JSON.stringify({ state: 'CLOSED' }) }],
      ...statefulItems([{ id: 'ITEM_9', number: 33, status: 'Ready' }]),
      ...commentRoutes(ref),
    ]);
    const res = await runClose(ctx, closeArgs(['--issue', '33', '--reason', 'completed']), noop);
    expect(res).toMatchObject({ ok: true, status: 'done' });
    expect(calls.some((c) => c.startsWith('issue close'))).toBe(false); // already closed → no re-close
    expect(calls.some((c) => c.startsWith('project item-edit') && c.includes('sd'))).toBe(true); // done option id
  });

  it('AC-201.1/AC-201.2: a close whose status re-read still shows the OLD value fails loudly (#201)', async () => {
    // The #73 silent-drop class on the close path: item-edit "succeeds" but the
    // Status field never persists, so every re-read still reports the old status.
    const ref = { comments: [] };
    const { ctx, calls } = await ctxWith([
      ['issue view', { stdout: JSON.stringify({ state: 'OPEN' }) }],
      ['issue close', { stdout: '' }],
      [(j) => j.startsWith('project item-list'), itemList([{ id: 'ITEM_9', content: { number: 12 }, status: 'Ready' }])],
      ['project item-edit', { stdout: '' }], // "ok" but never mutates the static list
      ...commentRoutes(ref),
    ]);
    const res = await runClose(ctx, closeArgs(['--issue', '12', '--reason', 'not-planned']), noop);
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/did NOT persist/); // does not report a reconcile that never took
    // it retried the mutation once before giving up (2 edits, not 1)
    expect(calls.filter((c) => c.startsWith('project item-edit')).length).toBe(2);
    // and it did NOT go on to post a trail:closed note on the failed reconcile
    expect(calls.some((c) => c.includes('closed — not planned'))).toBe(false);
  });

  it('AC-201.1: an unreadable re-read (item-list lag) warns but does not false-fail (#201)', async () => {
    // First list has the item so the close-mutation fires; every later list lags
    // empty AND the issue-side fallback returns no status field → unverifiable.
    const ref = { comments: [] };
    let listCalls = 0;
    const logs = [];
    const { ctx } = await ctxWith([
      ['issue view', { stdout: JSON.stringify({ state: 'OPEN' }) }],
      ['issue close', { stdout: '' }],
      [(j) => j.startsWith('project item-list'), () => itemList(listCalls++ === 0 ? [{ id: 'ITEM_9', content: { number: 12 }, status: 'Ready' }] : [])],
      [(j) => j.startsWith('api graphql') && j.includes('projectItems'),
        { stdout: JSON.stringify({ data: { repository: { issue: { projectItems: { nodes: [{ id: 'ITEM_9', project: { number: 8 } }] } } } } }) }],
      ['project item-edit', { stdout: '' }],
      ...commentRoutes(ref),
    ]);
    const res = await runClose(ctx, closeArgs(['--issue', '12', '--reason', 'not-planned']), (m) => logs.push(m));
    expect(res).toMatchObject({ ok: true, status: 'wontDo' }); // proceeds unverified, not a false failure
    expect(logs.some((m) => /could not confirm/.test(m))).toBe(true);
  });

  it('rejects an unknown --reason', async () => {
    const { ctx } = await ctxWith([]);
    const res = await runClose(ctx, closeArgs(['--issue', '1', '--reason', 'bogus']), noop);
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/--reason must be one of/);
  });
});

describe('batch close (AC-123)', () => {
  // Per-issue trail comment routes, mirroring AC-117.1's commentRoutes but keyed
  // by issue number so each issue keeps its own trail ledger (no cross-talk).
  // list (GET, has `?`) → returns the current ledger; create (POST, has `-f`) →
  // seeds a trail:closed marker so a re-run PATCHes rather than stacking.
  const commentRoutes = (ref, num) => [
    [(j) => j.includes(`/issues/${num}/comments?`), () => ({ stdout: JSON.stringify(ref.comments) })],
    [(j) => j.includes(`/issues/${num}/comments`) && j.endsWith('/comments') === false && j.includes('-f'), () => { ref.comments = [{ id: num, body: '<!-- forge:trail:closed -->' }]; return { stdout: JSON.stringify({ id: num }) }; }],
  ];

  // runCloseBatch's parsed-args contract: `issue` is a comma-separated string
  // (or a single number-as-string), plus the same `reason`/`note` runClose reads.
  it('AC-123.1: --issue 12,13 closes each, one result per issue, note in every trail, idempotent', async () => {
    const ref12 = { comments: [] };
    const ref13 = { comments: [] };
    const { ctx, calls } = await ctxWith([
      ['issue view', { stdout: JSON.stringify({ state: 'OPEN' }) }],
      ['issue close', { stdout: '' }],
      ...statefulItems([
        { id: 'ITEM_9', number: 12, status: 'Done' },
        { id: 'ITEM_10', number: 13, status: 'Done' },
      ]),
      [(j) => j.startsWith('api -X PATCH'), { stdout: '{}' }], // re-run PATCHes the existing trail
      ...commentRoutes(ref12, 12),
      ...commentRoutes(ref13, 13),
    ]);
    const args = { issue: '12,13', reason: 'not-planned', note: 'superseded by ADR-0003' };
    const res = await runCloseBatch(ctx, args, noop);

    expect(res).toMatchObject({ ok: true, closed: 2, failed: 0 });
    expect(Array.isArray(res.results)).toBe(true);
    expect(res.results.length).toBe(2); // one entry per issue

    // BOTH issues get a NOT_PLANNED GitHub close ("not planned")
    expect(calls.filter((c) => c.startsWith('issue close') && c.includes('not planned')).length).toBe(2);
    // the note reaches EACH issue's trail body (one create per issue)
    expect(calls.filter((c) => c.includes('/issues/12/comments') && c.includes('superseded by ADR-0003')).length).toBe(1);
    expect(calls.filter((c) => c.includes('/issues/13/comments') && c.includes('superseded by ADR-0003')).length).toBe(1);

    // idempotent: re-running yields the same summary and does not stack trail
    // comments (the marker exists now → PATCH, not a second POST to /issues/N/comments)
    const res2 = await runCloseBatch(ctx, args, noop);
    expect(res2).toMatchObject({ ok: true, closed: 2, failed: 0 });
    expect(calls.filter((c) => c.includes('/issues/12/comments') && c.includes('-f')).length).toBe(1);
    expect(calls.filter((c) => c.includes('/issues/13/comments') && c.includes('-f')).length).toBe(1);
  });

  it('AC-123.1: partial failure — one issue view fails → ok:false closed:1 failed:1, naming the failure', async () => {
    const ref12 = { comments: [] };
    const { ctx } = await ctxWith([
      [(j) => j.startsWith('issue view 13'), { ok: false, stderr: 'issue view failed for #13' }], // must precede the generic route
      ['issue view', { stdout: JSON.stringify({ state: 'OPEN' }) }],
      ['issue close', { stdout: '' }],
      ...statefulItems([
        { id: 'ITEM_9', number: 12, status: 'Done' },
        { id: 'ITEM_10', number: 13, status: 'Done' },
      ]),
      ...commentRoutes(ref12, 12),
    ]);
    const res = await runCloseBatch(ctx, { issue: '12,13', reason: 'not-planned' }, noop);

    expect(res).toMatchObject({ ok: false, closed: 1, failed: 1 });
    const r12 = res.results.find((r) => r.issue === 12);
    const r13 = res.results.find((r) => r.issue === 13);
    expect(r12).toMatchObject({ ok: true });   // the good one still closed
    expect(r13).toMatchObject({ ok: false });  // results name which issue failed
  });

  it('AC-123.2: a single --issue 12 returns the unchanged single-issue shape, not a batch summary', async () => {
    const ref12 = { comments: [] };
    const { ctx } = await ctxWith([
      ['issue view', { stdout: JSON.stringify({ state: 'OPEN' }) }],
      ['issue close', { stdout: '' }],
      ...statefulItems([{ id: 'ITEM_9', number: 12, status: 'Done' }]),
      ...commentRoutes(ref12, 12),
    ]);
    const res = await runCloseBatch(ctx, { issue: '12', reason: 'not-planned' }, noop);

    expect(res).toMatchObject({ ok: true, issue: 12, reason: 'not-planned', status: 'wontDo' });
    expect(res.results).toBeUndefined(); // NOT a batch summary
    expect('closed' in res).toBe(false);
  });

  it('AC-123.3: bogus --reason fails fast — no view/close/item-edit call is made', async () => {
    const { ctx, calls } = await ctxWith([]);
    const res = await runCloseBatch(ctx, { issue: '12,13', reason: 'bogus' }, noop);

    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/--reason must be one of/);
    expect(calls.some((c) => c.startsWith('issue view'))).toBe(false);
    expect(calls.some((c) => c.startsWith('issue close'))).toBe(false);
    expect(calls.some((c) => c.startsWith('project item-edit'))).toBe(false);
  });

  it('AC-123.4: non-numeric --issue fails fast — no view/close/item-edit call is made', async () => {
    const { ctx, calls } = await ctxWith([]);
    const res = await runCloseBatch(ctx, { issue: 'abc', reason: 'not-planned' }, noop);

    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/--issue must be one or more positive integers/);
    expect(res.error).toContain('abc'); // names the bad input
    expect(calls.some((c) => c.startsWith('issue view'))).toBe(false);
    expect(calls.some((c) => c.startsWith('issue close'))).toBe(false);
    expect(calls.some((c) => c.startsWith('project item-edit'))).toBe(false);
  });
});

describe('receipt + log (AC-2.4)', () => {
  it('receipt is idempotent by pr marker', async () => {
    const existing = [{ id: 9, body: '<!-- forge:receipt:pr-16 -->\nold receipt' }];
    const { ctx, calls } = await ctxWith([
      [(j) => j.includes('/comments?'), { stdout: JSON.stringify(existing) }],
      [(j) => j.startsWith('api -X PATCH'), { stdout: '{}' }],
    ]);
    const res = await runReceipt(ctx, { issue: 1, pr: 16, sha: '34820ce9c18', title: 'SP1' }, noop);
    expect(res).toMatchObject({ ok: true, action: 'updated' });
    expect(calls.some((c) => c.startsWith('api -X PATCH'))).toBe(true);
  });

  it('log writes the row to the configured delivery-log issue', async () => {
    const { ctx, calls } = await ctxWith([
      [(j) => j.includes('/comments?'), { stdout: '[]' }],
      [(j) => j.includes('/issues/15/comments'), { stdout: JSON.stringify({ id: 1 }) }],
    ]);
    const res = await runLog(ctx, { pr: 16, sha: 'abc1234def', title: 'SP1', issues: '1', date: '2026-07-16' }, noop);
    expect(res.ok).toBe(true);
    expect(calls.some((c) => c.includes('/issues/15/comments'))).toBe(true);
  });

  it('log fails clearly when deliveryLogIssue unconfigured', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'forge-board-'));
    await mkdir(join(dir, '.claude'), { recursive: true });
    const cfg = structuredClone(CFG);
    delete cfg.board.deliveryLogIssue;
    await writeFile(join(dir, '.claude', 'forge.json'), JSON.stringify(cfg), 'utf8');
    const f = fakeGh([['repo view', REPO_VIEW]]);
    const ctx = await makeBoardCtx({ gh: f.gh, cwd: dir });
    const res = await runLog(ctx, { pr: 16 }, noop);
    expect(res.ok).toBe(false);
    expect(res.error).toContain('/forge:init');
  });
});

describe('digest (AC-2.5)', () => {
  it('renders blocked-first and rewrites only the managed block', async () => {
    let savedBody = null;
    const { ctx } = await ctxWith([
      [(j) => j.includes('subIssues'), { stdout: JSON.stringify({ data: { repository: { issue: { subIssues: { nodes: [
        { number: 21, title: 'Child A', state: 'OPEN' },
        { number: 22, title: 'Child B', state: 'OPEN' },
        { number: 23, title: 'Child C', state: 'CLOSED' },
      ] } } } } }) }],
      [(j) => j.startsWith('project item-list'), itemList([
        { id: 'i21', content: { number: 21 }, status: 'Backlog', assignees: ['dngioidev'] },
        { id: 'i22', content: { number: 22 }, status: 'Blocked / Needs decision', assignees: [] },
        { id: 'i23', content: { number: 23 }, status: 'Done', assignees: [] },
      ])],
      ['issue view 2', { stdout: JSON.stringify({ body: 'Epic intro stays.', title: 'Epic', state: 'OPEN' }) }],
      [(j, args) => j.startsWith('issue edit'), (j, args) => { savedBody = args[args.indexOf('--body') + 1]; return { stdout: '' }; }],
    ]);
    const res = await runDigest(ctx, { epic: 2 }, noop);
    expect(res).toMatchObject({ ok: true, changed: true, rows: 3 });
    expect(savedBody).toContain('Epic intro stays.');
    const blockedIdx = savedBody.indexOf('#22');
    expect(blockedIdx).toBeGreaterThan(-1);
    expect(blockedIdx).toBeLessThan(savedBody.indexOf('#21'));
    expect(savedBody).toContain('1 blocked — needs a decision');
    expect(savedBody).toContain('forge:digest:begin');
  });

  it('renderChildTable is stable for empty epics', () => {
    const out = renderChildTable([]);
    expect(out).toContain('0 children');
  });
});

describe('digest flow metrics (AC-7.6)', () => {
  it('AC-7.6: cycle time per closed child with size, median, and journal counts', () => {
    const rows = [
      { number: 21, size: 'M', createdAt: '2026-07-10T00:00:00Z', closedAt: '2026-07-12T12:00:00Z' },
      { number: 22, size: 'S', createdAt: '2026-07-11T00:00:00Z', closedAt: '2026-07-11T12:00:00Z' },
      { number: 23, size: null, createdAt: '2026-07-12T00:00:00Z', closedAt: null }, // still open
    ];
    const events = [
      { kind: 'gate-fail', gate: 'plandrift' }, { kind: 'gate-fail', gate: 'acgate' },
      { kind: 'backend-fallback', role: 'investigator' },
    ];
    const m = computeFlowMetrics(rows, events);
    expect(m.shipped).toEqual([
      { number: 21, size: 'M', cycle: 2.5 },
      { number: 22, size: 'S', cycle: 0.5 },
    ]);
    expect(m.medianCycle).toBe(1.5);
    expect(m.counts).toEqual({ 'gate-fail': 2, 'backend-fallback': 1 });

    const out = renderFlow(m);
    expect(out).toContain('| #21 | M | 2.5d |');
    expect(out).toContain('median cycle: 1.5d');
    expect(out).toContain('2 gate-fail');
    expect(out).toContain('1 backend-fallback');
  });

  it('AC-7.6: the digest managed block carries the Flow section', async () => {
    let savedBody = null;
    const { ctx } = await ctxWith([
      [(j) => j.includes('subIssues'), { stdout: JSON.stringify({ data: { repository: { issue: { subIssues: { nodes: [
        { number: 23, title: 'Child C', state: 'CLOSED', createdAt: '2026-07-10T00:00:00Z', closedAt: '2026-07-11T00:00:00Z' },
      ] } } } } }) }],
      [(j) => j.startsWith('project item-list'), itemList([
        { id: 'i23', content: { number: 23 }, status: 'Done', size: 'M', assignees: [] },
      ])],
      ['issue view 2', { stdout: JSON.stringify({ body: 'Epic intro.', title: 'Epic', state: 'OPEN' }) }],
      [(j, args) => j.startsWith('issue edit'), (j, args) => { savedBody = args[args.indexOf('--body') + 1]; return { stdout: '' }; }],
    ]);
    const res = await runDigest(ctx, { epic: 2 }, noop);
    expect(res.ok).toBe(true);
    expect(savedBody).toContain('### Flow');
    expect(savedBody).toContain('| #23 | M | 1d |');
    expect(savedBody).toContain('journal since last archive: clean');
  });

  it('cycleDays is null on open, missing, or negative spans', () => {
    expect(cycleDays('2026-07-10T00:00:00Z', null)).toBe(null);
    expect(cycleDays(null, '2026-07-10T00:00:00Z')).toBe(null);
    expect(cycleDays('2026-07-12T00:00:00Z', '2026-07-10T00:00:00Z')).toBe(null);
  });
});

describe('status (AC-2.6)', () => {
  it('prints counts, blocked first as the situation, and next action', async () => {
    const { ctx } = await ctxWith([
      [(j) => j.startsWith('project item-list'), itemList([
        { id: 'a', content: { number: 1 }, title: 'One', status: 'Done' },
        { id: 'b', content: { number: 2 }, title: 'Two', status: 'In progress' },
        { id: 'c', content: { number: 3 }, title: 'Three', status: 'Blocked / Needs decision' },
      ])],
      ['pr list', { stdout: JSON.stringify([{ number: 17, title: 'feat: x', isDraft: false }]) }],
    ]);
    const res = await runStatus(ctx, noop);
    expect(res.ok).toBe(true);
    expect(res.text).toContain('situation: 🚩 awaiting-decision (1 pending decision)');
    expect(res.text).toContain('🚩 blocked: #3 Three');
    expect(res.text).toContain('▶ in progress: #2 Two');
    expect(res.text).toContain('⇡ open PR: #17');
    expect(res.text).toContain('next: answer the blocked decision(s)');
  });
});
