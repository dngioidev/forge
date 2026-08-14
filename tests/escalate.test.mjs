import { describe, it, expect } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeBoardCtx } from '../plugin/scripts/lib/boardctx.mjs';
import { runEscalate, runCheck, parseArgs, normalizeOptions, escapeMd } from '../plugin/scripts/board/escalate.mjs';
import { read as readJournal } from '../plugin/scripts/lib/journal.mjs';
import { fakeGh, REPO_VIEW } from './helpers/fakegh.mjs';

const noop = () => {};

const CFG = {
  board: {
    projectNumber: 8,
    projectId: 'PVT_test',
    fields: {
      status: { id: 'PVTSSF_s', options: { backlog: 'sb', ready: 'sr', inProgress: 'sp', inReview: 'sv', blocked: 'sk', done: 'sd' } },
      priority: { id: 'PVTSSF_p', options: { p0: 'a', p1: 'b', p2: 'c' } },
      size: { id: 'PVTSSF_z', options: { s: '2', m: '3' } },
      type: { id: 'PVTSSF_t', options: { epic: 'e', item: 'i' } },
    },
  },
};

async function cwdWithConfig() {
  const dir = await mkdtemp(join(tmpdir(), 'forge-esc-'));
  await mkdir(join(dir, '.claude'), { recursive: true });
  await writeFile(join(dir, '.claude', 'forge.json'), JSON.stringify(CFG), 'utf8');
  return dir;
}

