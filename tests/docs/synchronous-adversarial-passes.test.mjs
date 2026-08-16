import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const spikePath = join(repoRoot, 'docs', 'spikes', '2026-08-17-synchronous-adversarial-passes.md');
const routeIndexPath = join(repoRoot, 'docs', 'README.md');
const executeAgentsSkillPath = join(repoRoot, 'plugin', 'skills', 'execute-agents', 'SKILL.md');
const autopilotSkillPath = join(repoRoot, 'plugin', 'skills', 'autopilot', 'SKILL.md');

describe('#475 — synchronous adversarial passes spike (follow-up to #464)', () => {
  it('AC-475.2: the doc weighs spawn-and-await\'s parallelism and context isolation honestly, not dismissively', async () => {
    const doc = await readFile(spikePath, 'utf8');
    expect(doc).toMatch(/## 2\. What spawn-and-await \(a\) buys/);
    expect(doc).toMatch(/[Pp]arallelism/);
    expect(doc).toMatch(/context-isolation value|context isolation/i);
    // the strongest argument against synchronous passes must be named as such
    expect(doc).toMatch(/strongest argument, backed by fresh evidence/i);
  });

  it('AC-475.3: the doc gives an explicit verdict on whether synchronous passes would have prevented all four of #464\'s stalls', async () => {
    const doc = await readFile(spikePath, 'utf8');
    expect(doc).toMatch(/## 4\. Would synchronous passes have prevented the stalls\?/);
    for (const n of ['#429', '#437', '#446', '#460']) {
      expect(doc, n).toContain(n);
    }
    expect(doc).toMatch(/yes — synchronous passes \(c\) would have prevented all six/i);
    // and the honest caveat that this doesn't fix the general tendency #464 named
    expect(doc).toMatch(/general model-behavior tendency|general return-then-resume tendency/i);
  });

  it('AC-475.4: the fresh six-stall/one-mitigation evidence base from this run is incorporated with real citations', async () => {
    const doc = await readFile(spikePath, 'utf8');
    for (const n of ['#469', '#472', '#474', '#448', '#449', '#470']) {
      expect(doc, n).toContain(n);
    }
    expect(doc).toContain('PR #540');
    expect(doc).toContain('PR #536');
    expect(doc).toContain('PR #539');
    expect(doc).toContain('PR #534');
    // the #474 fix-wave fragility must be named as a real, non-zero cost
    expect(doc).toMatch(/false-relay bugs|false relays/i);
  });

  it('AC-475.5: the recommendation is framed as a decision point with live options, not an autonomous verdict', async () => {
    const doc = await readFile(spikePath, 'utf8');
    expect(doc).toMatch(/## 6\. Recommendation/);
    expect(doc).toMatch(/decision for the human, not this ticket's to make unilaterally/i);
    expect(doc).toMatch(/1\. \*\*Keep spawn-and-await/);
    expect(doc).toMatch(/2\. \*\*Adopt synchronous passes as the default/);
    expect(doc).toMatch(/3\. \*\*Hybrid/);
  });

  it('AC-475.5: no delivery-contract file is claimed changed, and none is touched by this branch', async () => {
    const doc = await readFile(spikePath, 'utf8');
    expect(doc).toMatch(/no change to `forge:deliver`, `forge:execute-agents`, or the autopilot delivery brief/i);
    // the skill files themselves must be untouched by this diff — read as reference only
    const executeAgents = await readFile(executeAgentsSkillPath, 'utf8');
    expect(executeAgents).toContain("Spawn `reviewer` + `security` on the full branch diff");
    const autopilot = await readFile(autopilotSkillPath, 'utf8');
    expect(autopilot).toMatch(/the return-then-resume stall/);
  });

  it('the spike doc is linked from the docs route index', async () => {
    const index = await readFile(routeIndexPath, 'utf8');
    expect(index).toContain('spikes/2026-08-17-synchronous-adversarial-passes.md');
  });
});
