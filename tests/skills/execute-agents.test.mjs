import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (rel) => readFile(join(root, rel), 'utf8');

describe('forge:execute-agents skill (AC-118, #118)', () => {
  it('AC-118.1: exists, names itself, and mandates subagent fan-out per task', async () => {
    const s = await read('plugin/skills/execute-agents/SKILL.md');
    expect(s).toMatch(/^name:\s*execute-agents$/m);
    expect(s).toMatch(/Task tool/);            // real spawns, not inline
    expect(s).toMatch(/subagent/i);
    for (const role of ['scoper', 'test-architect', 'implementer', 'reviewer']) {
      expect(s, `missing role ${role}`).toContain(role);
    }
    expect(s).toMatch(/ledger/);               // orchestrator keeps state
    expect(s).toMatch(/acgate\.mjs|gates\//);  // and the mechanical gates
    expect(s).toMatch(/verdict/);              // consumes the terminal JSON report
  });

  it('AC-118.2: every role it spawns has a compiled agent definition', async () => {
    for (const role of ['scoper', 'test-architect', 'implementer', 'reviewer', 'security', 'design-reviewer']) {
      const agent = await read(`plugin/agents/${role}.md`);
      expect(agent.length, `agent ${role} missing`).toBeGreaterThan(50);
    }
  });
});
