import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseRouteLinks, runDocSync } from '../../plugin/scripts/gates/docsync.mjs';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const readmePath = join(repoRoot, 'docs', 'README.md');

describe('#535 — docsync: two plan docs not linked in docs/README.md', () => {
  it('AC-535.1: docs/README.md links both #448 and #472 plan docs (widened scope: the gate reported 2 unindexed docs, not the 1 originally filed)', async () => {
    const indexText = await readFile(readmePath, 'utf8');
    const links = parseRouteLinks(indexText);
    expect(links.has('plans/2026-08-17-448-brace-expansion-denylist.md')).toBe(true);
    expect(links.has('plans/2026-08-17-472-safermtarget-nul-dash-fusion.md')).toBe(true);
  });

  it('AC-535.2: the real doc-sync gate passes clean against this repo', async () => {
    const res = await runDocSync({ cwd: repoRoot, log: () => {} });
    expect(res.ok).toBe(true);
    expect(res.routeGaps).toEqual([]);
  });
});
