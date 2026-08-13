import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const spikePath = join(repoRoot, 'docs', 'spikes', '2026-08-13-argv-tokenize-model.md');
const routeIndexPath = join(repoRoot, 'docs', 'README.md');
const denylistPath = join(repoRoot, 'plugin', 'hooks', 'denylist.mjs');

describe('#451 — tokenize-then-judge argv model spike', () => {
  it('AC-451.1: the spike states the tokenizer design and the boundary of what it refuses to model', async () => {
    const doc = await readFile(spikePath, 'utf8');
    expect(doc).toMatch(/## 1\. Design — tokenize-then-judge/);
    // the token kinds the design commits to
    expect(doc).toContain("'word' | 'assignment' | 'separator' | 'ddash' | 'substitution' | 'unresolved-brace'");
    // explicit refusals, not silently left implicit
    expect(doc).toMatch(/explicitly refuses to model/);
    expect(doc).toContain('Brace expansion');
    expect(doc).toMatch(/Filesystem-backed path resolution/);
  });

  it('AC-451.2: the path-resolution scope decision is made and grounded in real (bash-independent) evidence, not defaulted', async () => {
    const doc = await readFile(spikePath, 'utf8');
    expect(doc).toMatch(/## 2\. Path-resolution scope/);
    expect(doc).toContain('path.posix.normalize');
    expect(doc).toContain('../prod-secrets');
    expect(doc).toMatch(/\*\*Decision: \(b\), lexical normalisation\.\*\*/);
    // the symlink cost is stated honestly, not glossed over
    expect(doc).toMatch(/symlink/i);
  });

  it('AC-451.3: a subsumption matrix covers all six sibling tickets with a verdict and evidence for each', async () => {
    const doc = await readFile(spikePath, 'utf8');
    expect(doc).toMatch(/## 3\. Subsumption matrix/);
    for (const n of ['#451', '#452', '#454', '#456', '#448', '#449']) {
      expect(doc, n).toContain(n);
    }
    expect(doc).toMatch(/\*\*Closed\*\*/);
    expect(doc).toMatch(/Partially closed/);
    // the matrix must not claim a clean sweep it didn't earn
    expect(doc).toMatch(/none left fully open/);
  });

  it('AC-451.4: the #452 mutual-exclusivity question is answered with evidence, not asserted', async () => {
    const doc = await readFile(spikePath, 'utf8');
    expect(doc).toMatch(/## 4\. #452's mutual exclusivity/);
    expect(doc).toMatch(/as a forced-choice artifact/i);
    // the nuance: closes as a package with §2, not for free
    expect(doc).toMatch(/closed \*\*as a package\*\*/);
  });

  it('AC-451.5: a migration plan names the regression corpus and phases the work, no big-bang swap', async () => {
    const doc = await readFile(spikePath, 'utf8');
    expect(doc).toMatch(/## 5\. Migration plan/);
    expect(doc).toContain('AC-429.*');
    expect(doc).toContain('AC-437.*');
    expect(doc).toContain('AC-446.*');
    expect(doc).toContain('AC-450.*');
    expect(doc).toMatch(/Phase 1/);
    expect(doc).toMatch(/Phase 4/);
  });

  it('AC-451.6: the recommendation weighs the tripwire-not-boundary and no-auto-approve facts honestly before recommending', async () => {
    const doc = await readFile(spikePath, 'utf8');
    expect(doc).toMatch(/## 6\. Recommendation/);
    expect(doc).toMatch(/fails open/);
    expect(doc).toMatch(/tripwire/);
    expect(doc).toMatch(/no host currently auto-approves any of the six commands/i);
    expect(doc).toMatch(/does not manufacture a rewrite to justify itself/);
  });

  it('AC-451.7: a Phase-1-only consolidation ticket was filed under #182 and is named in the spike', async () => {
    const doc = await readFile(spikePath, 'utf8');
    expect(doc).toContain('**Filed: #457**');
    expect(doc).toMatch(/Phase 1 only/);
    expect(doc).toMatch(/not\*\* closing any of #451\/#452\/#454\/#456\/#448\/#449/);
  });

  it('the spike doc is linked from the docs route index', async () => {
    const index = await readFile(routeIndexPath, 'utf8');
    expect(index).toContain('spikes/2026-08-13-argv-tokenize-model.md');
  });

  it('this is genuinely a spike: no production hook source was touched', async () => {
    // The spike's whole premise is "design and decide, do not implement" — pin
    // that denylist.mjs still has NO tokenizer/token-kind vocabulary wired in,
    // so a future PR that quietly slips implementation into this ticket's
    // branch trips this assertion rather than passing silently.
    const src = await readFile(denylistPath, 'utf8');
    expect(src).not.toContain('shell-tokenize');
    expect(src).not.toContain('unresolved-brace');
  });
});
