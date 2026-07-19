import { describe, it, expect } from 'vitest';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildTrace, conformance, phasesInOrder, ledgerPlanRef } from '../../plugin/scripts/lib/trace.mjs';
import { runTrace } from '../../plugin/scripts/trace.mjs';

const noop = () => {};

describe('buildTrace (AC-C6.1)', () => {
  it('AC-C6.1: ordered plan→tasks→files→pr with the current step marked', () => {
    const t = buildTrace({
      branch: 'feat/74-trace-conformance',
      ledgerPlan: 'docs/plans/2026-07-19-c6-trace-conformance.md',
      ledgerTasks: [{ id: 'T1', status: 'done' }, { id: 'T2', status: 'in-progress' }, { id: 'T3', status: 'pending' }],
      touchedFiles: ['plugin/scripts/lib/trace.mjs', 'tests/lib/trace.test.mjs'],
      journalEvents: [{ ts: 't1', kind: 'gate-fail', gate: 'plandrift' }],
      prNumber: null,
    });
    expect(t.ticket).toBe('#74');
    expect(t.steps.map((s) => s.key)).toEqual(['plan', 'tasks', 'files', 'pr']);
    expect(t.steps[0]).toMatchObject({ key: 'plan', state: 'done' });
    expect(t.steps[1]).toMatchObject({ state: 'active' });      // an in-progress task
    expect(t.steps[1].label).toContain('T2');
    expect(t.steps[3]).toMatchObject({ key: 'pr', state: 'pending' });
    expect(t.current).toBe('tasks');                            // first active step is lit
    expect(t.events).toHaveLength(1);
  });

  it('AC-C6.1: empty/partial inputs degrade, never throw', () => {
    const t = buildTrace({});
    expect(t.steps.find((s) => s.key === 'plan').state).toBe('missing');
    expect(t.steps.find((s) => s.key === 'tasks').state).toBe('missing');
    expect(t.branchKind).toBe('unknown');
    expect(() => buildTrace()).not.toThrow();
  });
});

describe('phasesInOrder + ledgerPlanRef', () => {
  it('a subsequence of the canonical order with started is in order; gaps ok, reversals not', () => {
    expect(phasesInOrder(['started', 'plan', 'pr', 'ci-green'])).toBe(true);
    expect(phasesInOrder(['started', 'pr', 'plan'])).toBe(false); // plan after pr — reversed
    expect(phasesInOrder(['plan', 'pr'])).toBe(false);            // missing 'started'
    expect(phasesInOrder([])).toBe(false);
  });
  it('extracts the ledger Plan: reference', () => {
    expect(ledgerPlanRef('# forge execute ledger — #74\n\nPlan: docs/plans/x.md\n')).toBe('docs/plans/x.md');
    expect(ledgerPlanRef('no plan here')).toBe(null);
  });
});

describe('conformance (AC-C6.2)', () => {
  const green = {
    branch: 'feat/74-x',
    ledgerText: 'Plan: docs/plans/p.md',
    planExists: true,
    touchedFiles: ['plugin/scripts/lib/trace.mjs', 'tests/lib/trace.test.mjs', 'docs/plans/p.md'],
    planFiles: ['plugin/scripts/lib/trace.mjs'],
  };

  it('AC-C6.2: all checks pass → green (phases omitted when phasesSeen null)', () => {
    const c = conformance(green);
    expect(c.level).toBe('green');
    expect(c.failing).toBe(null);
    expect(c.checks.map((x) => x.name)).toEqual(['valid-branch', 'ledger-plan', 'files-in-scope']); // no phases check offline
  });

  it('AC-C6.2: each check fails independently, amber names the first failing', () => {
    expect(conformance({ ...green, branch: 'random-branch' }).failing).toBe('valid-branch');
    expect(conformance({ ...green, planExists: false }).failing).toBe('ledger-plan');
    expect(conformance({ ...green, ledgerText: 'no plan line' }).failing).toBe('ledger-plan');
    const drift = conformance({ ...green, touchedFiles: ['src/secret.mjs'] });
    expect(drift.failing).toBe('files-in-scope');
    expect(drift.checks.find((x) => x.name === 'files-in-scope').why).toContain('off-plan');
  });

  it('AC-C6.2: phases check is included only when phasesSeen is supplied (CLI path)', () => {
    const withPhases = conformance({ ...green, phasesSeen: ['started', 'plan', 'pr'] });
    expect(withPhases.checks.map((x) => x.name)).toContain('phases-in-order');
    expect(withPhases.level).toBe('green');
    expect(conformance({ ...green, phasesSeen: ['pr', 'started'] }).failing).toBe('phases-in-order');
  });
});

describe('trace CLI (AC-C6.3)', () => {
  async function repo(conforming) {
    const cwd = await mkdtemp(join(tmpdir(), 'forge-trace-'));
    await mkdir(join(cwd, '.forge'), { recursive: true });
    await mkdir(join(cwd, 'docs', 'plans'), { recursive: true });
    await writeFile(join(cwd, 'docs', 'plans', 'p.md'), '**Files:** plugin/scripts/lib/trace.mjs\n', 'utf8');
    await writeFile(join(cwd, '.forge', 'progress.md'), '# ledger — #74\n\nPlan: docs/plans/p.md\n\n- [x] T1 — a\n', 'utf8');
    await writeFile(join(cwd, '.forge', 'journal.jsonl'), '', 'utf8');
    // fake git/gh
    const touched = conforming ? 'plugin/scripts/lib/trace.mjs' : 'src/rogue.mjs';
    const execFn = async (cmd, args) => {
      const j = args.join(' ');
      if (cmd === 'git' && j.includes('rev-parse')) return { ok: true, stdout: 'feat/74-x\n' };
      if (cmd === 'git' && j.includes('diff')) return { ok: true, stdout: touched + '\n' };
      if (cmd === 'gh') return { ok: true, stdout: '**started** go\n**plan** x\n**pr** y\n' };
      return { ok: false, stdout: '', stderr: 'unrouted' };
    };
    return { cwd, execFn };
  }

  it('AC-C6.3: prints timeline + badge; green → conforming true (exit 0)', async () => {
    const { cwd, execFn } = await repo(true);
    const lines = [];
    const r = await runTrace(cwd, { execFn }, (m) => lines.push(m));
    expect(r.conforming).toBe(true);
    expect(r.badge.level).toBe('green');
    expect(lines.join('\n')).toMatch(/conformance: green/);
    expect(lines.join('\n')).toMatch(/plan:/);
  });

  it('AC-C6.3: off-plan file → amber, conforming false (exit 1)', async () => {
    const { cwd, execFn } = await repo(false);
    const r = await runTrace(cwd, { execFn }, noop);
    expect(r.conforming).toBe(false);
    expect(r.badge.failing).toBe('files-in-scope');
  });
});
