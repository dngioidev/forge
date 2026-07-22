import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (rel) => readFile(join(root, rel), 'utf8');

describe('forge:deliver skill (AC-121, #121)', () => {
  it('AC-121.1: chains plan → execute-agents → ship with a single human gate at the PR', async () => {
    const s = await read('plugin/skills/deliver/SKILL.md');
    expect(s).toMatch(/^name:\s*deliver$/m);
    expect(s).toMatch(/one[- ]gate|single human gate/i);   // one human touchpoint
    expect(s).toMatch(/planner/);                           // plan phase = the new role
    expect(s).toMatch(/execute-agents/);                    // execute phase
    expect(s).toMatch(/forge:ship|ship/i);                  // ship phase
    expect(s).toMatch(/escalate\.mjs/);                     // still halts on §7 blockers
    expect(s).toMatch(/security/i);                         // security-critical is a halt
  });

  it('AC-121.3: is kind-aware — classifies the ticket and routes per kind (#121)', async () => {
    const s = await read('plugin/skills/deliver/SKILL.md');
    expect(s).toMatch(/Classify/i);
    for (const kind of ['spike', 'bug', 'ui', 'feature', 'test', 'chore']) {
      expect(s, `route missing kind ${kind}`).toContain(kind);
    }
    // spike special-cases: ADR + follow-up ticket, no code PR
    expect(s).toMatch(/does not ship code|no code PR/i);
    expect(s).toMatch(/ADR/);
    expect(s).toMatch(/board\/create\.mjs|follow-up/i);
    // ui: auto-pick a variant, single gate preserved (no human variant pick)
    expect(s).toMatch(/auto-select|auto-pick/i);
    expect(s).toMatch(/visual spec/i);
    // bug: reproduce / regression test first
    expect(s).toMatch(/reproduce|regression/i);
  });

  it('AC-121.4: the planner classifies + types tasks; execute-agents selects role by task kind (#121)', async () => {
    const card = await read('plugin/cards/planner.md');
    expect(card).toMatch(/Classify the ticket kind/i);
    expect(card).toMatch(/spike.*bug.*ui.*feature.*test.*chore|kind/i);
    expect(card).toMatch(/Type each task|code.*test.*ui.*infra/i);
    const ea = await read('plugin/skills/execute-agents/SKILL.md');
    expect(ea).toMatch(/matching the task's `kind`|task's `kind`/);
    expect(ea).toMatch(/designer/);
    expect(ea).toMatch(/devops/);
  });

  it('#177: ship watches CI to green in-run and forbids the open-PR-then-return stall', async () => {
    const s = await read('plugin/skills/deliver/SKILL.md');
    // AC1: watch CI to green in the same run with gh pr checks --watch
    expect(s).toMatch(/gh pr checks <pr> --watch/);
    expect(s).toMatch(/watch CI to green in this same run|watch CI to conclusion/i);
    // AC2: forbid opening the PR and returning to await an external notification
    expect(s).toMatch(/do \*\*not\*\*|must not|forbid/i);
    expect(s).toMatch(/await.*(background|external).*notification/i);
    expect(s).toMatch(/nothing re-invokes it on green|context is discarded/i);
  });

  it('AC-121.2: planner is a compiled, read-only role pinned to a model', async () => {
    const { ROLES, MODELS } = await import('../../plugin/scripts/backends/compile.mjs');
    expect(ROLES).toContain('planner');
    expect(MODELS.planner).toBe('sonnet');
    const agent = await read('plugin/agents/planner.md');
    expect(agent).toMatch(/^model: sonnet$/m);
    expect(agent).toMatch(/^tools: Read, Grep, Glob$/m);
  });
});
