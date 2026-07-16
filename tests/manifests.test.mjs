import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

describe('plugin manifests (AC-1.1 structural half)', () => {
  it('marketplace.json parses and points at the plugin dir', async () => {
    const m = JSON.parse(await readFile(join(root, '.claude-plugin', 'marketplace.json'), 'utf8'));
    expect(m.name).toBe('forge');
    expect(Array.isArray(m.plugins)).toBe(true);
    expect(m.plugins[0]).toMatchObject({ name: 'forge', source: './plugin' });
  });

  it('plugin.json parses with required keys', async () => {
    const p = JSON.parse(await readFile(join(root, 'plugin', '.claude-plugin', 'plugin.json'), 'utf8'));
    expect(p.name).toBe('forge');
    expect(p.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(typeof p.description).toBe('string');
  });

  it('command files exist for every /forge:<verb> the plugin claims', async () => {
    for (const cmd of ['init', 'doctor']) {
      const md = await readFile(join(root, 'plugin', 'commands', `${cmd}.md`), 'utf8');
      expect(md.length).toBeGreaterThan(50);
    }
  });
});
