import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (rel) => readFile(join(root, rel), 'utf8');

// The three artifacts that must carry the denylist safe-alternatives + escalate
// guidance (#346). The implementer *card* is the source of truth for the compiled
// implementer agent (freshness gate lives in tests/backends/cards.test.mjs), so the
// card is what we assert against here.
const ARTIFACTS = {
  'implementer role card': 'plugin/cards/implementer.md',
  'deliver skill': 'plugin/skills/deliver/SKILL.md',
  'autopilot delivery brief': 'plugin/skills/autopilot/SKILL.md',
};

describe('denylist escalation guidance (#346)', () => {
  // AC-346.1 (role cards) + AC-346.2 (autopilot brief): the safe alternative for
  // every denylisted destructive class is taught up front, in all three artifacts.
  for (const [label, path] of Object.entries(ARTIFACTS)) {
    it(`AC-346.1/AC-346.2: ${label} teaches the safe alternative for each denylisted destructive class`, async () => {
      const s = await read(path);
      // recursive rm (outside build/temp) -> targeted rm <paths>
      expect(s, `${label}: recursive-delete class`).toContain('recursive-delete');
      expect(s, `${label}: recursive rm safe alt`).toContain('targeted `rm <paths>`');
      // git reset --hard -> git revert / git restore <paths>
      expect(s, `${label}: hard-reset class`).toContain('hard-reset');
      expect(s, `${label}: hard-reset safe alt (revert)`).toContain('git revert');
      expect(s, `${label}: hard-reset safe alt (restore)`).toContain('git restore <paths>');
      // force-push -> --force-with-lease, only when explicitly requested
      expect(s, `${label}: force-push class`).toContain('force-push');
      expect(s, `${label}: force-push safe alt`).toContain('--force-with-lease');
      expect(s, `${label}: force-push only-when-requested`).toMatch(/only when explicitly requested/i);
      // git clean -f -> targeted rm
      expect(s, `${label}: git-clean-force class`).toContain('git-clean-force');
    });
  }

  // AC-346.2: the escalate-don't-retry rule is present everywhere (the ticket calls
  // it out specifically for the autopilot delivery brief, but all three carry it).
  for (const [label, path] of Object.entries(ARTIFACTS)) {
    it(`AC-346.2: ${label} states the escalate-don't-retry rule on a denylist block`, async () => {
      const s = await read(path);
      expect(s, `${label}: escalate-don't-retry`).toMatch(/do not retry the blocked command/i);
      expect(s, `${label}: names escalate tool`).toContain('escalate.mjs');
    });
  }

  // AC-346.3: the literal-string / --body-file caveat is present everywhere.
  for (const [label, path] of Object.entries(ARTIFACTS)) {
    it(`AC-346.3: ${label} includes the literal-string caveat (write via --body-file, never inline)`, async () => {
      const s = await read(path);
      expect(s, `${label}: literal-string caveat`).toMatch(/literal-string caveat/i);
      expect(s, `${label}: quoted/heredoc bodies`).toMatch(/quoted\/heredoc bodies/i);
      expect(s, `${label}: --body-file`).toContain('--body-file');
      expect(s, `${label}: never inline on a shell command line`).toMatch(/never inline on a shell command line/i);
    });
  }

  // AC-346.4: the guidance is the SAME canonical block across all three (so the
  // copies can't silently drift). Assert the table header row is byte-identical.
  it('AC-346.4: the safe-alternatives table is identical across the role cards and the delivery brief', async () => {
    const header = '| Blocked class | Safe alternative |';
    for (const [label, path] of Object.entries(ARTIFACTS)) {
      const s = await read(path);
      expect(s, `${label}: missing canonical table header`).toContain(header);
    }
  });

  // AC-346.4: the compiled implementer AGENT (not just the card) carries the
  // guidance — the freshness gate guarantees it, but assert it directly so a
  // stale-agent regression is caught by this file too.
  it('AC-346.4: the compiled implementer agent carries the denylist guidance', async () => {
    const agent = await read('plugin/agents/implementer.md');
    expect(agent).toContain('recursive-delete');
    expect(agent).toContain('--force-with-lease');
    expect(agent).toMatch(/do not retry the blocked command/i);
    expect(agent).toContain('--body-file');
  });
});
