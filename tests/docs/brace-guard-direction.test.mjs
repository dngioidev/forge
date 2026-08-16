import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const spikePath = join(repoRoot, 'docs', 'spikes', '2026-08-16-brace-guard-direction.md');
const routeIndexPath = join(repoRoot, 'docs', 'README.md');
const denylistPath = join(repoRoot, 'plugin', 'hooks', 'denylist.mjs');

describe('#515 — brace-expansion guard direction spike (for #448)', () => {
  it('AC-515.1: direction 3 is evaluated with real evidence, not asserted', async () => {
    const doc = await readFile(spikePath, 'utf8');
    expect(doc).toMatch(/## 1\. Direction 3/);
    // git and GNU coreutils permutation, verified live — not from memory.
    expect(doc).toContain('git push origin main --dry-run --verbose');
    expect(doc).toMatch(/main -> main/);
    expect(doc).toContain("rm junk2.txt -v");
    expect(doc).toMatch(/removed 'junk2\.txt'/);
    // the target-shaped brace group that expands to a standalone real flag
    expect(doc).toContain('{main,-f}');
    expect(doc).toMatch(/\[-f\]/);
  });

  it('AC-515.1: direction 3 verdict is a clear rule-out, not a hedge', async () => {
    const doc = await readFile(spikePath, 'utf8');
    expect(doc).toMatch(/does not dissolve the tradeoff/);
    expect(doc).toMatch(/Ruled out/);
  });

  it('AC-515.1/.2: all three pairing/detection directions are scored against one fixed corpus', async () => {
    const doc = await readFile(spikePath, 'utf8');
    expect(doc).toMatch(/## 2\. Directions 1 and 2/);
    expect(doc).toMatch(/19-case corpus/);
    expect(doc).toContain('direction1: 2/19, direction2(detect-only): 1/19, direction2-full(detect+classify): 0/19');
  });

  it('AC-515.2: direction 1 and direction 2-detect-only false-positive costs are stated per-direction', async () => {
    const doc = await readFile(spikePath, 'utf8');
    // direction 1 has two known-wrong verdicts
    expect(doc).toMatch(/\*\*1 — no pairing\*\*[\s\S]{0,400}2 of 4 wrong/);
    // direction 2 detect-only has one fewer
    expect(doc).toMatch(/\*\*2 \(detect-only\)\*\*[\s\S]{0,400}1 of 4 wrong/);
    expect(doc).toMatch(/[Ss]trictly dominates direction 1/);
  });

  it('AC-515.2: direction 2-full is shown to close the known false positive but crashes on a constructible adversarial input', async () => {
    const doc = await readFile(spikePath, 'utf8');
    expect(doc).toMatch(/2-full's disqualifying defect/);
    // reproduces the ORIGINAL removed implementation's own defect 3 — must be
    // named explicitly so the doc can't quietly soften this into "a minor bug".
    expect(doc).toMatch(/defect 3/);
    expect(doc).toMatch(/RangeError/);
    expect(doc).toMatch(/20,000-deep|20000-deep|20k-deep/);
    // and the fail-open consequence must be stated, not left implicit
    expect(doc).toMatch(/fail-open/);
    expect(doc).toMatch(/[Dd]isqualifying/);
  });

  it('AC-515.3: the recommendation is concrete and honestly scoped, not a manufactured verdict', async () => {
    const doc = await readFile(spikePath, 'utf8');
    expect(doc).toMatch(/## 3\. Recommendation/);
    expect(doc).toMatch(/\*\*Direction 2, detect-only/);
    // the accepted residual cost must stay visible, not be dropped by the recommendation
    expect(doc).toMatch(/\{main,develop\}/);
    // what the spike did NOT settle must be stated explicitly
    expect(doc).toMatch(/What this spike did not settle/);
    expect(doc).toMatch(/does not remove the cost/);
  });

  it('the spike doc and its plan are linked from the docs route index', async () => {
    const index = await readFile(routeIndexPath, 'utf8');
    expect(index).toContain('spikes/2026-08-16-brace-guard-direction.md');
  });

  it('this is genuinely a spike: no production hook source was touched', async () => {
    // The spike's premise is "prototype and decide, do not implement" — pin
    // that denylist.mjs carries none of the throwaway prototypes' internals,
    // so a future branch can't quietly slip an implementation into this scope.
    const src = await readFile(denylistPath, 'utf8');
    expect(src).not.toContain('mightStartWithDash');
    expect(src).not.toContain('direction2full');
  });
});
