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
    // #460 (AC-460.1): the bare relative form `plugin/scripts/init.mjs --host agy` is the
    // wrong-cwd bug install.md:52 warns about — running it from inside the forge checkout
    // emits into forge's own tree instead of the reader's project. The assertion below was
    // updated from that bare-relative string to the corrected absolute-path invocation (the
    // site highlights the `node` token in its own <span>, so the match tolerates that tag
    // rather than requiring "node C:\..." as one contiguous run of text).
    // Reviewer sign-off (spec §13): quoted verbatim in PR #<pr> body — real justification,
    // not a rubber stamp, since this weakens/replaces a pre-existing assertion.
    expect(installSection).toMatch(/node<\/span>\s+C:\\tools\\forge\\plugin\\scripts\\init\.mjs --host agy/);
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

// #460 — the landing page's agy install box silently diverged from install.md's corrected
// path (#433) because nothing pinned the two together. #423 added the box; #433 fixed the
// guide; this suite closes the loop so a third divergence fails CI instead of shipping.
describe('#460 — landing page agy install matches docs/guides/install.md', () => {
  it("AC-460.5: the site's agy emit command is pinned against install.md's corrected form, so the two can't re-diverge", async () => {
    const guide = await readFile(join(repoRoot, 'docs', 'guides', 'install.md'), 'utf8');
    const html = await readFile(join(repoRoot, 'site', 'index.html'), 'utf8');
    const installSection = html.slice(html.indexOf('id="install"'), html.indexOf('</section>', html.indexOf('id="install"')));
    const correctedCommand = 'node C:\\tools\\forge\\plugin\\scripts\\init.mjs --host agy';
    // the load-bearing part of the fix: the absolute path + args, which must be identical
    // on both sides. Checked as a substring, not the full "node ..." line, because the site
    // highlights the `node` token in its own <span>, breaking contiguity with the path.
    const correctedPathAndArgs = 'C:\\tools\\forge\\plugin\\scripts\\init.mjs --host agy';
    // sanity: the guide still says what we think it says (fails loudly if install.md's own
    // command changes and this test wasn't updated alongside it)
    expect(guide).toContain(correctedCommand);
    // the site must say the same thing — this is the anti-drift pin
    expect(installSection).toContain(correctedPathAndArgs);
    expect(installSection).toMatch(/node<\/span>\s+C:\\tools\\forge\\plugin\\scripts\\init\.mjs --host agy/);
    // the wrong-cwd bare-relative form (#460's bug) must not reappear anywhere in the box
    expect(installSection).not.toMatch(/node<\/span>\s+plugin\/scripts\/init\.mjs --host agy/);
    expect(installSection).not.toContain('>node</span> plugin/scripts/init.mjs --host agy');
  });

  it('AC-460.1: the site states the checkout prerequisite and the committed-.agents/ step, not just the emit command', async () => {
    const html = await readFile(join(repoRoot, 'site', 'index.html'), 'utf8');
    const installSection = html.slice(html.indexOf('id="install"'), html.indexOf('</section>', html.indexOf('id="install"')));
    // step 1: get a checkout
    expect(installSection).toMatch(/git<\/span>\s+clone https:\/\/github\.com\/dngioidev\/forge/);
    // step 2: run from the project dir (install.md:45 — "not from inside the forge checkout")
    expect(installSection.toLowerCase()).toContain('project');
    // step 3: commit what's emitted (install.md:54 — the owner decision that .agents/ is committed)
    expect(installSection).toMatch(/\.agents\/plugins\/forge/);
    expect(installSection.toLowerCase()).toContain('commit');
  });

  it('AC-460.2: agy on PATH is listed in the prerequisites wherever the agy path is offered', async () => {
    const html = await readFile(join(repoRoot, 'site', 'index.html'), 'utf8');
    const installSection = html.slice(html.indexOf('id="install"'), html.indexOf('</section>', html.indexOf('id="install"')));
    expect(installSection).toMatch(/<code>agy<\/code>\s*on PATH/);
  });

  it("AC-460.3: the agy path is not framed as one command, contradicting install.md's three-step framing", async () => {
    const html = await readFile(join(repoRoot, 'site', 'index.html'), 'utf8');
    const installSection = html.slice(html.indexOf('id="install"'), html.indexOf('</section>', html.indexOf('id="install"')));
    expect(installSection.toLowerCase()).not.toMatch(/one[- ]command/);
    expect(installSection.toLowerCase()).toMatch(/three steps/);
  });

  it('AC-460.4: the mechanical-gate count is 7, consistent between the stat tile and the gate grid, and does not fold in the adversarial reviewer/security passes', async () => {
    const html = await readFile(join(repoRoot, 'site', 'index.html'), 'utf8');
    const proofSection = html.slice(html.indexOf('class="proof"'), html.indexOf('</section>', html.indexOf('class="proof"')));
    expect(proofSection).toMatch(/<div class="n">7<\/div><div class="l">Mechanical gates<\/div>/);

    const gatesSection = html.slice(html.indexOf('id="gates"'), html.indexOf('</section>', html.indexOf('id="gates"')));
    const adversarialIdx = gatesSection.indexOf('Adversarial passes');
    expect(adversarialIdx).toBeGreaterThan(-1);
    const mechanicalGrid = gatesSection.slice(0, adversarialIdx);
    const adversarialGrid = gatesSection.slice(adversarialIdx);

    // the seven mechanical gates (README.md:46, cross-gai.md:577, decisions/0007:155) —
    // reviewer/security are model-driven adversarial passes, not mechanical scripts, so
    // they must not appear in the mechanical grid
    for (const gate of ['situation', 'conventions', 'plandrift', 'testintent', 'depguard', 'ac-gate', 'docsync']) {
      expect(mechanicalGrid).toContain(`>${gate}</div>`);
    }
    expect(mechanicalGrid).not.toMatch(/>reviewer<\/div>/);
    expect(mechanicalGrid).not.toMatch(/>security<\/div>/);
    expect(adversarialGrid).toContain('>reviewer</div>');
    expect(adversarialGrid).toContain('>security</div>');
  });

  it('AC-460.4: README.md still states seven gates, matching the site (guards the shared number, not just the site half)', async () => {
    const readme = await readFile(join(repoRoot, 'README.md'), 'utf8');
    expect(readme).toMatch(/the seven gates/);
  });
});
