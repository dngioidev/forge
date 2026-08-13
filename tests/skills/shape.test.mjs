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

  // AC-466.2: the crazy-mode diagram must show a SPAWN for the shape branch, not
  // an inline call — the same discipline the delivery diagram already has.
  it('AC-466.2: the crazy-mode diagram shows a spawn for forge:shape, not an inline call', async () => {
    const c = await read('docs/specs/2026-07-21-forge-autopilot-crazy-mode.md');
    expect(c).toMatch(/forge:shape[\s\S]{0,60}\(spawn|SPAWN[\s\S]{0,60}forge:shape/i);
    expect(c).toMatch(/own context|Task tool/i);
  });

  it('AC-466.2/AC-466.7: SKILL.md documents the shape subagent spawn (Task tool, pinned model) parallel to the delivery spawn', async () => {
    const a = await read('plugin/skills/autopilot/SKILL.md');
    expect(a).toMatch(/spawn.{0,120}shape subagent|shape subagent.{0,120}Task tool/is);
    // pinned model discipline (#379/#101) applies to every spawn, shape included
    expect(a).toMatch(/shape subagent[\s\S]{0,300}subagent_type:\s*general-purpose[\s\S]{0,60}model:\s*["']?sonnet["']?/i);
  });

  // AC-466.4: escalate-before-return — a shape subagent's reasoning dies with its
  // context, so an escalation MUST be written in full before the subagent returns;
  // it must never return awaiting re-invocation (nothing re-invokes it), mirroring
  // the delivery-side #319/#177 return-then-resume-stall discipline.
  it('AC-466.4: the shape brief mandates escalate-before-return and forbids returning awaiting re-invocation', async () => {
    const s = await read('plugin/skills/shape/SKILL.md');
    expect(s).toMatch(/before[\s\S]{0,40}returning|before it returns/i);
    expect(s).toMatch(/never return.{0,80}(awaiting|expecting).{0,40}re-invocation|nothing re-invokes it/i);
    expect(s).toMatch(/escalate\.mjs/);
  });

  it('AC-466.4: the shape outcome passes through the loop watchdog like every other delivery report', async () => {
    const s = await read('plugin/skills/shape/SKILL.md');
    expect(s).toMatch(/watchdog\.mjs/i);
  });
});
