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
        { id: 503, body: 'Option 2 — redesign it, and keep the gate.' },
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
    // the resolve path still moves it to 'backlog' (that option IS mapped, #27's own point).
    let status = 'In progress';
    const f = fakeGh([
      ['repo view', REPO_VIEW],
      [(j) => j.includes('/comments?'), { stdout: JSON.stringify([
        { id: 501, body: '<!-- forge:decision:esc-9-nb -->\n🚩 Decision needed' },
        { id: 502, body: 'option 1' },
      ]) }],
      [(j) => j.startsWith('project item-list'), () => ({ stdout: JSON.stringify({ items: [{ id: 'IT9', content: { number: 9 }, status }] }) })],
      [(j) => j.startsWith('project item-edit'), () => { status = 'Backlog'; return { stdout: '' }; }],
    ]);
    const ctx = await makeBoardCtx({ gh: f.gh, cwd });
    const res = await runCheck(ctx, { issue: 9 }, noop);
    expect(res.resolved).toEqual([{ id: 'esc-9-nb', issue: 9, answer: 'option 1', moved: true }]);
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

  it('AC-499.5: resolve moves a drifted (already off-blocked) ticket to backlog too — the fix does not assume blocked', async () => {
    // #438-shaped case: the decision file is pending but the board already drifted to backlog
    // BEFORE the human answered. Resolving should still land (idempotently) at backlog.
    const cwd = await cwdWithConfig();
    await mkdir(join(cwd, '.forge', 'decisions'), { recursive: true });
    await writeFile(join(cwd, '.forge', 'decisions', 'esc-438-x.json'), JSON.stringify({ id: 'esc-438-x', issue: 438, reason: 'r', options: ['a', 'b'], status: 'pending' }), 'utf8');
    const f = fakeGh([
      ['repo view', REPO_VIEW],
      [(j) => j.includes('/comments?'), { stdout: JSON.stringify([
        { id: 501, body: '<!-- forge:decision:esc-438-x -->\n🚩 Decision needed' },
        { id: 502, body: 'go with option a' },
      ]) }],
      [(j) => j.startsWith('project item-list'), () => ({ stdout: JSON.stringify({ items: [{ id: 'IT438', content: { number: 438 }, status: 'Backlog' }] }) })],
    ]);
    const ctx = await makeBoardCtx({ gh: f.gh, cwd });
    const res = await runCheck(ctx, { issue: 438 }, noop);
    expect(res.resolved).toEqual([{ id: 'esc-438-x', issue: 438, answer: 'go with option a', moved: true }]);
    // runMove no-ops (changed:false) when already at the target status — no item-edit call needed/mocked.
    expect(f.calls.some((c) => c.includes('item-edit'))).toBe(false);
  });

  it('AC-499.5: a board-move failure on resolve degrades to a warning — the decision still resolves', async () => {
    const cwd = await cwdWithConfig();
    await mkdir(join(cwd, '.forge', 'decisions'), { recursive: true });
    await writeFile(join(cwd, '.forge', 'decisions', 'esc-7-y.json'), JSON.stringify({ id: 'esc-7-y', issue: 7, reason: 'r', options: ['a', 'b'], status: 'pending' }), 'utf8');
    // no 'project item-list' route mocked — findItemByIssue (inside runMove) fails.
    const f = fakeGh([
      ['repo view', REPO_VIEW],
      [(j) => j.includes('/comments?'), { stdout: JSON.stringify([
        { id: 501, body: '<!-- forge:decision:esc-7-y -->\n🚩 Decision needed' },
        { id: 502, body: 'answer' },
      ]) }],
    ]);
    const ctx = await makeBoardCtx({ gh: f.gh, cwd });
    const logs = [];
    const res = await runCheck(ctx, { issue: 7 }, (m) => logs.push(m));
    expect(res.ok).toBe(true);
    expect(res.resolved).toEqual([{ id: 'esc-7-y', issue: 7, answer: 'answer', moved: false }]);
    expect(logs.join(' ')).toMatch(/resolved but board move to backlog failed/);
    const file = JSON.parse(await readFile(join(cwd, '.forge', 'decisions', 'esc-7-y.json'), 'utf8'));
    expect(file.status).toBe('resolved'); // resolved regardless of the move outcome
  });
});
