import { describe, it, expect } from 'vitest';
import { findWeakenings, runTestIntent } from '../../plugin/scripts/gates/testintent.mjs';

const noop = () => {};

const DIFF_WEAKENED = [
  'diff --git a/tests/a.test.mjs b/tests/a.test.mjs',
  '--- a/tests/a.test.mjs',
  '+++ b/tests/a.test.mjs',
  '@@ -10,1 +10,0 @@',
  "-    expect(res.ok).toBe(true);",
  '@@ -20,0 +20,1 @@',
  "+    const x = 1;",
].join('\n');

const DIFF_ADDITIONS_ONLY = [
  '--- a/tests/a.test.mjs',
  '+++ b/tests/a.test.mjs',
  '@@ -20,0 +20,2 @@',
  "+    expect(more.coverage).toBe(true);",
  "+    expect(extra).toEqual(1);",
].join('\n');

describe('test-intent gate (AC-5.5)', () => {
  it('flags removed assertion lines in pre-existing test files', () => {
    const w = findWeakenings(DIFF_WEAKENED, []);
    expect(w.length).toBe(1);
    expect(w[0]).toMatchObject({ file: 'tests/a.test.mjs' });
    expect(w[0].line).toContain('expect(res.ok)');
  });

  it('pure additions pass; new test files pass entirely', () => {
    expect(findWeakenings(DIFF_ADDITIONS_ONLY, [])).toEqual([]);
    expect(findWeakenings(DIFF_WEAKENED, ['tests/a.test.mjs'])).toEqual([]); // whole file is new
  });

  it('non-assertion removals (setup lines) pass', () => {
    const diff = ['+++ b/tests/a.test.mjs', "-    const helper = makeHelper();"].join('\n');
    expect(findWeakenings(diff, [])).toEqual([]);
  });

  it('runTestIntent wires git diffs and fails on weakenings', async () => {
    const execFn = async (cmd, args) => {
      if (args.includes('--name-status')) return { ok: true, stdout: 'M\ttests/a.test.mjs\n', stderr: '' };
      return { ok: true, stdout: DIFF_WEAKENED, stderr: '' };
    };
    const res = await runTestIntent({ cwd: '.', execFn, log: noop });
    expect(res.ok).toBe(false);
    expect(res.weakenings.length).toBe(1);

    const clean = async (cmd, args) => ({ ok: true, stdout: args.includes('--name-status') ? 'A\ttests/new.test.mjs\n' : DIFF_ADDITIONS_ONLY, stderr: '' });
    const pass = await runTestIntent({ cwd: '.', execFn: clean, log: noop });
    expect(pass.ok).toBe(true);
  });
});
