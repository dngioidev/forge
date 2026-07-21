import { describe, it, expect } from 'vitest';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isGroundedSource, evaluateManifest, runGroundGate } from '../../plugin/scripts/gates/groundgate.mjs';

describe('ground gate (#141) — never invent product direction', () => {
  const exists = (p) => p === 'docs/product/rules.md' || p === 'docs/specs/s.md';

  it('grounds a source only when it points at something real', () => {
    expect(isGroundedSource('docs/product/rules.md', exists)).toBe(true);
    expect(isGroundedSource('docs/product/rules.md#empty', exists)).toBe(true); // anchor ok
    expect(isGroundedSource('#123', exists)).toBe(true);          // ticket ref
    expect(isGroundedSource('graph:Button', exists)).toBe(true);  // code graph
    expect(isGroundedSource('ticket-body', exists)).toBe(true);
    // NOT grounded:
    expect(isGroundedSource('', exists)).toBe(false);
    expect(isGroundedSource('   ', exists)).toBe(false);
    expect(isGroundedSource(null, exists)).toBe(false);
    expect(isGroundedSource('docs/product/made-up.md', exists)).toBe(false); // file doesn't exist
  });

  it('evaluateManifest passes only when every declared decision is grounded', () => {
    const good = { decisions: [
      { claim: 'behaviour X', source: 'docs/product/rules.md#x' },
      { claim: 'priority p2', source: '#123' },
    ] };
    expect(evaluateManifest(good, exists).ok).toBe(true);

    const bad = { decisions: [
      { claim: 'behaviour X', source: 'docs/product/rules.md' },
      { claim: 'invented scope cut', source: '' },        // ungrounded
      { claim: 'guessed default', source: 'docs/nope.md' }, // bad file
    ] };
    const res = evaluateManifest(bad, exists);
    expect(res.ok).toBe(false);
    expect(res.ungrounded.map((u) => u.claim)).toEqual(['invented scope cut', 'guessed default']);
  });

  it('an empty manifest is trivially clean; a malformed one is an error', () => {
    expect(evaluateManifest({ decisions: [] }, exists).ok).toBe(true);
    expect(evaluateManifest({}, exists).ok).toBe(false);
    expect(evaluateManifest({ decisions: 'nope' }, exists).error).toMatch(/decisions/);
  });

  it('runGroundGate reads the manifest and checks real files (RED then GREEN)', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'forge-ground-'));
    await mkdir(join(cwd, 'docs', 'product'), { recursive: true });
    await mkdir(join(cwd, '.forge', 'shape'), { recursive: true });
    await writeFile(join(cwd, 'docs', 'product', 'rules.md'), '# rules');

    // one grounded, one citing a non-existent file → RED
    await writeFile(join(cwd, '.forge', 'shape', '9.sources.json'), JSON.stringify({ decisions: [
      { claim: 'ok', source: 'docs/product/rules.md' },
      { claim: 'invented', source: 'docs/product/ghost.md' },
    ] }));
    const red = await runGroundGate({ cwd, manifestPath: '.forge/shape/9.sources.json', log: () => {} });
    expect(red.ok).toBe(false);
    expect(red.ungrounded.map((u) => u.claim)).toEqual(['invented']);

    // fix the citation → GREEN
    await writeFile(join(cwd, '.forge', 'shape', '9.sources.json'), JSON.stringify({ decisions: [
      { claim: 'ok', source: 'docs/product/rules.md' },
      { claim: 'from ticket', source: '#9' },
    ] }));
    const green = await runGroundGate({ cwd, manifestPath: '.forge/shape/9.sources.json', log: () => {} });
    expect(green.ok).toBe(true);
  });
});
