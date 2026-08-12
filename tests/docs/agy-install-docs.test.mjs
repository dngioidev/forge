import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

describe('#423 — AGY install docs', () => {
  it('AC-423.1: site/index.html surfaces Antigravity as an install path in the #install section', async () => {
    const html = await readFile(join(repoRoot, 'site', 'index.html'), 'utf8');
    const installSection = html.slice(html.indexOf('id="install"'), html.indexOf('</section>', html.indexOf('id="install"')));
    expect(installSection).toMatch(/Antigravity/);
    expect(installSection).toContain('plugin/scripts/init.mjs --host agy');
    expect(installSection).toContain('docs/guides/cross-gai.md');
  });

  it('AC-423.2: docs/guides/install.md splits Step 1 into Claude Code and Antigravity (agy) subsections', async () => {
    const guide = await readFile(join(repoRoot, 'docs', 'guides', 'install.md'), 'utf8');
    expect(guide).toContain('### Claude Code');
    expect(guide).toContain('### Antigravity (agy)');
    // #433 (AC-433.2): the emit command runs from the consumer's project dir with an
    // absolute path to the checkout's emitter — NOT the bare relative form asserted
    // here before #433, which encoded the wrong-cwd bug (init.mjs:56 resolves the dest
    // relative to cwd, not the forge source). Reviewer sign-off (spec §13): asserting
    // the old bare-relative string forever would re-lock the bug #433 fixes, so this
    // assertion is updated to the corrected absolute-path invocation.
    expect(guide).toContain('node C:\\tools\\forge\\plugin\\scripts\\init.mjs --host agy');
    expect(guide).toMatch(/\[Cross-GAI guide\]\(cross-gai\.md\)/);
    // does not duplicate the Claude-Code slash/terminal command pair for agy
    const agySection = guide.slice(guide.indexOf('### Antigravity (agy)'));
    expect(agySection).not.toContain('/plugin marketplace add');
    expect(agySection).not.toContain('claude plugin marketplace add');
  });

  it('AC-423.3: the prerequisites table cross-references agy users to the Antigravity subsection', async () => {
    const guide = await readFile(join(repoRoot, 'docs', 'guides', 'install.md'), 'utf8');
    const beforeStep1 = guide.slice(0, guide.indexOf('## 1. Install the plugin'));
    expect(beforeStep1).toMatch(/Running Antigravity instead of Claude Code/);
    expect(beforeStep1).toContain('agy --version');
    expect(beforeStep1).toMatch(/\[Antigravity \(agy\)\]\(#antigravity-agy\)/);
  });
});
