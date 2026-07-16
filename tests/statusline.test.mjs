import { describe, it, expect } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { run } from '../plugin/scripts/lib/exec.mjs';

const script = join(dirname(fileURLToPath(import.meta.url)), '..', 'plugin', 'scripts', 'statusline.mjs');

async function runStatusline(payload) {
  const { spawn } = await import('node:child_process');
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [script], { windowsHide: true });
    let stdout = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.on('close', (code) => resolve({ code, stdout }));
    child.stdin.write(JSON.stringify(payload));
    child.stdin.end();
  });
}

async function gitRepoOnBranch(branch) {
  const dir = await mkdtemp(join(tmpdir(), 'forge-sl-'));
  await run('git', ['-C', dir, 'init', '-q', '-b', 'main']);
  await run('git', ['-C', dir, 'config', 'user.email', 't@t.t']);
  await run('git', ['-C', dir, 'config', 'user.name', 't']);
  await run('git', ['-C', dir, 'commit', '--allow-empty', '-q', '-m', 'x']);
  if (branch !== 'main') await run('git', ['-C', dir, 'checkout', '-q', '-b', branch]);
  return dir;
}

describe('statusline (AC-1.5)', () => {
  it('prints forge #<ticket> <branch> on a work branch', async () => {
    const dir = await gitRepoOnBranch('feat/12-widget');
    const res = await runStatusline({ workspace: { current_dir: dir } });
    expect(res.code).toBe(0);
    expect(res.stdout).toBe('forge #12 feat/12-widget');
  });

  it('prints forge <branch> when the branch has no ticket', async () => {
    const dir = await gitRepoOnBranch('main');
    const res = await runStatusline({ workspace: { current_dir: dir } });
    expect(res.code).toBe(0);
    expect(res.stdout).toBe('forge main');
  });

  it('never breaks the session: non-git dir -> empty output, exit 0', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'forge-sl-'));
    const res = await runStatusline({ workspace: { current_dir: dir } });
    expect(res.code).toBe(0);
    expect(res.stdout).toBe('');
  });

  it('never breaks the session: garbage stdin -> exit 0', async () => {
    const { spawn } = await import('node:child_process');
    const res = await new Promise((resolve) => {
      const child = spawn(process.execPath, [script], { windowsHide: true });
      let stdout = '';
      child.stdout.on('data', (d) => { stdout += d; });
      child.on('close', (code) => resolve({ code, stdout }));
      child.stdin.write('not json at all');
      child.stdin.end();
    });
    expect(res.code).toBe(0);
  });
});
