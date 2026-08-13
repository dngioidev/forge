import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const crossGaiPath = join(repoRoot, 'docs', 'guides', 'cross-gai.md');
const installPath = join(repoRoot, 'docs', 'guides', 'install.md');
const routeIndexPath = join(repoRoot, 'docs', 'README.md');

describe('#444 — allowlist `git add`, positive-model argument guard', () => {
  it('AC-444.2: cross-gai.md documents the eighth guarded verb in its table, auto-approved/asks columns', async () => {
    const doc = await readFile(crossGaiPath, 'utf8');
    expect(doc).toMatch(/\| `git add` \|/);
    // The three excluded flags are named in the "asks" column, not enumerated
    // as a blocklist elsewhere — this is the positive model documented, not reversed.
    expect(doc).toMatch(/`git add`[^\n]*\|[^\n]*(?:-p|--patch)[^\n]*(?:-i|--interactive)[^\n]*(?:-e|--edit)/);
  });

  it('AC-444.4: cross-gai.md states the Claude-side asymmetry for `git add` as the same accepted trade already documented for the other seven verbs', async () => {
    const doc = await readFile(crossGaiPath, 'utf8');
    expect(doc).toContain('Bash(git add:*)');
    expect(doc).toMatch(/git add[\s\S]{0,400}same[\s\S]{0,80}accepted trade/i);
  });

  it('AC-444.5: cross-gai.md documents the residual `-p`/`-i`/`-e` prompts as expected/by-design, mirroring the `git checkout main` treatment', async () => {
    const doc = await readFile(crossGaiPath, 'utf8');
    expect(doc).toMatch(/git add -p[\s\S]{0,300}(?:expected|by design|by-design)/i);
  });

  it('AC-444.4: install.md gains a `git add` line in its pre-authorization section, stating the same Claude-side asymmetry', async () => {
    const doc = await readFile(installPath, 'utf8');
    const section = doc.slice(
      doc.indexOf('Pre-authorizing outward commands'),
      doc.indexOf('## 7. Migrating'),
    );
    expect(section).toMatch(/git add/);
    expect(section).toMatch(/agy-side only/);
    expect(section).toMatch(/unguarded/);
    // Single-sourcing (AC-432.3): install.md must not spell the literal
    // Bash(<prefix>:*) grant itself — that lives in cross-gai.md / perms.mjs.
    expect(section).not.toMatch(/Bash\(git add:\*\)/);
  });

  it('this plan is linked from the docs route index', async () => {
    const index = await readFile(routeIndexPath, 'utf8');
    expect(index).toContain('plans/2026-08-13-444-git-add-allowlist.md');
  });
});
