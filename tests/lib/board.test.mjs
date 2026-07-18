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

describe('createSingleSelectField mutation shape (AC-B11.1, #55)', () => {
  it('AC-B11.1: inline literals, bare enum colors, no -F variables', async () => {
    const { buildCreateFieldMutation, createSingleSelectField, STANDARD_FIELDS } = await import('../../plugin/scripts/lib/board.mjs');
    const m = buildCreateFieldMutation('PVT_x', 'Priority', STANDARD_FIELDS.priority);
    expect(m).toContain('{name: "P0", color: RED, description: ""}');
    expect(m).toContain('dataType: SINGLE_SELECT, name: "Priority"');
    expect(m).not.toContain('"RED"');
    expect(m).not.toContain('$options');
    let seen = null;
    const gh = async (args) => { seen = args; return { ok: true, json: { data: { createProjectV2Field: { projectV2Field: { id: 'f1' } } } } }; };
    const res = await createSingleSelectField(gh, 'PVT_x', 'Priority', STANDARD_FIELDS.priority);
    expect(res.ok).toBe(true);
    expect(seen.filter((a) => a === '-F')).toHaveLength(0);
    expect(seen.filter((a) => a === '-f')).toHaveLength(1);
  });
});
