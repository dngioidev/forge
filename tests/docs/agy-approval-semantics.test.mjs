import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const spikePath = join(repoRoot, 'docs', 'spikes', '2026-08-12-agy-approval-semantics.md');
const adrPath = join(repoRoot, 'docs', 'decisions', '0007-cross-gai-mcp-first.md');
const routeIndexPath = join(repoRoot, 'docs', 'README.md');

describe('#428 — agy approval-semantics spike', () => {
  it('AC-428.1: the spike doc states, from observed behaviour on a named live agy version, what each decision does to the approval prompt', async () => {
    const doc = await readFile(spikePath, 'utf8');
    expect(doc).toMatch(/agy version tested: 1\.1\.7/);
    // all four decisions named with their observed/documented effect
    expect(doc).toMatch(/"allow"[\s\S]{0,80}Automatically allow the tool execution/);
    expect(doc).toMatch(/"deny"[\s\S]{0,80}Hard block the execution immediately/);
    expect(doc).toMatch(/"ask"[\s\S]{0,80}Prompt the user for permission/);
    expect(doc).toMatch(/"force_ask"[\s\S]{0,80}Always prompt the user/);
    expect(doc).toContain('reading 1 is confirmed for interactive agy sessions');
  });

  it('AC-428.2: the spike doc answers definitively whether agy has a native pre-authorization config file, with path and schema', async () => {
    const doc = await readFile(spikePath, 'utf8');
    expect(doc).toContain('~/.gemini/antigravity-cli/settings.json');
    expect(doc).toContain('permissions.allow');
    expect(doc).toContain('command(<target>)');
  });

  it('AC-428.3: the spike doc makes and justifies a recommendation, assessing the security posture of the current default', async () => {
    const doc = await readFile(spikePath, 'utf8');
    expect(doc).toMatch(/## Recommendation \(AC\.3\)/);
    expect(doc).toContain('Hook-mediated allowlist');
    expect(doc).toMatch(/security posture of today's default, assessed plainly:\*\* unsafe/);
  });

  it('AC-428.4: a bug was filed for the confirmed blanket-auto-approve finding and is linked from the spike doc', async () => {
    const doc = await readFile(spikePath, 'utf8');
    expect(doc).toMatch(/#434/);
    expect(doc).toContain('p0 bug');
  });

  it('AC-428.5: ADR-0007 is updated with the confirmed approval-semantics finding rather than left silent', async () => {
    const adr = await readFile(adrPath, 'utf8');
    expect(adr).toMatch(/Addendum \(2026-08-12, #428\)/);
    expect(adr).toContain('#434');
    expect(adr).toMatch(/\[`docs\/spikes\/2026-08-12-agy-approval-semantics\.md`\]/);
  });

  it('AC-428.6: the spike doc is linked from the docs route index', async () => {
    const index = await readFile(routeIndexPath, 'utf8');
    expect(index).toContain('spikes/2026-08-12-agy-approval-semantics.md');
  });
});
