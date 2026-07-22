import { describe, it, expect } from 'vitest';
import { readFile, access } from 'node:fs/promises';
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

describe('license distribution metadata (#170)', () => {
  it('AC-170.1 a LICENSE file exists at repo root with verbatim MIT text', async () => {
    await expect(access(join(root, 'LICENSE'))).resolves.toBeUndefined();
    const text = (await readFile(join(root, 'LICENSE'), 'utf8')).replace(/\r\n/g, '\n');
    // Canonical MIT License body (SPDX: MIT) — full-text match, not a spot-check,
    // so any accidental edit to the warranty/liability paragraphs is caught.
    const canonical = `MIT License

Copyright (c) 2026 dngioi.dev

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
`;
    expect(text).toBe(canonical);
  });

  it('AC-170.2 both manifests declare license: MIT and match', async () => {
    const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
    const plugin = JSON.parse(await readFile(join(root, 'plugin', '.claude-plugin', 'plugin.json'), 'utf8'));
    expect(pkg.license).toBe('MIT');
    expect(plugin.license).toBe('MIT');
    expect(pkg.license).toBe(plugin.license);
  });
});
