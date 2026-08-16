import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (rel) => readFile(join(root, rel), 'utf8');

describe('forge:triage skill (#469, AC-1/AC-2/AC-3/AC-4/AC-5)', () => {
  it('AC-1: gains a Report contract section with the exact terminal JSON shape', async () => {
    const s = await read('plugin/skills/triage/SKILL.md');
    expect(s).toMatch(/^## Report contract$/m);
    expect(s).toContain('{"issue":<n>,"verdict":"pass|fail","outcome":"ready|escalated"}');
  });

  it('AC-2: documents verdict:pass -> outcome:ready re-entering the autopilot queue via ledger.mjs applyOutcome stage:triage', async () => {
    const s = await read('plugin/skills/triage/SKILL.md');
    expect(s).toMatch(/`verdict:"pass"`\s*→\s*`outcome:"ready"`/);
    expect(s).toMatch(/applyOutcome/);
    expect(s).toMatch(/stage:"triage"/);
    expect(s).toMatch(/re-enters the autopilot queue/i);
  });

  it('AC-3: documents verdict:fail -> outcome:escalated and states the axes are not independent', async () => {
    const s = await read('plugin/skills/triage/SKILL.md');
    expect(s).toMatch(/`verdict:"fail"`\s*→\s*`outcome:"escalated"`/);
    expect(s).toMatch(/Auto-triage front door/);
    expect(s).toMatch(/not independent axes/i);
  });

  it('AC-4: pinning test — fails if the Report contract heading or literal JSON shape is edited out', async () => {
    const s = await read('plugin/skills/triage/SKILL.md');
    // Re-assert both load-bearing strings directly (independent of the AC-1 test)
    // so this test alone pins the contract per the ticket's own wording.
    expect(s).toMatch(/## Report contract/);
    expect(s).toContain('{"issue":<n>,"verdict":"pass|fail","outcome":"ready|escalated"}');
    // placed at the end of the file, same placement as shape/SKILL.md's own section:
    // no other '## ' heading follows it.
    const headings = [...s.matchAll(/^## .+$/gm)].map((m) => m[0]);
    expect(headings[headings.length - 1]).toBe('## Report contract');
  });

  it('AC-5: documentation-only — the runtime contract those files already imply is unchanged (OUTCOMES/RESOLVED_OUTCOMES still admit ready + escalated)', async () => {
    const { OUTCOMES } = await import('../../plugin/scripts/autopilot/ledger.mjs');
    const { RESOLVED_OUTCOMES } = await import('../../plugin/scripts/autopilot/watchdog.mjs');
    for (const outcome of ['ready', 'escalated']) {
      expect(OUTCOMES, 'ledger.mjs OUTCOMES').toContain(outcome);
      expect(RESOLVED_OUTCOMES, 'watchdog.mjs RESOLVED_OUTCOMES').toContain(outcome);
    }
  });
});
