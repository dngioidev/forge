import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const spikePath = join(repoRoot, 'docs', 'spikes', '2026-08-13-agy-file-write-gating.md');
const crossGaiPath = join(repoRoot, 'docs', 'guides', 'cross-gai.md');
const routeIndexPath = join(repoRoot, 'docs', 'README.md');
const denylistPath = join(repoRoot, 'plugin', 'hooks', 'denylist.mjs');
const emitPath = join(repoRoot, 'plugin', 'scripts', 'agy', 'emit.mjs');

describe('#436 — agy file-write gating spike', () => {
  it('AC-436.1: the hook-timeout blast radius is re-verified across a representative multi-call session, not one probe', async () => {
    const doc = await readFile(spikePath, 'utf8');
    expect(doc).toMatch(/## AC\.1 — hook-timeout blast radius/);
    expect(doc).toContain('agy version tested: 1.1.12');
    // Below-timeout reliability across multiple tool types under the "*" matcher.
    expect(doc).toMatch(/write_to_file.{0,400}list_dir.{0,400}view_file|list_dir.{0,400}view_file.{0,400}write_to_file/s);
    // The cutoff is reported honestly as non-deterministic, not a clean 10s number.
    expect(doc).toMatch(/not a clean, deterministic 10s boundary/);
    expect(doc).toMatch(/pre-tool hook failed: JSON hook/);
  });

  it('AC-436.2: a native approval gate for write_to_file is empirically determined, reported either way', async () => {
    const doc = await readFile(spikePath, 'utf8');
    expect(doc).toMatch(/## AC\.2 — does agy have its own native approval gate/);
    expect(doc).toMatch(/No — not observed/);
    // Contrast against run_command's confirmed native gate, tested with hooks.json removed entirely.
    expect(doc).toContain('permissions.allow');
    expect(doc).toMatch(/hooks\.json.{0,3}removed from the scratch project entirely/);
  });

  it('AC-436.3: candidate rule shapes are proposed, grounded in denylist.mjs\'s own scope discipline, with no winner picked', async () => {
    const doc = await readFile(spikePath, 'utf8');
    expect(doc).toMatch(/## AC\.3 — candidate rule shapes/);
    expect(doc).toContain('no winner picked here');
    expect(doc).toMatch(/TARGETED backstop/);
    // All four candidates named.
    expect(doc).toMatch(/\*\*A\. Path-based denylist/);
    expect(doc).toMatch(/\*\*B\. Overwrite-of-protected-config rule/);
    expect(doc).toMatch(/\*\*C\. Content-signature rule/);
    expect(doc).toMatch(/\*\*D\. No new rule/);
    // The confirmed write_to_file payload shape grounding candidate C.
    expect(doc).toContain('CodeContent');
    expect(doc).toContain('TargetFile');
  });

  it('AC-436.4: a conclusion is stated (not a commitment) and a scoped follow-up is filed under #182', async () => {
    const doc = await readFile(spikePath, 'utf8');
    expect(doc).toMatch(/## AC\.4 — does the evidence support widening the matcher/);
    expect(doc).toMatch(/not useful, and could be actively counterproductive, without a paired rule/);
    expect(doc).toContain('**#477**');
    expect(doc).toMatch(/decide \+ design/);
  });

  it('AC-436.5: cross-gai.md\'s permissions section is updated with the findings, not left stale', async () => {
    const doc = await readFile(spikePath, 'utf8');
    expect(doc).toMatch(/## AC\.5 — `docs\/guides\/cross-gai\.md` updated/);

    const guide = await readFile(crossGaiPath, 'utf8');
    expect(guide).toMatch(/Only `run_command` is hooked today — still, and here's why \(#436\)/);
    expect(guide).toContain('agy-file-write-gating.md');
    expect(guide).toMatch(/no independent native approval gate for write_to_file|no fallback native gate the way `run_command` does/);
    expect(guide).toContain('#477');
  });

  it('an unplanned but significant finding (the hooks.json quoting bug) is reported and filed separately, not silently dropped', async () => {
    const doc = await readFile(spikePath, 'utf8');
    expect(doc).toMatch(/## §5 — unplanned finding/);
    expect(doc).toContain('**#478**');
    expect(doc).toMatch(/MODULE_NOT_FOUND/);
  });

  it('the spike doc is linked from the docs route index', async () => {
    const index = await readFile(routeIndexPath, 'utf8');
    expect(index).toContain('spikes/2026-08-13-agy-file-write-gating.md');
  });

  it('this is genuinely a spike: no production hook/emit source was touched', async () => {
    // #436's Non-goals are explicit: does not widen hooks.json's matcher, does
    // not touch denylist.mjs or emit.mjs. Pin that the matcher stays
    // run_command-only and no file-write rule vocabulary was wired in, so a
    // future edit that quietly slips implementation into this branch trips
    // this assertion rather than passing silently.
    const emit = await readFile(emitPath, 'utf8');
    expect(emit).toContain("matcher: 'run_command'");
    expect(emit).not.toContain('write_to_file');

    const denylist = await readFile(denylistPath, 'utf8');
    expect(denylist).not.toContain('TargetFile');
    expect(denylist).not.toContain('CodeContent');
  });
});
