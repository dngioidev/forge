import { describe, it, expect } from 'vitest';
import { tmpdir } from 'node:os';
import { buildStatusMutation, replaceStatusOptions, STANDARD_STATUS, linkProject, optionKey, getRepoInfo, getProjectFields } from '../../plugin/scripts/lib/board.mjs';

describe('linkProject (AC-B64.1, #64)', () => {
  it('AC-B64.1: issues gh project link <n> --owner <o> --repo <slug>', async () => {
    let seen = null;
    const gh = async (args) => { seen = args; return { ok: true }; };
    const res = await linkProject(gh, 'dngioidev', 12, 'dngioidev/forge');
    expect(res).toMatchObject({ ok: true, linked: true });
    expect(seen).toEqual(['project', 'link', '12', '--owner', 'dngioidev', '--repo', 'dngioidev/forge']);
  });

  it('AC-B64.1: an already-linked board is idempotent success, not a failure', async () => {
    const gh = async () => ({ ok: false, stderr: 'project is already linked to this repository' });
    const res = await linkProject(gh, 'dngioidev', 8, 'dngioidev/forge');
    expect(res).toMatchObject({ ok: true, linked: false, note: 'already linked' });
  });

  it('AC-B64.1: a genuine link error surfaces as not-ok', async () => {
    const gh = async () => ({ ok: false, stderr: 'HTTP 403: insufficient scope' });
    const res = await linkProject(gh, 'dngioidev', 8, 'dngioidev/forge');
    expect(res.ok).toBe(false);
    expect(res.error).toContain('403');
  });
});

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

describe('Won\'t do status (AC-117, #117)', () => {
  it("AC-117.3: optionKey maps Won't do -> wontDo; STANDARD_STATUS carries it", () => {
    expect(optionKey("Won't do")).toBe('wontDo');
    expect(optionKey('Wont do')).toBe('wontDo');
    const wd = STANDARD_STATUS.find((s) => s.key === 'wontDo');
    expect(wd?.name).toBe("Won't do");
  });

  it('AC-117.4: buildStatusMutation preserves an existing option id, mints when absent (safe append)', () => {
    const m = buildStatusMutation('PVTSSF_x', [{ id: 'keep1', name: 'Done', color: 'GREEN' }, { name: "Won't do", color: 'GRAY' }]);
    expect(m).toContain('{id: "keep1", name: "Done", color: GREEN, description: ""}'); // preserved
    expect(m).toContain(`{name: "Won't do", color: GRAY, description: ""}`); // no id → minted
  });
});