describe('escalate (AC-3.2)', () => {
  it('open: moves to blocked, posts decision comment, journals, writes pending file', async () => {
    // stateful board so the #178 verify-after-move re-read sees the mutation land
    let status = 'In progress';
    const f = fakeGh([
      ['repo view', REPO_VIEW],
      [(j) => j.startsWith('project item-list'), () => ({ stdout: JSON.stringify({ items: [{ id: 'IT3', content: { number: 3 }, status }] }) })],
      [(j) => j.startsWith('project item-edit'), () => { status = 'Blocked / Needs decision'; return { stdout: '' }; }],
      [(j) => j.includes('/comments?'), { stdout: '[]' }],
      [(j) => j.includes('/issues/3/comments'), { stdout: JSON.stringify({ id: 501 }) }],
    ]);
    const cwd = await cwdWithConfig();
    const ctx = await makeBoardCtx({ gh: f.gh, cwd });
    const res = await runEscalate(ctx, parseArgs(['--issue', '3', '--reason', 'same gate failed twice', '--options', 'skip the gate|redesign the task', '--recommend', 'redesign the task']), noop);
    expect(res.ok).toBe(true);

    expect(f.calls.some((c) => c.includes('--single-select-option-id sk'))).toBe(true); // blocked
    const journal = await readJournal(cwd, { kinds: ['escalation'] });
    expect(journal.events[0]).toMatchObject({ issue: 3, reason: 'same gate failed twice' });
    const pending = JSON.parse(await readFile(join(cwd, '.forge', 'decisions', `${res.id}.json`), 'utf8'));
    expect(pending).toMatchObject({ status: 'pending', issue: 3, recommend: 'redesign the task' });
  });

  it('AC-B1.1: board without a blocked option — decision comment, journal, pending file still land; no move fires (#27)', async () => {
    const cfg = structuredClone(CFG);
    cfg.board.fields.status.options = { backlog: 'sb', inProgress: 'sp', done: 'sd' }; // this repo's real shape
    const dir = await mkdtemp(join(tmpdir(), 'forge-esc-nb-'));
    await mkdir(join(dir, '.claude'), { recursive: true });
    await writeFile(join(dir, '.claude', 'forge.json'), JSON.stringify(cfg), 'utf8');

    const f = fakeGh([
      ['repo view', REPO_VIEW],
      [(j) => j.includes('/comments?'), { stdout: '[]' }],
      [(j) => j.includes('/issues/3/comments'), { stdout: JSON.stringify({ id: 501 }) }],
    ]);
    const ctx = await makeBoardCtx({ gh: f.gh, cwd: dir });
    const logs = [];
    const res = await runEscalate(ctx, parseArgs(['--issue', '3', '--reason', 'infra decision', '--options', 'a|b']), (m) => logs.push(m));
    expect(res.ok).toBe(true);
    expect(f.calls.some((c) => c.includes('item-edit'))).toBe(false); // no move attempted
    expect(logs.join(' ')).toMatch(/no 'blocked' status option/);
    const journal = await readJournal(dir, { kinds: ['escalation'] });
    expect(journal.events[0]).toMatchObject({ issue: 3, reason: 'infra decision' });
    const pending = JSON.parse(await readFile(join(dir, '.forge', 'decisions', `${res.id}.json`), 'utf8'));
    expect(pending.status).toBe('pending');
  });

  it('open: requires at least two options', async () => {
    const f = fakeGh([['repo view', REPO_VIEW]]);
    const ctx = await makeBoardCtx({ gh: f.gh, cwd: await cwdWithConfig() });
    const res = await runEscalate(ctx, parseArgs(['--issue', '3', '--reason', 'x', '--options', 'only-one']), noop);
    expect(res.ok).toBe(false);
    expect(res.error).toContain('two options');
  });

  it('check: resolves on the first human (marker-free) reply after the decision comment', async () => {
    const cwd = await cwdWithConfig();
    await mkdir(join(cwd, '.forge', 'decisions'), { recursive: true });
    await writeFile(join(cwd, '.forge', 'decisions', 'esc-3-abc.json'), JSON.stringify({ id: 'esc-3-abc', issue: 3, reason: 'r', options: ['a', 'b'], status: 'pending' }), 'utf8');

    // stateful board (like the "open" test above) so the #178 verify-after-move re-read sees the mutation land
    let status = 'Blocked / Needs decision';
    const f = fakeGh([
      ['repo view', REPO_VIEW],
      [(j) => j.includes('/comments?'), { stdout: JSON.stringify([
        { id: 500, body: '<!-- forge:trail:started -->\ntrail' },
        { id: 501, body: '<!-- forge:decision:esc-3-abc -->\n🚩 Decision needed' },
        { id: 502, body: '<!-- forge:trail:note -->\nanother bot comment' },
        { id: 503, body: 'Option 2 — redesign it, and keep the gate.', author_association: 'OWNER' },
      ]) }],
      [(j) => j.startsWith('project item-list'), () => ({ stdout: JSON.stringify({ items: [{ id: 'IT3', content: { number: 3 }, status }] }) })],
      [(j) => j.startsWith('project item-edit'), () => { status = 'Backlog'; return { stdout: '' }; }],
    ]);
    const ctx = await makeBoardCtx({ gh: f.gh, cwd });
    const res = await runCheck(ctx, { issue: 3 }, noop);
    expect(res.resolved.length).toBe(1);
    expect(res.resolved[0].answer).toContain('Option 2');
    // #499 AC-499.5: resolving also moves the board off `blocked` — no manual move needed.
    expect(res.resolved[0].moved).toBe(true);
    expect(f.calls.some((c) => c.includes('--single-select-option-id sb'))).toBe(true); // backlog

    const file = JSON.parse(await readFile(join(cwd, '.forge', 'decisions', 'esc-3-abc.json'), 'utf8'));
    expect(file.status).toBe('resolved');
    const journal = await readJournal(cwd, { kinds: ['escalation-resolved'] });
    expect(journal.events.length).toBe(1);
  });

  it('AC-B1.2: check resolves identically on a board without a blocked option (#27)', async () => {
    const cfg = structuredClone(CFG);
    cfg.board.fields.status.options = { backlog: 'sb', inProgress: 'sp', done: 'sd' };
    const cwd = await mkdtemp(join(tmpdir(), 'forge-esc-nb2-'));
    await mkdir(join(cwd, '.claude'), { recursive: true });
    await writeFile(join(cwd, '.claude', 'forge.json'), JSON.stringify(cfg), 'utf8');
    await mkdir(join(cwd, '.forge', 'decisions'), { recursive: true });
    await writeFile(join(cwd, '.forge', 'decisions', 'esc-9-nb.json'), JSON.stringify({ id: 'esc-9-nb', issue: 9, reason: 'r', options: ['a', 'b'], status: 'pending' }), 'utf8');
    // no 'blocked' option on this board, so the ticket never left its original status —
    // resolve only clears a ticket that's ACTUALLY at 'blocked' (#499 reviewer fix-wave),
    // so this one — never blocked to begin with — is correctly left alone, not demoted.
    const f = fakeGh([
      ['repo view', REPO_VIEW],
      [(j) => j.includes('/comments?'), { stdout: JSON.stringify([
        { id: 501, body: '<!-- forge:decision:esc-9-nb -->\n🚩 Decision needed' },
        { id: 502, body: 'option 1', author_association: 'MEMBER' },
      ]) }],
      [(j) => j.startsWith('project item-list'), () => ({ stdout: JSON.stringify({ items: [{ id: 'IT9', content: { number: 9 }, status: 'In progress' }] }) })],
    ]);
    const ctx = await makeBoardCtx({ gh: f.gh, cwd });
    const res = await runCheck(ctx, { issue: 9 }, noop);
    expect(res.resolved).toEqual([{ id: 'esc-9-nb', issue: 9, answer: 'option 1', moved: true }]);
    expect(f.calls.some((c) => c.includes('item-edit'))).toBe(false); // never blocked — nothing to move
  });

  it('#499 reviewer fix-wave: a genuinely in-flight ticket (inReview) is NOT demoted to backlog on resolve', async () => {
    // The bug the reviewer caught: an escalation can fire mid-delivery (deadlock, a gate
    // failing twice), so the ticket is inProgress/inReview, not blocked, when resolved.
    // Forcing it to backlog would discard real in-flight state for no reason.
    const cwd = await cwdWithConfig();
    await mkdir(join(cwd, '.forge', 'decisions'), { recursive: true });
    await writeFile(join(cwd, '.forge', 'decisions', 'esc-20-v.json'), JSON.stringify({ id: 'esc-20-v', issue: 20, reason: 'r', options: ['a', 'b'], status: 'pending' }), 'utf8');
    const f = fakeGh([
      ['repo view', REPO_VIEW],
      [(j) => j.includes('/comments?'), { stdout: JSON.stringify([
        { id: 501, body: '<!-- forge:decision:esc-20-v -->\n🚩 Decision needed' },
        { id: 502, body: 'answer', author_association: 'OWNER' },
      ]) }],
      [(j) => j.startsWith('project item-list'), () => ({ stdout: JSON.stringify({ items: [{ id: 'IT20', content: { number: 20 }, status: 'In review' }] }) })],
    ]);
    const ctx = await makeBoardCtx({ gh: f.gh, cwd });
    const res = await runCheck(ctx, { issue: 20 }, noop);
    expect(res.resolved).toEqual([{ id: 'esc-20-v', issue: 20, answer: 'answer', moved: true }]); // moved=true: not blocked, no correction needed
    expect(f.calls.some((c) => c.includes('item-edit'))).toBe(false); // status left exactly as-is
  });

  it('AC-300.1: array option elements are not re-split on "|" (embedded pipe cannot fabricate options)', async () => {
    // Captures the posted decision-comment body so we can assert the rendered option count.
    let postedBody = null;
    let status = 'In progress';
    const f = fakeGh([
      ['repo view', REPO_VIEW],
      [(j) => j.startsWith('project item-list'), () => ({ stdout: JSON.stringify({ items: [{ id: 'IT3', content: { number: 3 }, status }] }) })],
      [(j) => j.startsWith('project item-edit'), () => { status = 'Blocked / Needs decision'; return { stdout: '' }; }],
      [(j) => j.includes('/comments?'), { stdout: '[]' }],
      [(j) => j.includes('/issues/3/comments'), (j, args) => {
        postedBody = (args.find((a) => a.startsWith('body=')) ?? '').slice(5);
        return { stdout: JSON.stringify({ id: 501 }) };
      }],
    ]);
    const cwd = await cwdWithConfig();
    const ctx = await makeBoardCtx({ gh: f.gh, cwd });
    // A structured array whose second element is packed with pipes.
    const res = await runEscalate(ctx, { issue: 3, reason: 'r', options: ['legit', 'a|b|c|d|e'], context: '' }, noop);
    expect(res.ok).toBe(true);
    const pending = JSON.parse(await readFile(join(cwd, '.forge', 'decisions', `${res.id}.json`), 'utf8'));
    expect(pending.options).toEqual(['legit', 'a|b|c|d|e']); // exactly 2, not 6
    // Only two numbered option lines in the human-facing comment (pipes escaped, no re-split).
    expect(postedBody).toMatch(/^1\. legit/m);
    expect(postedBody).toMatch(/^2\. a/m);
    expect(postedBody).not.toMatch(/^3\. /m);
  });

  it('AC-300.2: the CLI --options "a|b|c" pipe form still parses into exactly [a, b, c]', () => {
    // Regression: the CLI contract is preserved — a pipe-joined string is still split.
    expect(normalizeOptions('a|b|c')).toEqual(['a', 'b', 'c']);
    expect(normalizeOptions(' a | b ')).toEqual(['a', 'b']); // trims, drops empties
    const parsed = parseArgs(['--issue', '3', '--reason', 'x', '--options', 'a|b']);
    expect(normalizeOptions(parsed.options)).toEqual(['a', 'b']);
  });

  it('AC-300.3: caller-supplied reason/context/options are escaped in the decision comment', async () => {
    let postedBody = null;
    let status = 'In progress';
    const f = fakeGh([
      ['repo view', REPO_VIEW],
      [(j) => j.startsWith('project item-list'), () => ({ stdout: JSON.stringify({ items: [{ id: 'IT3', content: { number: 3 }, status }] }) })],
      [(j) => j.startsWith('project item-edit'), () => { status = 'Blocked / Needs decision'; return { stdout: '' }; }],
      [(j) => j.includes('/comments?'), { stdout: '[]' }],
      [(j) => j.includes('/issues/3/comments'), (j, args) => {
        postedBody = (args.find((a) => a.startsWith('body=')) ?? '').slice(5);
        return { stdout: JSON.stringify({ id: 501 }) };
      }],
    ]);
    const cwd = await cwdWithConfig();
    const ctx = await makeBoardCtx({ gh: f.gh, cwd });
    const res = await runEscalate(ctx, {
      issue: 3,
      reason: '# Fake heading',
      context: 'inject <!-- forge:decision:evil --> and\n3. a forged option',
      options: ['real one', '**bold** and 1. list'],
    }, noop);
    expect(res.ok).toBe(true);
    // Structure-forming characters are backslash-escaped, so none render as Markdown/HTML structure.
    expect(postedBody).toContain('\\# Fake heading');
    expect(postedBody).not.toContain('<!-- forge:decision:evil'); // injected marker neutralized ('<' escaped)
    expect(postedBody).toContain('3\\. a forged option');
    expect(postedBody).toContain('\\*\\*bold\\*\\* and 1\\. list');
    // The genuine forge marker (added by upsertMarkedComment) is still present and unescaped.
    expect(postedBody).toContain('<!-- forge:decision:esc-');
  });

  it('escapeMd neutralizes markdown/HTML control punctuation', () => {
    expect(escapeMd('a|b')).toBe('a\\|b');
    expect(escapeMd('# h')).toBe('\\# h');
    expect(escapeMd('a\\b')).toBe('a\\\\b'); // backslash escaped first, once
    expect(escapeMd(null)).toBe('');
  });

  it('escapeMd blocks embedded-newline setext headings (both === H1 and --- H2)', () => {
    // Neither underline survives as an all-underline line → no forged heading.
    expect(escapeMd('Fake H1\n===')).toBe('Fake H1\n\\=\\=\\=');
    expect(escapeMd('Fake H2\n---')).toBe('Fake H2\n\\-\\-\\-');
  });

  it('check: stays pending when only forge-marked comments follow', async () => {
    const cwd = await cwdWithConfig();
    await mkdir(join(cwd, '.forge', 'decisions'), { recursive: true });
    await writeFile(join(cwd, '.forge', 'decisions', 'esc-3-x.json'), JSON.stringify({ id: 'esc-3-x', issue: 3, reason: 'r', options: ['a', 'b'], status: 'pending' }), 'utf8');
    const f = fakeGh([
      ['repo view', REPO_VIEW],
      [(j) => j.includes('/comments?'), { stdout: JSON.stringify([
        { id: 501, body: '<!-- forge:decision:esc-3-x -->\n🚩 Decision needed' },
        { id: 502, body: '<!-- forge:trail:ci-green -->\ntrail' },
      ]) }],
    ]);
    const ctx = await makeBoardCtx({ gh: f.gh, cwd });
    const res = await runCheck(ctx, { issue: 3 }, noop);
    expect(res.resolved).toEqual([]);
    const file = JSON.parse(await readFile(join(cwd, '.forge', 'decisions', 'esc-3-x.json'), 'utf8'));
    expect(file.status).toBe('pending');
  });

  it('AC-499.5: resolve on an already-drifted (never-blocked) ticket is a safe no-op — not blocked, no move needed', async () => {
    // #438-shaped case: the decision file is pending but the board already drifted to backlog
    // BEFORE the human answered. It's already off `blocked`, so resolve correctly leaves it alone.
    const cwd = await cwdWithConfig();
    await mkdir(join(cwd, '.forge', 'decisions'), { recursive: true });
    await writeFile(join(cwd, '.forge', 'decisions', 'esc-438-x.json'), JSON.stringify({ id: 'esc-438-x', issue: 438, reason: 'r', options: ['a', 'b'], status: 'pending' }), 'utf8');
    const f = fakeGh([
      ['repo view', REPO_VIEW],
      [(j) => j.includes('/comments?'), { stdout: JSON.stringify([
        { id: 501, body: '<!-- forge:decision:esc-438-x -->\n🚩 Decision needed' },
        { id: 502, body: 'go with option a', author_association: 'COLLABORATOR' },
      ]) }],
      [(j) => j.startsWith('project item-list'), () => ({ stdout: JSON.stringify({ items: [{ id: 'IT438', content: { number: 438 }, status: 'Backlog' }] }) })],
    ]);
    const ctx = await makeBoardCtx({ gh: f.gh, cwd });
    const res = await runCheck(ctx, { issue: 438 }, noop);
    expect(res.resolved).toEqual([{ id: 'esc-438-x', issue: 438, answer: 'go with option a', moved: true }]);
    // status isn't 'blocked' — no move is even attempted, let alone an item-edit call.
    expect(f.calls.some((c) => c.includes('item-edit'))).toBe(false);
  });

  it('AC-499.5: an unreadable board status on resolve degrades to a warning (not a blind move) — the decision still resolves', async () => {
    const cwd = await cwdWithConfig();
    await mkdir(join(cwd, '.forge', 'decisions'), { recursive: true });
    await writeFile(join(cwd, '.forge', 'decisions', 'esc-7-y.json'), JSON.stringify({ id: 'esc-7-y', issue: 7, reason: 'r', options: ['a', 'b'], status: 'pending' }), 'utf8');
    // no 'project item-list' route mocked — the pre-move findItemByIssue status check fails,
    // so the move is skipped entirely rather than guessed at (would risk demoting an in-flight ticket).
    const f = fakeGh([
      ['repo view', REPO_VIEW],
      [(j) => j.includes('/comments?'), { stdout: JSON.stringify([
        { id: 501, body: '<!-- forge:decision:esc-7-y -->\n🚩 Decision needed' },
        { id: 502, body: 'answer', author_association: 'OWNER' },
      ]) }],
    ]);
    const ctx = await makeBoardCtx({ gh: f.gh, cwd });
    const logs = [];
    const res = await runCheck(ctx, { issue: 7 }, (m) => logs.push(m));
    expect(res.ok).toBe(true);
    expect(res.resolved).toEqual([{ id: 'esc-7-y', issue: 7, answer: 'answer', moved: false }]);
    expect(logs.join(' ')).toMatch(/board status couldn't be confirmed/);
    expect(f.calls.some((c) => c.includes('item-edit'))).toBe(false); // no blind move attempted
    const file = JSON.parse(await readFile(join(cwd, '.forge', 'decisions', 'esc-7-y.json'), 'utf8'));
    expect(file.status).toBe('resolved'); // resolved regardless of the move outcome
  });

  it('#499 security fix-wave ROUND 2: a reply from an untrusted author does NOT resolve the decision at all — it stays pending', async () => {
    // Round-1's fix only gated the board MOVE on trust and left the decision-file
    // resolution unconditional — but resolution alone empties select.mjs's
    // pendingIssues, defeating AC-499.1 on any board with no 'blocked' option
    // mapped or after status drift. So an untrusted reply must not resolve at all.
    const cwd = await cwdWithConfig();
    await mkdir(join(cwd, '.forge', 'decisions'), { recursive: true });
    await writeFile(join(cwd, '.forge', 'decisions', 'esc-11-z.json'), JSON.stringify({ id: 'esc-11-z', issue: 11, reason: 'r', options: ['a', 'b'], status: 'pending' }), 'utf8');
    // no 'project item-list'/'item-edit' route mocked — if a move (or even a status read) were
    // attempted at all, this would throw an unrouted-call error.
    const f = fakeGh([
      ['repo view', REPO_VIEW],
      [(j) => j.includes('/comments?'), { stdout: JSON.stringify([
        { id: 501, body: '<!-- forge:decision:esc-11-z -->\n🚩 Decision needed' },
        { id: 502, body: 'drive-by opinion from a random public commenter', author_association: 'NONE' },
      ]) }],
    ]);
    const ctx = await makeBoardCtx({ gh: f.gh, cwd });
    const logs = [];
    const res = await runCheck(ctx, { issue: 11 }, (m) => logs.push(m));
    expect(res.ok).toBe(true);
    expect(res.resolved).toEqual([]); // NOT resolved — an untrusted reply is treated as noise, not an answer
    const file = JSON.parse(await readFile(join(cwd, '.forge', 'decisions', 'esc-11-z.json'), 'utf8'));
    expect(file.status).toBe('pending'); // still pending — pendingIssues (select.mjs) still excludes it
    expect(f.calls.some((c) => c.includes('item-list') || c.includes('item-edit'))).toBe(false); // board never even read
    expect(logs.join(' ')).toMatch(/none from a trusted author.*still pending/);
  });

  it('#499 security fix-wave ROUND 2: a reply with no author_association at all (fixture/legacy shape) is treated as untrusted — still pending', async () => {
    const cwd = await cwdWithConfig();
    await mkdir(join(cwd, '.forge', 'decisions'), { recursive: true });
    await writeFile(join(cwd, '.forge', 'decisions', 'esc-12-w.json'), JSON.stringify({ id: 'esc-12-w', issue: 12, reason: 'r', options: ['a', 'b'], status: 'pending' }), 'utf8');
    const f = fakeGh([
      ['repo view', REPO_VIEW],
      [(j) => j.includes('/comments?'), { stdout: JSON.stringify([
        { id: 501, body: '<!-- forge:decision:esc-12-w -->\n🚩 Decision needed' },
        { id: 502, body: 'no association field on this comment at all' },
      ]) }],
    ]);
    const ctx = await makeBoardCtx({ gh: f.gh, cwd });
    const res = await runCheck(ctx, { issue: 12 }, noop);
    expect(res.resolved).toEqual([]);
    const file = JSON.parse(await readFile(join(cwd, '.forge', 'decisions', 'esc-12-w.json'), 'utf8'));
    expect(file.status).toBe('pending');
    expect(f.calls.some((c) => c.includes('item-list') || c.includes('item-edit'))).toBe(false);
  });

  it('#499 security fix-wave ROUND 2: an untrusted reply is skipped, not blocking — a LATER trusted reply still resolves', async () => {
    const cwd = await cwdWithConfig();
    await mkdir(join(cwd, '.forge', 'decisions'), { recursive: true });
    await writeFile(join(cwd, '.forge', 'decisions', 'esc-13-t.json'), JSON.stringify({ id: 'esc-13-t', issue: 13, reason: 'r', options: ['a', 'b'], status: 'pending' }), 'utf8');
    let status = 'Blocked / Needs decision';
    const f = fakeGh([
      ['repo view', REPO_VIEW],
      [(j) => j.includes('/comments?'), { stdout: JSON.stringify([
        { id: 501, body: '<!-- forge:decision:esc-13-t -->\n🚩 Decision needed' },
        { id: 502, body: 'random passerby opinion', author_association: 'NONE' },
        { id: 503, body: 'go with option b', author_association: 'OWNER' },
      ]) }],
      [(j) => j.startsWith('project item-list'), () => ({ stdout: JSON.stringify({ items: [{ id: 'IT13', content: { number: 13 }, status }] }) })],
      [(j) => j.startsWith('project item-edit'), () => { status = 'Backlog'; return { stdout: '' }; }],
    ]);
    const ctx = await makeBoardCtx({ gh: f.gh, cwd });
    const res = await runCheck(ctx, { issue: 13 }, noop);
    // resolves on the OWNER's reply (the trusted one), not the untrusted passerby comment.
    expect(res.resolved).toEqual([{ id: 'esc-13-t', issue: 13, answer: 'go with option b', moved: true }]);
    const file = JSON.parse(await readFile(join(cwd, '.forge', 'decisions', 'esc-13-t.json'), 'utf8'));
    expect(file.status).toBe('resolved');
    expect(file.answer).toBe('go with option b');
  });
});
