import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const guidePath = join(repoRoot, 'docs', 'guides', 'cross-gai.md');
const routeIndexPath = join(repoRoot, 'docs', 'README.md');

describe('#429 — agy hook default flip (allow -> ask) docs', () => {
  it('AC-429.5: the fail-open-on-timeout gap is stated honestly, not implied away', async () => {
    const doc = await readFile(guidePath, 'utf8');
    // Must name the actual mechanism (host-level timeout) and admit forge cannot
    // fix it from its own side — not just gesture at "a residual risk exists".
    expect(doc).toMatch(/fails open at the host level/);
    expect(doc).toMatch(/timeout: 10/);
    expect(doc).toMatch(/nothing forge can configure on\s+its own side/);
  });

  it('AC-429.6: the run_command-only matcher scope decision is explained, not silently left as-is', async () => {
    const doc = await readFile(guidePath, 'utf8');
    expect(doc).toContain('Only `run_command` is hooked today');
    expect(doc).toMatch(/write_to_file/);
    expect(doc).toMatch(/follow-up/);
  });

  it('AC-429.7: cross-gai.md gains an honest permissions section covering the default, the shared allowlist, and AC-429.3 precedence', async () => {
    const doc = await readFile(guidePath, 'utf8');
    expect(doc).toMatch(/Permissions: the allow \/ ask \/ deny default \(#429\)/);
    expect(doc).toMatch(/\*\*Default is `ask`, not `allow`\.\*\*/);
    expect(doc).toContain('plugin/scripts/lib/allowed-commands.mjs');
    expect(doc).toMatch(/denylist always outranks the allowlist/);
    // Deliberate behaviour-change warning must be present, not just implied.
    expect(doc).toMatch(/existing agy sessions get \*more\*\s+prompting, never less/);
  });

  it('AC-429.7: the capability/parity matrix gets an honest command pre-authorization row instead of an unqualified full-parity claim', async () => {
    const doc = await readFile(guidePath, 'utf8');
    expect(doc).toMatch(/\| Command pre-authorization \(allowlist\) \|/);
    expect(doc).toMatch(/Partial.*hook-mediated/);
    expect(doc).toMatch(/Command pre-authorization does not/);
  });

  it('this plan is linked from the docs route index', async () => {
    const index = await readFile(routeIndexPath, 'utf8');
    expect(index).toContain('plans/2026-08-12-429-agy-ask-default.md');
  });
});
