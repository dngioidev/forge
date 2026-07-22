import { describe, it, expect } from 'vitest';
import { vi } from 'vitest';
import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readJson, writeJson, mergeJson } from '../../plugin/scripts/lib/jsonfile.mjs';

describe('jsonfile', () => {
  it('AC-185.1: readJson returns null for a MISSING file (ENOENT)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'forge-json-'));
    expect(await readJson(join(dir, 'nope.json'))).toBe(null);
  });

  it('AC-185.3: readJson PROPAGATES a non-ENOENT read error (EACCES) — not silently null', async () => {
    // A genuine I/O error on an EXISTING file (permission denied, lock, AV) must
    // surface, not be swallowed as "absent" — the silent-data-loss class #185/#164
    // guards against. Inject a readFile that throws a coded EACCES to hit the branch
    // (a real EACCES is hard to force portably on Windows).
    vi.resetModules();
    vi.doMock('node:fs/promises', async (orig) => {
      const actual = await orig();
      const eacces = Object.assign(new Error('permission denied'), { code: 'EACCES' });
      return { ...actual, readFile: async () => { throw eacces; } };
    });
    try {
      const { readJson: throwingRead } = await import('../../plugin/scripts/lib/jsonfile.mjs');
      await expect(throwingRead(join(tmpdir(), 'exists-but-locked.json'))).rejects.toMatchObject({ code: 'EACCES' });
    } finally {
      vi.doUnmock('node:fs/promises');
      vi.resetModules();
    }
  });

  it('AC-185.1: readJson still throws a SyntaxError on broken JSON (unchanged)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'forge-json-'));
    const p = join(dir, 'broken.json');
    await writeFile(p, '{ not: valid json', 'utf8');
    await expect(readJson(p)).rejects.toBeInstanceOf(SyntaxError);
  });

  it('writeJson creates parent directories and round-trips', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'forge-json-'));
    const p = join(dir, 'a', 'b', 'x.json');
    await writeJson(p, { hello: 1 });
    expect(await readJson(p)).toEqual({ hello: 1 });
  });

  it('AC-1.5: mergeJson never clobbers unrelated keys (settings no-clobber)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'forge-json-'));
    const p = join(dir, 'settings.json');
    await writeJson(p, {
      permissions: { allow: ['Bash(pnpm verify)'] },
      env: { FOO: 'bar' },
      statusLine: { type: 'command', command: 'old-command' },
    });
    await mergeJson(p, { statusLine: { type: 'command', command: 'node statusline.mjs' } });
    const after = await readJson(p);
    expect(after.permissions.allow).toEqual(['Bash(pnpm verify)']);
    expect(after.env.FOO).toBe('bar');
    expect(after.statusLine.command).toBe('node statusline.mjs');
  });

  it('mergeJson creates the file when missing', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'forge-json-'));
    const p = join(dir, 'new.json');
    const merged = await mergeJson(p, { a: { b: 2 } });
    expect(merged).toEqual({ a: { b: 2 } });
    expect(await readJson(p)).toEqual({ a: { b: 2 } });
  });

  it('deep-merges nested objects but replaces arrays and scalars', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'forge-json-'));
    const p = join(dir, 'deep.json');
    await writeJson(p, { a: { keep: 1, replace: [1, 2] }, s: 'x' });
    await mergeJson(p, { a: { replace: [3] }, s: 'y' });
    expect(await readJson(p)).toEqual({ a: { keep: 1, replace: [3] }, s: 'y' });
  });

  it('AC-B164.1: writeJson is atomic (temp+rename) — no partial/temp file survives a completed write', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'forge-json-'));
    const p = join(dir, 'run.json');
    await writeJson(p, { version: 1, big: 'x'.repeat(4096) });
    // The directory holds ONLY the final file — the temp sibling was renamed away,
    // so a crash between temp-write and rename can never truncate the target.
    expect(await readdir(dir)).toEqual(['run.json']);
    // The rename is the publish step: the target always parses as complete JSON.
    expect(await readJson(p)).toMatchObject({ version: 1 });
  });

  it('AC-B164.1: writeJson replaces an existing file in place without leaving a temp turd', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'forge-json-'));
    const p = join(dir, 'run.json');
    await writeJson(p, { version: 1, n: 1 });
    await writeJson(p, { version: 1, n: 2 });
    expect(await readdir(dir)).toEqual(['run.json']);
    expect((await readFile(p, 'utf8')).endsWith('\n')).toBe(true);
    expect(await readJson(p)).toEqual({ version: 1, n: 2 });
  });

  it('AC-B164.1: a crash before the atomic publish leaves the previous file intact (never truncated)', async () => {
    // Model the R1 failure: the process dies after the new bytes are staged but
    // before they are published. With temp+rename, the publish (rename) is the
    // only mutation of the target — kill it and the OLD file survives whole.
    vi.resetModules();
    vi.doMock('node:fs/promises', async (orig) => {
      const actual = await orig();
      return { ...actual, rename: async () => { throw new Error('simulated crash before publish'); } };
    });
    try {
      const { writeJson: atomicWrite } = await import('../../plugin/scripts/lib/jsonfile.mjs');
      const dir = await mkdtemp(join(tmpdir(), 'forge-json-'));
      const p = join(dir, 'run.json');
      await writeFile(p, JSON.stringify({ version: 1, n: 1 }) + '\n', 'utf8'); // seed a valid file
      // A non-atomic writeJson (writeFile straight to target) would clobber it and NOT throw;
      // the atomic one throws on the failed publish and leaves the original whole.
      await expect(atomicWrite(p, { version: 1, n: 2 })).rejects.toThrow();
      expect(JSON.parse(await readFile(p, 'utf8'))).toEqual({ version: 1, n: 1 });
    } finally {
      vi.doUnmock('node:fs/promises');
      vi.resetModules();
    }
  });
});
