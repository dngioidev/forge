import { describe, it, expect } from 'vitest';
import { mkdtemp, readFile, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  recordDependency, clearDependency, pendingDependencies, resolveDependencies, DEPENDENCIES_RELDIR,
} from '../../plugin/scripts/lib/dependencies.mjs';

async function tmp() {
  return mkdtemp(join(tmpdir(), 'forge-dep-'));
}

/** A minimal fake gh — resolves `gh(['issue','view',N,...])` from an in-memory state map. */
function fakeGh(states) {
  return async (args) => {
    const n = Number(args[args.indexOf('view') + 1]);
    if (!(n in states)) return { ok: false, error: `no such issue #${n}` };
    return { ok: true, json: { state: states[n] } };
  };
}

describe('lib/dependencies.mjs (#487 AC.1/AC.3/AC.4)', () => {
  it('recordDependency writes a durable record; pendingDependencies reads it back', async () => {
    const cwd = await tmp();
    expect(await pendingDependencies(cwd)).toEqual([]); // no dir yet — degrades safely
    const rec = await recordDependency(cwd, { issue: 449, dependsOn: 457, reason: 'sequenced behind #457' });
    expect(rec).toMatchObject({ issue: 449, dependsOn: 457, reason: 'sequenced behind #457' });
    expect(typeof rec.recordedAt).toBe('string');
    const pending = await pendingDependencies(cwd);
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ issue: 449, dependsOn: 457 });
    // on disk under the documented relpath, one file per issue
    const raw = JSON.parse(await readFile(join(cwd, DEPENDENCIES_RELDIR, '449.json'), 'utf8'));
    expect(raw).toMatchObject({ issue: 449, dependsOn: 457 });
  });

  it('recordDependency is last-write-wins per issue (re-triage of the same ticket supersedes, never accumulates)', async () => {
    const cwd = await tmp();
    await recordDependency(cwd, { issue: 449, dependsOn: 457, reason: 'sequenced behind #457' });
    await recordDependency(cwd, { issue: 449, dependsOn: 460, reason: 'sequenced behind #460 (re-triaged)' });
    const pending = await pendingDependencies(cwd);
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ issue: 449, dependsOn: 460 });
  });

  it('clearDependency drops the record; idempotent on a missing one', async () => {
    const cwd = await tmp();
    await recordDependency(cwd, { issue: 449, dependsOn: 457 });
    await clearDependency(cwd, 449);
    expect(await pendingDependencies(cwd)).toEqual([]);
    await expect(clearDependency(cwd, 449)).resolves.toBeUndefined(); // no throw on missing file
  });

  it('pendingDependencies tolerates a corrupt/unreadable record file rather than crashing selection', async () => {
    const cwd = await tmp();
    await mkdir(join(cwd, DEPENDENCIES_RELDIR), { recursive: true });
    await writeFile(join(cwd, DEPENDENCIES_RELDIR, '1.json'), '{not json', 'utf8');
    await recordDependency(cwd, { issue: 2, dependsOn: 3 });
    const pending = await pendingDependencies(cwd);
    expect(pending).toHaveLength(1);
    expect(pending[0].issue).toBe(2);
  });

  it('AC.3: resolveDependencies clears a dependency whose blocker has closed, and leaves an open one pending', async () => {
    const cwd = await tmp();
    await recordDependency(cwd, { issue: 449, dependsOn: 457, reason: 'sequenced behind #457' });
    await recordDependency(cwd, { issue: 450, dependsOn: 458, reason: 'sequenced behind #458' });
    const gh = fakeGh({ 457: 'CLOSED', 458: 'OPEN' });
    const result = await resolveDependencies(cwd, { gh });
    expect(result.cleared.map((d) => d.issue)).toEqual([449]);
    expect(result.stillPending.map((d) => d.issue)).toEqual([450]);
    const pending = await pendingDependencies(cwd);
    expect(pending.map((d) => d.issue)).toEqual([450]); // 449's record is gone on disk
  });

  it('a failed gh lookup (network blip, unknown issue) leaves the record untouched — fails safe toward still-blocked', async () => {
    const cwd = await tmp();
    await recordDependency(cwd, { issue: 449, dependsOn: 457 });
    const gh = fakeGh({}); // 457 not found → ok:false
    const result = await resolveDependencies(cwd, { gh });
    expect(result.cleared).toEqual([]);
    expect(result.stillPending).toHaveLength(1);
    expect(await pendingDependencies(cwd)).toHaveLength(1);
  });

  it('resolveDependencies is a no-op on an empty store (no gh calls, no crash)', async () => {
    const cwd = await tmp();
    let calls = 0;
    const gh = async () => { calls++; return { ok: true, json: { state: 'CLOSED' } }; };
    const result = await resolveDependencies(cwd, { gh });
    expect(result).toEqual({ cleared: [], stillPending: [] });
    expect(calls).toBe(0);
  });
});
