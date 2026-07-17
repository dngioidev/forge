import { describe, it, expect } from 'vitest';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { classify, isReadOnly, extractExit, lastErrLine, currentBranch } from '../../plugin/hooks/capture.mjs';

const fail = (cmd, response = { exitCode: 1, stderr: 'boom\nERR_FAIL: it broke' }) => ({
  tool_name: 'Bash',
  tool_input: { command: cmd },
  tool_response: response,
});

describe('capture hook — cmd-fail (AC-7.1)', () => {
  it('AC-7.1: failing non-read-only command captured with branch/ticket and err_line', () => {
    const res = classify(fail('pnpm verify'), 'feat/9-learning-loop');
    expect(res.capture).toBe(true);
    expect(res.kind).toBe('cmd-fail');
    expect(res.data).toMatchObject({
      tool: 'Bash', cmd: 'pnpm verify', exit: 1,
      err_line: 'ERR_FAIL: it broke', ticket: '#9', branch: 'feat/9-learning-loop',
    });
  });

  it('AC-7.1: read-only failures are excluded at capture time', () => {
    for (const cmd of [
      'grep -rn missing src/',
      'git log --oneline -5',
      'gh pr view 23 --json state',
      'export PATH="/x:$PATH"; git status && git diff --stat',
      'ls nonexistent | head -3',
    ]) {
      expect(classify(fail(cmd), 'feat/9-learning-loop')).toEqual({ capture: false });
    }
  });

  it('AC-7.1: a compound with any non-read-only segment still captures', () => {
    const res = classify(fail('git status && pnpm verify'), 'feat/9-learning-loop');
    expect(res.capture).toBe(true);
  });

  it('AC-7.1: no determinable exit code, success, or non-Bash captures nothing', () => {
    expect(classify(fail('pnpm verify', { stdout: 'weird shape' }))).toEqual({ capture: false });
    expect(classify(fail('pnpm verify', { exitCode: 0, stdout: 'ok' }))).toEqual({ capture: false });
    expect(classify({ tool_name: 'Read', tool_input: {}, tool_response: {} })).toEqual({ capture: false });
  });

  it('extractExit handles the shapes the harness may send', () => {
    expect(extractExit({ exitCode: 3 })).toBe(3);
    expect(extractExit({ exit_code: 2 })).toBe(2);
    expect(extractExit({ error: 'Command failed. Exit code 127' })).toBe(127);
    expect(extractExit('process exited with code 1')).toBe(1);
    expect(extractExit({ is_error: true, stderr: 'x' })).toBe(1);
    expect(extractExit({ stdout: 'fine' })).toBe(null);
  });

  it('err_line prefers stderr, falls back, truncates', () => {
    expect(lastErrLine({ stderr: 'a\nb\n\n', stdout: 'c' })).toBe('b');
    expect(lastErrLine({ stdout: 'only stdout line' })).toBe('only stdout line');
    expect(lastErrLine({ stderr: 'x'.repeat(300) }).length).toBe(200);
  });

  it('isReadOnly: gh mutations and bare writes are not read-only', () => {
    expect(isReadOnly('gh pr create --title x')).toBe(false);
    expect(isReadOnly('node scripts/thing.mjs')).toBe(false);
    expect(isReadOnly('git push origin main')).toBe(false);
  });
});

describe('capture hook — gate-fail (AC-7.2)', () => {
  it('AC-7.2: a failing gate script is captured as gate-fail with the gate name', () => {
    const res = classify(fail('node "plugin/scripts/gates/plandrift.mjs" --plan docs/plans/x.md'), 'feat/9-learning-loop');
    expect(res.capture).toBe(true);
    expect(res.kind).toBe('gate-fail');
    expect(res.data.gate).toBe('plandrift');
  });

  it('AC-7.2: windows-style gate paths match too', () => {
    const res = classify(fail('node plugin\\scripts\\gates\\acgate.mjs --ticket 9'), null);
    expect(res.kind).toBe('gate-fail');
    expect(res.data.gate).toBe('acgate');
    expect(res.data.ticket).toBe(null);
  });
});

describe('capture hook — branch resolution', () => {
  it('reads the branch from .git/HEAD; detached or missing is null', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'forge-capture-'));
    await mkdir(join(dir, '.git'), { recursive: true });
    await writeFile(join(dir, '.git', 'HEAD'), 'ref: refs/heads/feat/9-learning-loop\n', 'utf8');
    expect(await currentBranch(dir)).toBe('feat/9-learning-loop');
    await writeFile(join(dir, '.git', 'HEAD'), 'a1b2c3d4e5f6\n', 'utf8');
    expect(await currentBranch(dir)).toBe(null);
    expect(await currentBranch(join(dir, 'nope'))).toBe(null);
  });
});
