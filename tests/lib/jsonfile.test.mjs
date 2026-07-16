import { describe, it, expect } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readJson, writeJson, mergeJson } from '../../plugin/scripts/lib/jsonfile.mjs';

describe('jsonfile', () => {
  it('readJson returns null for missing files', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'forge-json-'));
    expect(await readJson(join(dir, 'nope.json'))).toBe(null);
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
});
