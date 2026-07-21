import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (rel) => readFile(join(root, rel), 'utf8');

describe('forge:shape skill (#140, AC-2/AC-3/AC-4)', () => {
  it('AC-3: grounded-only — every product decision cites a source, ground gate enforces it', async () => {
    const s = await read('plugin/skills/shape/SKILL.md');
    expect(s).toMatch(/^name:\s*shape$/m);
    expect(s).toMatch(/grounded-only/i);
    expect(s).toMatch(/groundgate\.mjs/);
    expect(s).toMatch(/sources manifest|sources\.json/i);
    // never invent product direction; escalate instead
    expect(s).toMatch(/never (guess|invent)|not yours to answer/i);
    expect(s).toMatch(/escalate/i);
  });

  it('AC-4: classifies the not-ready reason and routes across the front-of-pipeline', async () => {
    const s = await read('plugin/skills/shape/SKILL.md');
    for (const skill of ['forge:ideate', 'forge:brainstorm', 'forge:spike', 'forge:design']) {
      expect(s, `route missing ${skill}`).toContain(skill);
    }
    // a spike yields an ADR + a ready follow-up, no code PR
    expect(s).toMatch(/ADR/);
    expect(s).toMatch(/follow-up/i);
    expect(s).toMatch(/no code PR/i);
  });

  it('AC-2: promotes Backlog→Ready on a clean gate; reuses the existing skills', async () => {
    const s = await read('plugin/skills/shape/SKILL.md');
    expect(s).toMatch(/Backlog\s*→\s*Ready|--status ready/);
    expect(s).toMatch(/orchestrat|reinvents? no|invents no/i);
    // honesty clause + terminal report contract
    expect(s).toMatch(/"Unknown" is a valid answer/);
    expect(s).toMatch(/"verdict":"pass\|fail"/);
  });

  it('crazy mode is wired into the autopilot skill as an opt-in --shape front door', async () => {
    const a = await read('plugin/skills/autopilot/SKILL.md');
    expect(a).toMatch(/--shape/);
    expect(a).toMatch(/crazy mode/i);
    expect(a).toMatch(/forge:shape/);
    expect(a).toMatch(/readiness/i);
    expect(a).toMatch(/Off by default|default/i);
  });
});
