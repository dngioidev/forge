import { describe, it, expect } from 'vitest';
import { buildStatusMutation, replaceStatusOptions, STANDARD_STATUS } from '../../plugin/scripts/lib/board.mjs';

describe('replaceStatusOptions mutation shape (AC-B4.1, #35)', () => {
  it('AC-B4.1: options are inline literals — enum colors bare, names JSON-escaped, no variables', () => {
    const m = buildStatusMutation('PVTSSF_x', STANDARD_STATUS);
    expect(m).toContain('{name: "Backlog", color: GRAY, description: ""}');
    expect(m).toContain('{name: "Blocked / Needs decision", color: RED, description: ""}');
    expect(m).toContain('fieldId: "PVTSSF_x"');
    expect(m).not.toContain('"GRAY"'); // an enum in quotes is the original bug
    expect(m).not.toContain('$options'); // no variables — gh -F stringifies arrays
    expect(m).toContain('singleSelectOptions: [');
    // names with quotes stay valid GraphQL
    expect(buildStatusMutation('f', [{ name: 'a "b"', color: 'GRAY' }])).toContain('{name: "a \\"b\\"", color: GRAY');
  });

  it('AC-B4.1: replaceStatusOptions sends exactly one -f query arg, no -F', async () => {
    let seen = null;
    const gh = async (args) => {
      seen = args;
      return { ok: true, json: { data: { updateProjectV2Field: { projectV2Field: { options: [{ id: 'n1', name: 'Backlog' }] } } } } };
    };
    const res = await replaceStatusOptions(gh, 'PVTSSF_x', STANDARD_STATUS);
    expect(res.ok).toBe(true);
    expect(seen.filter((a) => a === '-F')).toHaveLength(0);
    expect(seen.filter((a) => a === '-f')).toHaveLength(1);
    expect(seen.find((a) => a.startsWith('query='))).toContain('color: GREEN');
  });
});
