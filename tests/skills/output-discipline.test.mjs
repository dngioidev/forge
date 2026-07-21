import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (rel) => readFile(join(root, rel), 'utf8');

describe('orchestration skills are quiet by contract (#158)', () => {
  const skills = [
    'plugin/skills/autopilot/SKILL.md',
    'plugin/skills/deliver/SKILL.md',
    'plugin/skills/execute/SKILL.md',
    'plugin/skills/execute-agents/SKILL.md',
  ];

  it('each carries an Output discipline section: trail is the record, one status line, prose only for escalations + final', async () => {
    for (const path of skills) {
      const s = await read(path);
      expect(s, `${path} missing Output discipline`).toMatch(/## Output discipline/);
      expect(s, `${path} should name the record`).toMatch(/trail.*record|ledger.*record|record —/i);
      expect(s, `${path} should cap per-unit output`).toMatch(/one terse status line|status line per/i);
      expect(s, `${path} should forbid re-narration`).toMatch(/re-narrate|preamble|recap/i);
      expect(s, `${path} should reserve prose for escalations + final`).toMatch(/escalations.*(final|report|summary|result)/is);
      expect(s, `${path} should surface verdict/outcome not working`).toMatch(/verdict.*note|outcome, not|not its working/i);
    }
  });
});
