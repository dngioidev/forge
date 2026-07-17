import { describe, it, expect } from 'vitest';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { extractPlanFiles, isAllowed, runPlanDrift, DEFAULT_ALLOW } from '../../plugin/scripts/gates/plandrift.mjs';

const noop = () => {};

describe('plan-drift gate (AC-5.3)', () => {
  it('extracts Files lists from plan tasks (files, dirs, backticks)', () => {
    const plan = '### T1\n**Files:** `plugin/scripts/lib/ledger.mjs`, tests/lib/ledger.test.mjs\n### T2\n**Files:** plugin/scripts/gates/ , docs/x.md';
    const files = extractPlanFiles(plan);
    expect(files).toContain('plugin/scripts/lib/ledger.mjs');
    expect(files).toContain('plugin/scripts/gates/');
  });

  it('isAllowed: declared exact + dir prefixes + scope extras + default allow', () => {
    const declared = ['src/a.mjs', 'src/widgets/'];
    expect(isAllowed('src/a.mjs', declared, [], DEFAULT_ALLOW)).toBe(true);
    expect(isAllowed('src/widgets/deep/b.mjs', declared, [], DEFAULT_ALLOW)).toBe(true);
    expect(isAllowed('tests/anything.test.mjs', declared, [], DEFAULT_ALLOW)).toBe(true);
    expect(isAllowed('src/rogue.mjs', declared, [], DEFAULT_ALLOW)).toBe(false);
    expect(isAllowed('src/rogue.mjs', declared, ['src/rogue.mjs'], DEFAULT_ALLOW)).toBe(true);
  });

});

describe('plan-drift end-to-end', () => {
  const noop2 = () => {};
  async function setup(planBody) {
    const cwd = await mkdtemp(join(tmpdir(), 'forge-drift-'));
    await mkdir(join(cwd, 'docs'), { recursive: true });
    await writeFile(join(cwd, 'docs', 'plan.md'), planBody, 'utf8');
    return cwd;
  }
  const gitWith = (files) => async (cmd, args) => ({ ok: true, stdout: files.join('\n') + '\n', stderr: '' });

  it('names deviations and fails', async () => {
    const cwd = await setup('### T1\n**Files:** src/a.mjs\n');
    const res = await runPlanDrift({ cwd, planPath: 'docs/plan.md', execFn: gitWith(['src/a.mjs', 'src/rogue.mjs']), log: noop2 });
    expect(res.ok).toBe(false);
    expect(res.deviations).toEqual(['src/rogue.mjs']);
  });

  it('scope.json extension + default-allowed dirs pass', async () => {
    const cwd = await setup('### T1\n**Files:** src/a.mjs\n');
    await mkdir(join(cwd, '.forge'), { recursive: true });
    await writeFile(join(cwd, '.forge', 'scope.json'), JSON.stringify({ files: ['src/extra.mjs'] }), 'utf8');
    const res = await runPlanDrift({ cwd, planPath: 'docs/plan.md', execFn: gitWith(['src/a.mjs', 'src/extra.mjs', 'tests/a.test.mjs', 'docs/notes.md']), log: noop2 });
    expect(res).toMatchObject({ ok: true, deviations: [] });
  });

  it('refuses a plan with no Files lists', async () => {
    const cwd = await setup('# plan with no file contract\n');
    const res = await runPlanDrift({ cwd, planPath: 'docs/plan.md', execFn: gitWith([]), log: noop2 });
    expect(res.ok).toBe(false);
    expect(res.error).toContain('**Files:**');
  });
});
