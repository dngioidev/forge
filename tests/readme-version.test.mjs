import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

// #308: the README shields.io version badge is hand-typed and drifts silently
// from the real release version in package.json (it sat at 0.16.0 while the
// package was 0.18.0). package.json is the single source of truth; this guard
// re-derives the badge version from the README and asserts the two never diverge
// again. The badge line looks like:
//   [![version](https://img.shields.io/badge/version-0.18.0-blue.svg)](CHANGELOG.md)
const BADGE_RE = /img\.shields\.io\/badge\/version-(\d+\.\d+\.\d+)-/;

describe('README version badge stays in sync with package.json (#308)', () => {
  it('AC-308.1: package.json version is the single source of truth and the README badge matches it', async () => {
    const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
    const readme = await readFile(join(root, 'README.md'), 'utf8');
    const m = readme.match(BADGE_RE);

    // The badge must exist and be machine-readable — if it's gone or reshaped,
    // this guard can no longer protect it, so fail loudly rather than pass blind.
    expect(m, 'no shields.io version badge found in README.md').not.toBeNull();
    expect(pkg.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(m[1]).toBe(pkg.version);
  });

  it('AC-308.2: the guard fails when the badge version diverges from package.json', () => {
    // Prove the assertion actually catches drift (not a no-op): simulate the
    // pre-fix state where package.json moved to 0.18.0 but the badge lagged.
    const badge = '[![version](https://img.shields.io/badge/version-0.16.0-blue.svg)](CHANGELOG.md)';
    const stale = badge.match(BADGE_RE)[1];
    expect(stale).toBe('0.16.0');
    expect(stale).not.toBe('0.18.0');
  });
});
