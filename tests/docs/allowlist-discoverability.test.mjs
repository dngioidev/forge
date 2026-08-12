import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const installPath = join(repoRoot, 'docs', 'guides', 'install.md');
const skillPath = join(repoRoot, 'plugin', 'skills', 'autopilot', 'SKILL.md');

describe('#432 — allowlist discoverability outside the autopilot skill', () => {
  it('AC-432.3: install.md has a pre-authorization section that points at perms.mjs, states the unattended push/merge grant, and that it is opt-in', async () => {
    const guide = await readFile(installPath, 'utf8');
    expect(guide).toMatch(/Pre-authorizing outward commands \(optional\)/);
    expect(guide).toContain('scripts/autopilot/perms.mjs');
    expect(guide).toMatch(/grants unattended push\/merge authority/);
    expect(guide).toMatch(/optional\)|opt in/);
  });

  it('AC-432.3: the section follows the host-neutral Claude Code / Antigravity (agy) branch pattern rather than being Claude-only', async () => {
    const guide = await readFile(installPath, 'utf8');
    const section = guide.slice(guide.indexOf('Pre-authorizing outward commands'), guide.indexOf('## 7. Migrating'));
    expect(section).toMatch(/\*\*Claude Code:\*\*/);
    expect(section).toMatch(/\*\*Antigravity \(agy\):\*\*/);
  });

  it('AC-432.3: the section does not copy the allowlist entries verbatim, preserving single-sourcing (AC.2)', async () => {
    const { ALLOWED_COMMAND_PREFIXES } = await import('../../plugin/scripts/lib/allowed-commands.mjs');
    const guide = await readFile(installPath, 'utf8');
    // none of the Bash(<prefix>:*) settings-file entries appear literally
    for (const prefix of ALLOWED_COMMAND_PREFIXES) {
      expect(guide).not.toContain(`Bash(${prefix}:*)`);
    }
  });

  it('AC-432.5: the "necessary but not sufficient" auto-mode classifier caveat is still present and prominent in the autopilot SKILL', async () => {
    const skill = await readFile(skillPath, 'utf8');
    expect(skill).toMatch(/necessary but \*\*not sufficient\*\*/);
    expect(skill).toMatch(/auto-mode classifier/);
    expect(skill).toMatch(/does not count/);
  });

  it('this plan is linked from the docs route index', async () => {
    const index = await readFile(join(repoRoot, 'docs', 'README.md'), 'utf8');
    expect(index).toContain('plans/2026-08-12-432-allowlist-discoverability.md');
  });
});
