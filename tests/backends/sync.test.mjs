import { describe, it, expect } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runSync, IGNORE_RULES } from '../../plugin/scripts/backends/sync.mjs';

const noop = () => {};

async function cwdWithConfig(conventions = { verify: 'pnpm verify', shell: 'windows' }) {
  const dir = await mkdtemp(join(tmpdir(), 'forge-sync-'));
  await mkdir(join(dir, '.claude'), { recursive: true });
  await writeFile(join(dir, '.claude', 'forge.json'), JSON.stringify({
    board: { projectNumber: 8, projectId: 'PVT_x', fields: {
      status: { id: 'PVTSSF_1', options: { backlog: 'a' } },
      priority: { id: 'PVTSSF_2', options: { p0: 'b' } },
      size: { id: 'PVTSSF_3', options: { s: 'c' } },
      type: { id: 'PVTSSF_4', options: { epic: 'd' } },
    } },
    conventions,
  }), 'utf8');
  return dir;
}

describe('backends sync (AC-4.5)', () => {
  it('writes managed blocks with conventions + shell rules into both context files', async () => {
    const cwd = await cwdWithConfig({ verify: 'npm run check', shell: 'windows' });
    const res = await runSync({ cwd, log: noop });
    expect(res.ok).toBe(true);
    for (const f of ['GEMINI.md', 'AGENTS.md']) {
      const text = await readFile(join(cwd, f), 'utf8');
      expect(text).toContain('forge:context:begin');
      expect(text).toContain('npm run check');
      expect(text).toContain('argv arrays');
    }
  });

  it('hand-written content outside the block survives re-sync', async () => {
    const cwd = await cwdWithConfig();
    await writeFile(join(cwd, 'GEMINI.md'), '# My notes\nKeep me.\n', 'utf8');
    await runSync({ cwd, log: noop });
    await runSync({ cwd, log: noop }); // idempotent
    const text = await readFile(join(cwd, 'GEMINI.md'), 'utf8');
    expect(text).toContain('Keep me.');
    expect(text.match(/forge:context:begin/g).length).toBe(1);
  });

  it('ignore files carry the full secret-path rule set incl. tfstate', async () => {
    const cwd = await cwdWithConfig();
    await runSync({ cwd, log: noop });
    for (const f of ['.geminiignore', '.codexignore']) {
      const text = await readFile(join(cwd, f), 'utf8');
      for (const rule of IGNORE_RULES) expect(text, `${f} missing ${rule}`).toContain(rule);
    }
    expect(IGNORE_RULES).toContain('*.tfstate');
    expect(IGNORE_RULES).toContain('.forge/');
  });

  it('appends only missing rules to an existing ignore file', async () => {
    const cwd = await cwdWithConfig();
    await writeFile(join(cwd, '.geminiignore'), 'my-custom-dir/\n.env*\n', 'utf8');
    await runSync({ cwd, log: noop });
    const text = await readFile(join(cwd, '.geminiignore'), 'utf8');
    expect(text).toContain('my-custom-dir/');
    expect(text.match(/^\.env\*$/gm).length).toBe(1);
  });
});
