import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const handbookPath = join(repoRoot, 'docs', 'guides', 'handbook.md');
const readmePath = join(repoRoot, 'README.md');
const troubleshootingPath = join(repoRoot, 'docs', 'guides', 'troubleshooting.md');

describe('#461 — permissions model has a Claude-facing home', () => {
  describe('AC-461.1: handbook.md gains a "Permissions & safety" section', () => {
    it('has the heading', async () => {
      const guide = await readFile(handbookPath, 'utf8');
      expect(guide).toMatch(/Permissions & safety/);
    });

    it('mentions agy/Antigravity (the file previously had zero occurrences)', async () => {
      const guide = await readFile(handbookPath, 'utf8');
      expect(guide).toMatch(/\bagy\b/i);
      expect(guide).toMatch(/Antigravity/);
    });

    it('states the tripwire-not-a-security-boundary framing', async () => {
      const guide = await readFile(handbookPath, 'utf8');
      expect(guide).toMatch(/tripwire/i);
      expect(guide).toMatch(/not a security boundary|not a general destructive-command sandbox/i);
    });

    it('branches explicitly by host rather than being Claude-shaped with an agy footnote', async () => {
      const guide = await readFile(handbookPath, 'utf8');
      const section = guide.slice(guide.indexOf('### Permissions & safety'));
      expect(section).toMatch(/\*\*Claude Code:\*\*/);
      expect(section).toMatch(/\*\*Antigravity \(agy\):\*\*/);
    });

    it('states the agy `ask` default (#429)', async () => {
      const guide = await readFile(handbookPath, 'utf8');
      const section = guide.slice(guide.indexOf('### Permissions & safety'));
      expect(section).toMatch(/`ask`/);
      expect(section).toMatch(/429/);
    });

    it('names the agy fail-open timeout as non-deterministic, not a clean boundary', async () => {
      const guide = await readFile(handbookPath, 'utf8');
      const section = guide.slice(guide.indexOf('### Permissions & safety'));
      expect(section).toMatch(/fails? open/i);
      expect(section).toMatch(/10.{0,5}15\s*(s\b|seconds)|non-deterministic/i);
    });

    it('names the git push zero-fallback gap without a payload', async () => {
      const guide = await readFile(handbookPath, 'utf8');
      const section = guide.slice(guide.indexOf('### Permissions & safety'));
      expect(section).toMatch(/git push/);
      expect(section).toMatch(/no (block|fallback)|neither a block nor/i);
    });

    it('links to install.md and cross-gai.md for the full mechanics', async () => {
      const guide = await readFile(handbookPath, 'utf8');
      const section = guide.slice(guide.indexOf('### Permissions & safety'));
      expect(section).toMatch(/install\.md/);
      expect(section).toMatch(/cross-gai\.md/);
    });
  });

  describe('AC-461.2: README.md no longer claims Claude Code is the required host', () => {
    it('does not contain "required host for the plugin"', async () => {
      const readme = await readFile(readmePath, 'utf8');
      expect(readme).not.toMatch(/required host for the plugin/i);
    });

    it('the Quickstart offers an explicit agy branch or pointer', async () => {
      const readme = await readFile(readmePath, 'utf8');
      const quickstart = readme.slice(readme.indexOf('## Quickstart'), readme.indexOf('## What you get'));
      expect(quickstart).toMatch(/Antigravity|agy/);
      expect(quickstart).toMatch(/install\.md#antigravity-agy/);
    });
  });

  describe('AC-461.3: README.md denylist mention carries the tripwire qualifier', () => {
    it('does not state "the safety denylist" unqualified', async () => {
      const readme = await readFile(readmePath, 'utf8');
      expect(readme).not.toMatch(/the safety\s*\ndenylist/i);
      expect(readme).not.toMatch(/\bthe safety denylist\b/i);
    });

    it('the denylist mention is qualified as a tripwire, not a security guarantee', async () => {
      const readme = await readFile(readmePath, 'utf8');
      const section = readme.slice(readme.indexOf('## Runs on your host'), readme.indexOf('## The pipeline builds itself'));
      expect(section).toMatch(/denylist/i);
      expect(section).toMatch(/tripwire|not a (general )?security boundary/i);
    });
  });

  describe('AC-461.4: troubleshooting.md covers the agy hooks fail-open path', () => {
    it('mentions the agy deny/capture shims', async () => {
      const guide = await readFile(troubleshootingPath, 'utf8');
      expect(guide).toMatch(/agy-deny\.mjs|agy-capture\.mjs/);
    });

    it('names the "it stopped prompting me" symptom as findable', async () => {
      const guide = await readFile(troubleshootingPath, 'utf8');
      expect(guide).toMatch(/stopped prompting/i);
    });

    it('states the host-level timeout fail-open, non-deterministic ~10-15s', async () => {
      const guide = await readFile(troubleshootingPath, 'utf8');
      expect(guide).toMatch(/timeout/i);
      expect(guide).toMatch(/fails? open/i);
      expect(guide).toMatch(/10.{0,5}15\s*(s\b|seconds)|non-deterministic/i);
    });
  });

  it('AC-461.5: this plan is linked from the docs route index', async () => {
    const index = await readFile(join(repoRoot, 'docs', 'README.md'), 'utf8');
    expect(index).toContain('plans/2026-08-15-461-permissions-docs-home.md');
  });
});
