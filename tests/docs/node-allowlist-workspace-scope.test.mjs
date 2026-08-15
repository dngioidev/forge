import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const crossGaiPath = join(repoRoot, 'docs', 'guides', 'cross-gai.md');
const routeIndexPath = join(repoRoot, 'docs', 'README.md');

describe('#438 — allowlist `node <path>` narrowed to the workspace', () => {
  it('AC-438.4: cross-gai.md\'s guarded-verbs table states the node entry auto-approves only paths inside the workspace', async () => {
    const doc = await readFile(crossGaiPath, 'utf8');
    expect(doc).toMatch(/\| `node` \|[^\n]*workspace[^\n]*\|/i);
  });

  it('AC-438.4: cross-gai.md\'s guarded-verbs table states traversal/absolute escapes ask, not the old open-ended gap', async () => {
    const doc = await readFile(crossGaiPath, 'utf8');
    const nodeRow = doc.match(/\| `node` \|.*\|.*\|/)?.[0] ?? '';
    expect(nodeRow).toMatch(/traverses|outside it/i);
  });

  it('AC-438.4: cross-gai.md no longer describes the node guard as accepting any on-disk path', async () => {
    const doc = await readFile(crossGaiPath, 'utf8');
    expect(doc).not.toMatch(/any-on-disk-path|any on-disk path/i);
    expect(doc).toContain('#438');
  });

  it('this plan is linked from the docs route index', async () => {
    const index = await readFile(routeIndexPath, 'utf8');
    expect(index).toContain('plans/2026-08-16-438-node-allowlist-workspace-scope.md');
  });
});
