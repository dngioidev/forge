import { describe, it, expect } from 'vitest';
import { run, makeGh } from '../../plugin/scripts/lib/exec.mjs';

describe('run', () => {
  it('runs a real process and captures stdout', async () => {
    const res = await run(process.execPath, ['-e', 'console.log("hi")']);
    expect(res.ok).toBe(true);
    expect(res.stdout.trim()).toBe('hi');
  });

  it('reports nonzero exit codes as not ok', async () => {
    const res = await run(process.execPath, ['-e', 'process.exit(3)']);
    expect(res.ok).toBe(false);
    expect(res.code).toBe(3);
  });

  it('resolves (never throws) for a missing binary', async () => {
    const res = await run('definitely-not-a-real-binary-xyz', []);
    expect(res.ok).toBe(false);
    expect(res.code).toBe(-1);
  });

  it('the .cmd EINVAL lesson: cmd scripts are routed through cmd.exe on Windows', async function () {
    if (process.platform !== 'win32') return; // Windows-only regression
    const { mkdtemp, writeFile } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = await mkdtemp(join(tmpdir(), 'forge-exec-'));
    const script = join(dir, 'hello.cmd');
    await writeFile(script, '@echo cmd-ok\r\n', 'utf8');
    const res = await run(script, []);
    expect(res.ok).toBe(true);
    expect(res.stdout).toContain('cmd-ok');
  });
});

describe('makeGh', () => {
  it('is injectable: consumers can script gh responses', async () => {
    const calls = [];
    const gh = makeGh(async (cmd, args) => {
      calls.push([cmd, ...args]);
      return { ok: true, code: 0, stdout: '{"title":"forge - AI dev platform"}', stderr: '' };
    });
    const res = await gh(['project', 'view', '8'], { parseJson: true });
    expect(calls[0][0]).toBe('gh');
    expect(res.json.title).toContain('forge');
  });

  it('flags unparseable JSON instead of throwing', async () => {
    const gh = makeGh(async () => ({ ok: true, code: 0, stdout: 'not json', stderr: '' }));
    const res = await gh(['x'], { parseJson: true });
    expect(res.ok).toBe(false);
    expect(res.json).toBe(null);
  });
});
