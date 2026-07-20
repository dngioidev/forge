import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (rel) => readFile(join(root, rel), 'utf8');

describe('forge:autopilot skill (AC-1, AC-4, #126)', () => {
  it('AC-1: is a continuous loop over deliver — select, deliver, advance, until none remain', async () => {
    const s = await read('plugin/skills/autopilot/SKILL.md');
    expect(s).toMatch(/^name:\s*autopilot$/m);
    // built on the real pipeline, not a parallel one
    expect(s).toMatch(/forge:deliver/);
    expect(s).toMatch(/loop/i);
    expect(s).toMatch(/select.*next actionable|next actionable/i);
    // continuous until the board is empty, then a run report
    expect(s).toMatch(/no actionable ticket remains|none left|until.*none/i);
    expect(s).toMatch(/run report/i);
    // one at a time in v1 (parallel is deferred)
    expect(s).toMatch(/one ticket at a time/i);
  });

  it('AC-4: the human PR gate is replaced by a strict merge bar — nothing merges on red', async () => {
    const s = await read('plugin/skills/autopilot/SKILL.md');
    expect(s).toMatch(/auto-merge/i);
    expect(s).toMatch(/squash-merge to main/i);
    // the bar: ship green + mechanical gates + reviewer/security + CI green
    for (const gate of ['plandrift', 'testintent', 'depguard', 'acgate']) {
      expect(s, `merge bar missing ${gate}`).toContain(gate);
    }
    expect(s).toMatch(/reviewer/);
    expect(s).toMatch(/security/);
    expect(s).toMatch(/CI.*green|green.*CI/i);
    // the invariant
    expect(s).toMatch(/nothing merges on red|never merge.*red|merges on red.*ever/i);
    // safe-by-default opt-out
    expect(s).toMatch(/autopilotAutoMerge/);
  });

  it('AC-4: halts only on real escalations, and an escalation parks one ticket + continues', async () => {
    const s = await read('plugin/skills/autopilot/SKILL.md');
    expect(s).toMatch(/escalate\.mjs/);
    // the owner's two headline gates
    expect(s).toMatch(/product broken/i);
    expect(s).toMatch(/decision.*(not|isn't) the engine|design deviation needs a decision/i);
    // one escalation must not stop the whole run
    expect(s).toMatch(/parks? one ticket|continue.*next|does not stop the whole run/i);
  });

  it('AC-2 front door + AC-5 files new work + AC-6 safety are all specified', async () => {
    const s = await read('plugin/skills/autopilot/SKILL.md');
    // auto-triage front door, under-specified => escalate + skip
    expect(s).toMatch(/auto-triage|front door/i);
    expect(s).toMatch(/forge:triage/);
    expect(s).toMatch(/verdict: fail/);
    // can open new bugs/spikes/items mid-run
    expect(s).toMatch(/board\/create\.mjs/);
    expect(s).toMatch(/bug/);
    expect(s).toMatch(/spike/);
    // safety rails: pause / kill switch, loop backstop, resumable run ledger
    expect(s).toMatch(/paused|kill switch/i);
    expect(s).toMatch(/backstop|max-iterations/i);
    expect(s).toMatch(/run\.json|run ledger/i);
  });
});
