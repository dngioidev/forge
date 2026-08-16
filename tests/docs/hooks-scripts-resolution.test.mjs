import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const spikePath = join(repoRoot, 'docs', 'spikes', '2026-08-16-hooks-scripts-resolution.md');
const routeIndexPath = join(repoRoot, 'docs', 'README.md');
const hooksJsonPath = join(repoRoot, 'plugin', 'hooks', 'hooks.json');
const denylistPath = join(repoRoot, 'plugin', 'hooks', 'denylist.mjs');

describe('#519 — hooks/scripts working-tree-vs-cache resolution spike (for #484)', () => {
  it('AC-519.1: establishes the shared root mechanism with direct evidence, not inference', async () => {
    const doc = await readFile(spikePath, 'utf8');
    expect(doc).toMatch(/## 1\. Facts/);
    expect(doc).toContain('${CLAUDE_PLUGIN_ROOT}');
    // this session's own empty env var, confirmed live
    expect(doc).toContain('CLAUDE_PLUGIN_ROOT=$CLAUDE_PLUGIN_ROOT');
    // the live Skill-tool substitution evidence, pinned to the actual installed version
    expect(doc).toContain('1.3.0');
    expect(doc).toMatch(/one mechanism, not two/i);
  });

  it('AC-519.1: the two surfaces are shown to diverge in available levers, not in resolution mechanism', async () => {
    const doc = await readFile(spikePath, 'utf8');
    expect(doc).toMatch(/no path-selection lever|no such escape hatch|has no such lever/i);
    expect(doc).toMatch(/ledger\.mjs/);
  });

  it('AC-519.2: link mode is tested against this exact harness and found platform-dead', async () => {
    const doc = await readFile(spikePath, 'utf8');
    expect(doc).toMatch(/mode: "link"/);
    expect(doc).toContain("doesn't support link mode on Windows and refuses to install a link-mode plugin there");
    expect(doc).toMatch(/v2\.1\.229/);
  });

  it('AC-519.2: local-path marketplace is shown to shorten, not eliminate, the staleness window', async () => {
    const doc = await readFile(spikePath, 'utf8');
    expect(doc).toMatch(/shortens the staleness window|shorten.*window/i);
    expect(doc).toMatch(/does not eliminate it|does not achieve live resolution/i);
  });

  it('AC-519.2: the DIY junction mechanism is empirically probed in isolation with quoted raw output', async () => {
    const doc = await readFile(spikePath, 'utf8');
    expect(doc).toContain('mklink /J');
    expect(doc).toContain('v1 from working tree');
    expect(doc).toContain('v2 EDITED after junction was created, no reinstall/update step');
    expect(doc).toMatch(/no admin\/elevation required/i);
  });

  it('AC-519.2: a mechanism absent from the original escalation (parallel hook composition) is identified and sourced', async () => {
    const doc = await readFile(spikePath, 'utf8');
    expect(doc).toMatch(/run in parallel/);
    expect(doc).toContain('CLAUDE_PROJECT_DIR');
    expect(doc).toMatch(/not named in the (original )?escalation/i);
  });

  it('AC-519.3: the denylist fail-open behaviour is cited from the actual source, not assumed', async () => {
    const doc = await readFile(spikePath, 'utf8');
    expect(doc).toMatch(/fail open/i);
    expect(doc).toContain('process.exit(0)');
    // the open question this spike explicitly did not settle
    expect(doc).toMatch(/[Nn]ot established in this time-box/);
  });

  it('AC-519.4: the recommendation is split and surface-specific, not a manufactured single verdict', async () => {
    const doc = await readFile(spikePath, 'utf8');
    expect(doc).toMatch(/## 4\. Recommendation/);
    expect(doc).toMatch(/does not support picking option 1, 2, or 3.*cleanly/i);
    expect(doc).toMatch(/share a root cause but not a best fix/i);
    // named, concrete follow-ups rather than a false sense of closure
    expect(doc).toMatch(/What would still need to happen/);
  });

  it('the spike doc and its plan are linked from the docs route index', async () => {
    const index = await readFile(routeIndexPath, 'utf8');
    expect(index).toContain('spikes/2026-08-16-hooks-scripts-resolution.md');
    expect(index).toContain('plans/2026-08-16-519-hooks-scripts-resolution.md');
  });

  it('this is genuinely a spike: no live hook/plugin resolution source was touched', async () => {
    // The spike's premise is "establish facts and recommend, do not implement an
    // install-model change" — pin that the actual hook wiring is untouched, so a
    // future branch can't quietly slip a resolution-order change into this scope.
    const hooksJson = await readFile(hooksJsonPath, 'utf8');
    expect(hooksJson).toContain('${CLAUDE_PLUGIN_ROOT}/hooks/denylist.mjs');
    const denylist = await readFile(denylistPath, 'utf8');
    expect(denylist).toContain('// fail open');
  });
});
