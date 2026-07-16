import { describe, it, expect } from 'vitest';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeBoardCtx } from '../plugin/scripts/lib/boardctx.mjs';
import { runCreate, parseArgs as createArgs } from '../plugin/scripts/board/create.mjs';
import { runMove, parseArgs as moveArgs } from '../plugin/scripts/board/move.mjs';
import { runComment, parseArgs as commentArgs } from '../plugin/scripts/board/comment.mjs';
import { runReceipt } from '../plugin/scripts/board/receipt.mjs';
import { runLog } from '../plugin/scripts/board/log.mjs';
import { runDigest, renderChildTable } from '../plugin/scripts/board/digest.mjs';
import { runStatus } from '../plugin/scripts/board/status.mjs';
import { fakeGh, REPO_VIEW } from './helpers/fakegh.mjs';

const noop = () => {};

const CFG = {
  board: {
    projectNumber: 8,
    projectId: 'PVT_test',
    fields: {
      status: { id: 'PVTSSF_s', options: { backlog: 'sb', ready: 'sr', inProgress: 'sp', inReview: 'sv', blocked: 'sk', done: 'sd' } },
      priority: { id: 'PVTSSF_p', options: { p0: 'a', p1: 'b', p2: 'c' } },
      size: { id: 'PVTSSF_z', options: { xs: '1', s: '2', m: '3', l: '4', xl: '5' } },
      type: { id: 'PVTSSF_t', options: { epic: 'e', item: 'i', bug: 'g', test: 't' } },
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
});

describe('move (AC-2.2)', () => {
  it('moves and is a no-op when already there', async () => {
    const { ctx, calls } = await ctxWith([
      [(j) => j.startsWith('project item-list'), itemList([{ id: 'ITEM_2', content: { number: 5 }, status: 'In progress' }])],
      ['project item-edit', { stdout: '' }],
    ]);
    const moved = await runMove(ctx, moveArgs(['--issue', '5', '--status', 'done']), noop);
    expect(moved).toMatchObject({ ok: true, changed: true });
    const same = await runMove(ctx, moveArgs(['--issue', '5', '--status', 'inProgress']), noop);
    expect(same).toMatchObject({ ok: true, changed: false });
    expect(calls.filter((c) => c.startsWith('project item-edit')).length).toBe(1);
  });

  it('unknown status errors listing valid keys; off-board issue says run create', async () => {
    const { ctx } = await ctxWith([[(j) => j.startsWith('project item-list'), itemList([])]]);
    const bad = await runMove(ctx, moveArgs(['--issue', '5', '--status', 'doing']), noop);
    expect(bad.error).toContain('valid status keys');
    const missing = await runMove(ctx, moveArgs(['--issue', '5', '--status', 'done']), noop);
    expect(missing.error).toContain('board create');
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

  it('rejects unknown phases', async () => {
    const { ctx } = await ctxWith([]);
    const res = await runComment(ctx, commentArgs(['--issue', '2', '--phase', 'vibes', '--body', 'x']), noop);
    expect(res.ok).toBe(false);
    expect(res.error).toContain('valid:');
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
