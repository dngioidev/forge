import { describe, it, expect } from 'vitest';
import { ALLOWED_COMMAND_PREFIXES, isAllowedCommand } from '../../plugin/scripts/lib/allowed-commands.mjs';
import { ALLOW } from '../../plugin/scripts/autopilot/perms.mjs';
import { splitSegments } from '../../plugin/scripts/lib/shell-split.mjs';

describe('#429 — single-sourced command allowlist (AC-429.4)', () => {
  it('AC-429.4: every prefix appears in the Claude host ALLOW as Bash(<prefix>:*) — perms.mjs derives from, not forks, the shared list', () => {
    for (const prefix of ALLOWED_COMMAND_PREFIXES) {
      expect(ALLOW, `perms.mjs ALLOW missing ${prefix}`).toContain(`Bash(${prefix}:*)`);
    }
    // And nothing in ALLOW is NOT explained by the shared list (no copy-pasted extras).
    expect(ALLOW).toHaveLength(ALLOWED_COMMAND_PREFIXES.length);
  });

  it('AC-429.4: perms.ALLOW is a pure map over ALLOWED_COMMAND_PREFIXES — same order, one source', () => {
    expect(ALLOW).toEqual(ALLOWED_COMMAND_PREFIXES.map((p) => `Bash(${p}:*)`));
  });

  it('AC-429.2: isAllowedCommand() allows every listed prefix used bare or with trailing args', () => {
    for (const prefix of ALLOWED_COMMAND_PREFIXES) {
      expect(isAllowedCommand(prefix, { segments: splitSegments }), prefix).toBe(true);
      expect(isAllowedCommand(`${prefix} --flag value`, { segments: splitSegments }), prefix).toBe(true);
    }
  });

  it('isAllowedCommand() rejects an unrecognised command and a look-alike prefix without the required word boundary', () => {
    expect(isAllowedCommand('curl https://example.com', { segments: splitSegments })).toBe(false);
    // "git pushx" must not be confused with the "git push" prefix.
    expect(isAllowedCommand('git pushx origin', { segments: splitSegments })).toBe(false);
  });
});
