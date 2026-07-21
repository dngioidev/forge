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

  it('#156: the main loop is orchestrate-only — spawns a per-ticket delivery subagent, never delivers inline', async () => {
    const s = await read('plugin/skills/autopilot/SKILL.md');
    // the loop's per-ticket step is a Task-tool spawn, not inline delivery
    expect(s).toMatch(/SPAWN a delivery subagent|spawn a delivery subagent/i);
    expect(s).toMatch(/Task tool/);
    expect(s).toMatch(/subagent_type/);
    // explicit prohibition on inline delivery in the main loop
    expect(s).toMatch(/never deliver.* inline|NEVER delivers inline|not run `?forge:deliver`? inline|must not.*deliver.*inline/i);
    // the compact return contract the loop consumes
    expect(s).toMatch(/\{issue, outcome/);
  });

  it('#156: documents the permission allowlist required for a continuous run', async () => {
    const s = await read('plugin/skills/autopilot/SKILL.md');
    expect(s).toMatch(/Permissions/);
    expect(s).toMatch(/perms\.mjs/);
    expect(s).toMatch(/settings\.local\.json/);
    expect(s).toMatch(/permission prompt|pre-authoriz/i);
  });

  it('#137: documents context/cost bounding — spawned per-ticket delivery + O(1) outer loop', async () => {
    const s = await read('plugin/skills/autopilot/SKILL.md');
    expect(s).toMatch(/discardable context|spawned agent/i);
    expect(s).toMatch(/own spawned agent|delivered in a discardable/i);
    // outer loop keeps only file-backed state
    expect(s).toMatch(/run\.json.*outcome|one-line outcome/i);
    expect(s).toMatch(/O\(1\) per ticket/);
    // a dedicated cost/context section, incl. the OS-irrelevant note
    expect(s).toMatch(/Cost & context on long runs/);
    expect(s).toMatch(/checkpoint|resume protocol reconstructs/i);
    expect(s).toMatch(/host OS is irrelevant|OS.*irrelevant/i);
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
