import { describe, it, expect } from 'vitest';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { collectRepo } from '../../console/lib/collect.mjs';
import { repoCard } from '../../console/web/app.js';

async function repoDir({ plan = true, offPlan = false } = {}) {
  const cwd = await mkdtemp(join(tmpdir(), 'forge-tc-'));
  await mkdir(join(cwd, '.git'), { recursive: true });
  await writeFile(join(cwd, '.git', 'HEAD'), 'ref: refs/heads/feat/74-trace-conformance\n', 'utf8');
  await mkdir(join(cwd, '.forge'), { recursive: true });
  await mkdir(join(cwd, 'docs', 'plans'), { recursive: true });
  await writeFile(join(cwd, 'docs', 'plans', 'p.md'), '**Files:** plugin/scripts/lib/trace.mjs\n', 'utf8');
  const planLine = plan ? 'Plan: docs/plans/p.md\n' : '';
  await writeFile(join(cwd, '.forge', 'progress.md'), `# ledger — #74\n\n${planLine}\n- [x] T1 — a\n- [~] T2 — b\n`, 'utf8');
  await writeFile(join(cwd, '.forge', 'journal.jsonl'), '', 'utf8');
  const diff = async () => (offPlan ? ['src/rogue.mjs'] : ['plugin/scripts/lib/trace.mjs']);
  return { cwd, diff };
}

describe('collectRepo attaches trace + conformance (AC-C6.4)', () => {
  it('AC-C6.4: green when the branch/plan/files conform', async () => {
    const { cwd, diff } = await repoDir();
    const snap = await collectRepo(cwd, Date.now(), { diff });
    expect(snap.trace.steps.map((s) => s.key)).toEqual(['plan', 'tasks', 'files', 'pr']);
    expect(snap.trace.current).toBe('tasks'); // T2 in-progress
    expect(snap.conformance.level).toBe('green');
    // offline console omits the trail phases check
    expect(snap.conformance.checks.map((c) => c.name)).not.toContain('phases-in-order');
  });

  it('AC-C6.4: amber names the drift (off-plan file, or missing plan)', async () => {
    const off = await collectRepo((await repoDir({ offPlan: true })).cwd, Date.now(), { diff: async () => ['src/rogue.mjs'] });
    expect(off.conformance.level).toBe('amber');
    expect(off.conformance.failing).toBe('files-in-scope');

    const noPlan = await repoDir({ plan: false });
    const snap = await collectRepo(noPlan.cwd, Date.now(), { diff: noPlan.diff });
    expect(snap.conformance.failing).toBe('ledger-plan');
  });

  it('AC-C6.4: degrades gracefully when git diff is unavailable (throws → [] touched)', async () => {
    const { cwd } = await repoDir();
    const snap = await collectRepo(cwd, Date.now(), { diff: async () => { throw new Error('no git'); } });
    expect(snap.trace.steps.find((s) => s.key === 'files').label).toBe('0 files');
    expect(snap.conformance.level).toBe('green'); // no touched files → nothing off-plan
  });
});

describe('repoCard renders the strip + badge (AC-C6.4)', () => {
  it('AC-C6.4: phase strip lights the current step; badge shows level', () => {
    const html = repoCard({
      repo: 'forge', situation: 'building', glyph: '▶', branch: 'feat/74-x', ticket: '#74',
      trace: { steps: [{ key: 'plan', label: 'p.md', state: 'done' }, { key: 'tasks', label: '1/2', state: 'active' }, { key: 'files', label: '3 files', state: 'active' }, { key: 'pr', label: '—', state: 'pending' }], current: 'tasks' },
      conformance: { level: 'green', failing: null, checks: [{ name: 'valid-branch', pass: true, why: 'on feat/74' }] },
    });
    expect(html).toContain('class="trace"');
    expect(html).toMatch(/tstep active cur"[^>]*>tasks/); // current step lit
    expect(html).toContain('🟢 conforms');

    const amber = repoCard({ repo: 'x', situation: 'building', trace: { steps: [], current: 'plan' }, conformance: { level: 'amber', failing: 'files-in-scope', checks: [] } });
    expect(amber).toContain('🟡 files-in-scope');
  });
});
