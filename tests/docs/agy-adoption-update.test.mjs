import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const installPath = join(repoRoot, 'docs', 'guides', 'install.md');
const crossGaiPath = join(repoRoot, 'docs', 'guides', 'cross-gai.md');
const routeIndexPath = join(repoRoot, 'docs', 'README.md');

describe('#433 — agy consumer adoption + update story', () => {
  it('AC-433.1: install.md gives a no-Claude-subscription adopter a complete path: clone, then emit from the project dir', async () => {
    const guide = await readFile(installPath, 'utf8');
    const agySection = guide.slice(guide.indexOf('### Antigravity (agy)'));
    // Gap 1: the adopter is told to obtain a checkout — not left to infer it.
    expect(agySection).toMatch(/git clone https:\/\/github\.com\/dngioidev\/forge/);
    // Gap 2: emit runs from the project directory, with an absolute path to the
    // checkout's emitter — never a bare relative path that would resolve against
    // the checkout itself (init.mjs:56 resolves the dest relative to cwd).
    expect(agySection).toMatch(/cd C:\\my\\project/);
    expect(agySection).toContain('node C:\\tools\\forge\\plugin\\scripts\\init.mjs --host agy');
    expect(agySection).toMatch(/current working directory/);
  });

  it('AC-433.2: the wrong-cwd "From a forge checkout" framing is gone from both install.md and cross-gai.md', async () => {
    const install = await readFile(installPath, 'utf8');
    const crossGai = await readFile(crossGaiPath, 'utf8');
    expect(install).not.toMatch(/From a forge checkout/);
    expect(crossGai).not.toMatch(/From a forge checkout/);
    expect(crossGai).not.toMatch(/from the forge plugin source/);
    // cross-gai.md's Step 1 now states the correct cwd rule explicitly.
    const step1 = crossGai.slice(crossGai.indexOf('## Step 1'));
    expect(step1).toMatch(/current working directory/);
    expect(step1).toMatch(/not from inside the forge checkout/);
  });

  it('AC-433.3: an update path is documented that reuses the existing emitter, covering both in-place and copy-install', async () => {
    const install = await readFile(installPath, 'utf8');
    const crossGai = await readFile(crossGaiPath, 'utf8');
    expect(install).toMatch(/Updating later/);
    expect(install).toMatch(/no separate update command/);
    expect(crossGai).toMatch(/Updating the emitted package/);
    expect(crossGai).toMatch(/agy plugin install "<out-dir>"/);
  });

  it('AC-433.4: the committed-package decision is documented, and .gitignore never gains an .agents/ entry', async () => {
    const install = await readFile(installPath, 'utf8');
    const agySection = install.slice(install.indexOf('### Antigravity (agy)'));
    expect(agySection).toMatch(/meant to be committed/);
    expect(agySection).toMatch(/never `\.agents\/`/);
    // init.mjs source itself: only .forge/ is ever added.
    const initSrc = await readFile(join(repoRoot, 'plugin', 'scripts', 'init.mjs'), 'utf8');
    const gitignoreBlock = initSrc.slice(initSrc.indexOf('// 7. .gitignore'), initSrc.indexOf('// 7b.'));
    expect(gitignoreBlock).toContain('.forge/');
    expect(gitignoreBlock).not.toMatch(/\.agents\//);
  });

  it('AC-433.5: the emitted version is surfaced via plugin.json, with automated staleness detection deferred to #431', async () => {
    const install = await readFile(installPath, 'utf8');
    const crossGai = await readFile(crossGaiPath, 'utf8');
    expect(install).toContain('plugin.json');
    expect(install).toMatch(/`version` field/);
    expect(install).toContain('#431');
    expect(crossGai).toContain('#431');
  });

  it('this plan is linked from the docs route index', async () => {
    const index = await readFile(routeIndexPath, 'utf8');
    expect(index).toContain('plans/2026-08-12-433-agy-adoption-update.md');
  });
});