describe('Program type seeded (AC-89.1, #89)', () => {
  it('AC-89.1: STANDARD_FIELDS.type includes program as a first-class tracker type', async () => {
    const { STANDARD_FIELDS } = await import('../../plugin/scripts/lib/board.mjs');
    const keys = STANDARD_FIELDS.type.map((o) => o.key);
    expect(keys).toContain('program');
    expect(keys).toEqual(expect.arrayContaining(['program', 'epic', 'item', 'bug', 'test']));
    const program = STANDARD_FIELDS.type.find((o) => o.key === 'program');
    expect(program.name).toBe('Program'); // the name a fresh init seeds as a single-select option
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

// #407 AC.3 — board field/option ID lookups are cached per-process/per-run instead
// of re-fetched on every op. A counting gh double stands in for the "same process,
// many ops" case (the long-lived forge-core MCP server; a script calling the same
// lookup more than once); a FRESH gh double (a new test) proves the cache never
// leaks across a different `gh` instance — exactly the isolation a separate
// process/run needs.
describe('getRepoInfo / getProjectFields memoization (AC-407.3)', () => {
  const repoView = () => ({ ok: true, json: { owner: { login: 'dngioidev' }, name: 'forge', defaultBranchRef: { name: 'main' } } });
  const fieldsOk = (itemsCount = 3) => ({
    ok: true,
    json: { data: { node: { items: { totalCount: itemsCount }, fields: { nodes: [{ __typename: 'ProjectV2SingleSelectField', id: 'f1', name: 'Status', options: [{ id: 'o1', name: 'Backlog' }] }] } } } },
  });

  it('getRepoInfo hits gh once per gh instance — a second call for the same gh is served from cache', async () => {
    let calls = 0;
    const gh = async () => { calls++; return repoView(); };
    const first = await getRepoInfo(gh);
    const second = await getRepoInfo(gh);
    expect(first).toMatchObject({ ok: true, owner: 'dngioidev', name: 'forge', defaultBranch: 'main' });
    expect(second).toEqual(first);
    expect(calls).toBe(1); // only the FIRST call reached gh
  });

  it('getRepoInfo({refresh:true}) bypasses AND repopulates the cache', async () => {
    let calls = 0;
    const gh = async () => { calls++; return repoView(); };
    await getRepoInfo(gh);
    await getRepoInfo(gh, { refresh: true });
    expect(calls).toBe(2);
  });

  it('a DIFFERENT gh instance never sees another instance\'s cached repo info (process/run isolation)', async () => {
    let callsA = 0; let callsB = 0;
    const ghA = async () => { callsA++; return repoView(); };
    const ghB = async () => { callsB++; return { ok: true, json: { owner: { login: 'other-owner' }, name: 'other-repo', defaultBranchRef: { name: 'trunk' } } }; };
    await getRepoInfo(ghA);
    const b = await getRepoInfo(ghB);
    expect(callsA).toBe(1);
    expect(callsB).toBe(1); // ghB was NOT served from ghA's cache
    expect(b.owner).toBe('other-owner');
  });

  it('a FAILED getRepoInfo lookup is never cached — the next call can recover', async () => {
    let calls = 0;
    const gh = async () => { calls++; return calls === 1 ? { ok: false, stderr: 'boom' } : repoView(); };
    const first = await getRepoInfo(gh);
    expect(first.ok).toBe(false);
    const second = await getRepoInfo(gh);
    expect(second.ok).toBe(true);
    expect(calls).toBe(2); // both calls reached gh — the failure was not cached
  });

  it('getProjectFields hits gh once per (gh, projectId) — repeat calls for the same project are served from cache', async () => {
    let calls = 0;
    const gh = async () => { calls++; return fieldsOk(); };
    const first = await getProjectFields(gh, 'PVT_1');
    const second = await getProjectFields(gh, 'PVT_1');
    expect(first).toMatchObject({ ok: true, itemsCount: 3 });
    expect(second).toEqual(first);
    expect(calls).toBe(1);
  });

  it('getProjectFields caches PER projectId — a different project on the SAME gh still fetches fresh', async () => {
    let calls = 0;
    const gh = async () => { calls++; return fieldsOk(calls); }; // itemsCount tracks the call number
    const a = await getProjectFields(gh, 'PVT_1');
    const b = await getProjectFields(gh, 'PVT_2');
    const aAgain = await getProjectFields(gh, 'PVT_1');
    expect(calls).toBe(2); // one fetch per distinct projectId
    expect(a.itemsCount).toBe(1);
    expect(b.itemsCount).toBe(2);
    expect(aAgain).toEqual(a); // still cached
  });

  it('getProjectFields({refresh:true}) bypasses AND repopulates the cache (init.mjs post-mutation re-discovery)', async () => {
    let calls = 0;
    const gh = async () => { calls++; return fieldsOk(calls); };
    const before = await getProjectFields(gh, 'PVT_1');
    const after = await getProjectFields(gh, 'PVT_1', { refresh: true });
    expect(calls).toBe(2);
    expect(before.itemsCount).toBe(1);
    expect(after.itemsCount).toBe(2);
  });

  it('a FAILED getProjectFields lookup is never cached', async () => {
    let calls = 0;
    const gh = async () => { calls++; return calls === 1 ? { ok: false, stderr: 'boom' } : fieldsOk(); };
    const first = await getProjectFields(gh, 'PVT_1');
    expect(first.ok).toBe(false);
    const second = await getProjectFields(gh, 'PVT_1');
    expect(second.ok).toBe(true);
    expect(calls).toBe(2);
  });
});

// #415 — the cache key must incorporate the working directory, not just the `gh`
// instance. Today every caller constructs a fresh `gh`/ctx per repo (never
// `chdir()`s a long-lived `gh` into a different repo), so this was a latent
// footgun rather than a live bug — but a `process.chdir()` reuse of the SAME
// `gh` instance must still fetch fresh instead of silently serving the
// previous cwd's cached owner/name/field IDs.
describe('cache key includes cwd, not just the gh instance (AC-415.1-3)', () => {
  const repoViewFor = (owner, name, branch) => ({
    ok: true,
    json: { owner: { login: owner }, name, defaultBranchRef: { name: branch } },
  });
  const fieldsFor = (itemsCount) => ({
    ok: true,
    json: { data: { node: { items: { totalCount: itemsCount }, fields: { nodes: [{ __typename: 'ProjectV2SingleSelectField', id: 'f1', name: 'Status', options: [] }] } } } },
  });

  it('AC-415.1: getRepoInfo does not leak across a process.chdir() reuse of the same gh instance', async () => {
    const originalCwd = process.cwd();
    try {
      let calls = 0;
      const gh = async () => {
        calls++;
        return calls === 1 ? repoViewFor('repoA-owner', 'repoA', 'main') : repoViewFor('repoB-owner', 'repoB', 'trunk');
      };
      const a = await getRepoInfo(gh);
      process.chdir(tmpdir());
      const b = await getRepoInfo(gh);
      expect(a).toMatchObject({ owner: 'repoA-owner', name: 'repoA' });
      expect(b).toMatchObject({ owner: 'repoB-owner', name: 'repoB' }); // NOT repoA's cached value
      expect(calls).toBe(2); // the chdir forced a fresh fetch, not a cache hit

      // and returning to the original cwd is still served from ITS own cache entry
      process.chdir(originalCwd);
      const aAgain = await getRepoInfo(gh);
      expect(aAgain).toEqual(a);
      expect(calls).toBe(2);
    } finally {
      process.chdir(originalCwd);
    }
  });

  it('AC-415.2: getProjectFields does not leak across a process.chdir() reuse for the SAME projectId', async () => {
    const originalCwd = process.cwd();
    try {
      let calls = 0;
      const gh = async () => { calls++; return fieldsFor(calls); };
      const a = await getProjectFields(gh, 'PVT_1');
      process.chdir(tmpdir());
      const b = await getProjectFields(gh, 'PVT_1'); // same projectId, different cwd
      expect(a.itemsCount).toBe(1);
      expect(b.itemsCount).toBe(2); // NOT served from the original cwd's cache entry
      expect(calls).toBe(2);
    } finally {
      process.chdir(originalCwd);
    }
  });
});
