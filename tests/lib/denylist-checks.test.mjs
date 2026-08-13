import { describe, it, expect } from 'vitest';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkDenylistStaleness, ownPluginRoot, WORKING_TREE_DENYLIST_RELPATH } from '../../plugin/scripts/lib/denylist-checks.mjs';

async function tmpDir(prefix = 'denylist-checks-') {
  return mkdtemp(join(tmpdir(), prefix));
}

/** Build a fake plugin root: <root>/hooks/denylist.mjs + <root>/.claude-plugin/plugin.json. */
async function fakeRoot(content, version) {
  const root = await tmpDir('denylist-root-');
  await mkdir(join(root, 'hooks'), { recursive: true });
  await writeFile(join(root, 'hooks', 'denylist.mjs'), content, 'utf8');
  if (version) {
    await mkdir(join(root, '.claude-plugin'), { recursive: true });
    await writeFile(join(root, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'forge', version }), 'utf8');
  }
  return root;
}

/** Write a working-tree copy at <cwd>/plugin/hooks/denylist.mjs + <cwd>/plugin/.claude-plugin/plugin.json. */
async function writeWorkingTree(cwd, content, version) {
  const denylistPath = join(cwd, WORKING_TREE_DENYLIST_RELPATH);
  await mkdir(join(denylistPath, '..'), { recursive: true });
  await writeFile(denylistPath, content, 'utf8');
  if (version) {
    await mkdir(join(cwd, 'plugin', '.claude-plugin'), { recursive: true });
    await writeFile(join(cwd, 'plugin', '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'forge', version }), 'utf8');
  }
}

describe('denylist-checks — ownPluginRoot', () => {
  it('resolves two levels up from lib/denylist-checks.mjs (i.e. plugin/)', () => {
    const root = ownPluginRoot();
    expect(root.replace(/\\/g, '/')).toMatch(/\/plugin$/);
  });
});

describe('denylist-checks — checkDenylistStaleness (AC.3 silence contract)', () => {
  it('AC-447.3: no working-tree copy at all -> null (fully silent, plain consumer install shape)', async () => {
    const cwd = await tmpDir();
    const ownRoot = await fakeRoot('module.exports = {};', '1.3.0');
    expect(await checkDenylistStaleness({ cwd, ownRoot })).toBeNull();
  });

  it('AC-447.3: cwd has a plugin/ dir but no hooks/denylist.mjs inside it -> still silent', async () => {
    const cwd = await tmpDir();
    await mkdir(join(cwd, 'plugin', 'hooks'), { recursive: true });
    const ownRoot = await fakeRoot('module.exports = {};', '1.3.0');
    expect(await checkDenylistStaleness({ cwd, ownRoot })).toBeNull();
  });
});

describe('denylist-checks — checkDenylistStaleness (content comparison)', () => {
  it('AC-447.3: identical content, same version -> ok, names the live path', async () => {
    const cwd = await tmpDir();
    const rules = 'export const RULES = ["a", "b"];';
    await writeWorkingTree(cwd, rules, '1.3.0');
    const ownRoot = await fakeRoot(rules, '1.3.0');
    const row = await checkDenylistStaleness({ cwd, ownRoot });
    expect(row.level).toBe('ok');
    expect(row.msg).toContain(join(ownRoot, 'hooks', 'denylist.mjs'));
  });

  it('AC-447.3: BREAK IT: identical version but DIFFERENT content -> warn (the #447 ledger.mjs incident shape: version alone would have missed this)', async () => {
    const cwd = await tmpDir();
    await writeWorkingTree(cwd, 'export const RULES = ["a", "b", "c"]; // hardened', '1.3.0');
    const ownRoot = await fakeRoot('export const RULES = ["a", "b"];', '1.3.0'); // same version, stale content
    const row = await checkDenylistStaleness({ cwd, ownRoot });
    expect(row.level).toBe('warn');
    expect(row.msg).toContain(join(ownRoot, 'hooks', 'denylist.mjs'));
    expect(row.msg).toContain(join(cwd, WORKING_TREE_DENYLIST_RELPATH));
    expect(row.msg).toMatch(/v1\.3\.0/); // both sides claim the same version -- confirms this isn't a version-based compare
  });

  it('BREAK IT: different content AND different version -> warn, names both versions', async () => {
    const cwd = await tmpDir();
    await writeWorkingTree(cwd, 'export const RULES = ["a", "b", "c"];', '1.4.0');
    const ownRoot = await fakeRoot('export const RULES = ["a", "b"];', '1.3.0');
    const row = await checkDenylistStaleness({ cwd, ownRoot });
    expect(row.level).toBe('warn');
    expect(row.msg).toMatch(/v1\.4\.0/);
    expect(row.msg).toMatch(/v1\.3\.0/);
  });

  it('live plugin.json missing (unresolvable manifest) -> warn still fires, version reported as unknown rather than throwing', async () => {
    const cwd = await tmpDir();
    await writeWorkingTree(cwd, 'export const RULES = ["a"];', '1.3.0');
    const ownRoot = await fakeRoot('export const RULES = ["b"];'); // no version written
    const row = await checkDenylistStaleness({ cwd, ownRoot });
    expect(row.level).toBe('warn');
    expect(row.msg).toMatch(/vunknown/);
  });

  it('live denylist.mjs unreadable (ownRoot has no hooks/denylist.mjs) -> warn, never throws', async () => {
    const cwd = await tmpDir();
    await writeWorkingTree(cwd, 'export const RULES = ["a"];', '1.3.0');
    const ownRoot = await tmpDir('denylist-empty-root-'); // no hooks/ dir at all
    const row = await checkDenylistStaleness({ cwd, ownRoot });
    expect(row.level).toBe('warn');
    expect(row.msg).toMatch(/could not be read/);
  });
});
