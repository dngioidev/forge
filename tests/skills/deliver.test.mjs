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

  it('AC-121.2: planner is a compiled, read-only role pinned to a model', async () => {
    const { ROLES, MODELS } = await import('../../plugin/scripts/backends/compile.mjs');
    expect(ROLES).toContain('planner');
    expect(MODELS.planner).toBe('sonnet');
    const agent = await read('plugin/agents/planner.md');
    expect(agent).toMatch(/^model: sonnet$/m);
    expect(agent).toMatch(/^tools: Read, Grep, Glob$/m);
  });
});
