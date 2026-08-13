import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const troubleshootingPath = join(repoRoot, 'docs', 'guides', 'troubleshooting.md');

describe('#447 AC.4 — denylist staleness subsection in troubleshooting.md §4', () => {
  it('AC-447.4: adds a staleness subsection inside §4 (Hooks not firing), not a new top-level section', async () => {
    const guide = await readFile(troubleshootingPath, 'utf8');
    const section4Start = guide.indexOf('## 4. Hooks not firing');
    const section5Start = guide.indexOf('## 5. Environment breaks');
    expect(section4Start).toBeGreaterThan(-1);
    expect(section5Start).toBeGreaterThan(section4Start);
    const section4 = guide.slice(section4Start, section5Start);
    expect(section4).toMatch(/### Denylist staleness/);
  });

  it('AC-447.4: documents the forge:doctor denylist-staleness check and its ok/warn/silent contract', async () => {
    const guide = await readFile(troubleshootingPath, 'utf8');
    const section = guide.slice(guide.indexOf('### Denylist staleness'), guide.indexOf('## 5. Environment breaks'));
    expect(section).toMatch(/denylist-staleness/);
    expect(section).toMatch(/`ok`/);
    expect(section).toMatch(/`warn`/);
    expect(section).toMatch(/silent/i);
    expect(section).toMatch(/plugin\.json/);
  });

  it('cross-links §1\'s existing reinstall ladder instead of duplicating its steps', async () => {
    const guide = await readFile(troubleshootingPath, 'utf8');
    const section = guide.slice(guide.indexOf('### Denylist staleness'), guide.indexOf('## 5. Environment breaks'));
    expect(section).toMatch(/#1-updated-the-plugin-but-changes-arent-visible/);
    // does not re-list the ladder's own steps (marketplace update / plugin update / reload / restart / nuclear) verbatim
    expect(section).not.toMatch(/plugin marketplace update forge/);
    expect(section).not.toMatch(/plugin uninstall forge/);
  });

  it('names #447 and #484 so the diagnostic-vs-decision split is traceable from the doc', async () => {
    const guide = await readFile(troubleshootingPath, 'utf8');
    const section = guide.slice(guide.indexOf('### Denylist staleness'), guide.indexOf('## 5. Environment breaks'));
    expect(section).toMatch(/#447/);
    expect(section).toMatch(/#484/);
  });
});
