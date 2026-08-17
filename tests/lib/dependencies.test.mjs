import { describe, it, expect } from 'vitest';
import { mkdtemp, readFile, mkdir, writeFile, access } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  recordDependency, clearDependency, pendingDependencies, resolveDependencies, parseArgs, DEPENDENCIES_RELDIR,
} from '../../plugin/scripts/lib/dependencies.mjs';

const DEPENDENCIES_CLI = fileURLToPath(new URL('../../plugin/scripts/lib/dependencies.mjs', import.meta.url));

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

describe('lib/dependencies.mjs — #487 security fix-wave (forge:security round 1): path-traversal / validation', () => {
  it('recordDependency rejects a non-integer issue rather than writing outside .forge/autopilot/dependencies/', async () => {
    const cwd = await tmp();
    const traversal = '../../../../../../Windows/Temp/pwned';
    await expect(recordDependency(cwd, { issue: traversal, dependsOn: 457 })).rejects.toThrow(/positive integer/);
    // rejected before any path is ever constructed — the store directory doesn't even exist
    await expect(access(join(cwd, DEPENDENCIES_RELDIR))).rejects.toThrow();
  });

  it('recordDependency rejects a non-integer/zero/negative issue or dependsOn', async () => {
    const cwd = await tmp();
    for (const bad of [NaN, 1.5, 0, -1, '449', null, undefined]) {
      await expect(recordDependency(cwd, { issue: bad, dependsOn: 457 }), `issue=${bad}`).rejects.toThrow();
      await expect(recordDependency(cwd, { issue: 1, dependsOn: bad }), `dependsOn=${bad}`).rejects.toThrow();
    }
    expect(await pendingDependencies(cwd)).toEqual([]); // no partial/corrupt record left behind by a rejected call
  });

  it('pendingDependencies skips a record whose embedded issue does not match its filename (tampered/renamed file)', async () => {
    const cwd = await tmp();
    await recordDependency(cwd, { issue: 449, dependsOn: 457 });
    // simulate a renamed/tampered file: filename says 450, content still says issue:449
    await mkdir(join(cwd, DEPENDENCIES_RELDIR), { recursive: true });
    const raw = await readFile(join(cwd, DEPENDENCIES_RELDIR, '449.json'), 'utf8');
    await writeFile(join(cwd, DEPENDENCIES_RELDIR, '450.json'), raw, 'utf8');
    const pending = await pendingDependencies(cwd);
    // 449.json (matches) is kept; 450.json (mismatched) is treated as corrupt and skipped
    expect(pending.map((d) => d.issue).sort()).toEqual([449]);
  });
});

describe('lib/dependencies.mjs CLI (#487 security fix-wave: recordDependency now has an invocable, validated entry point)', () => {
  it('parseArgs reads --issue/--depends-on/--reason', () => {
    expect(parseArgs(['--issue', '449', '--depends-on', '457', '--reason', 'x'])).toEqual({ issue: 449, dependsOn: 457, reason: 'x' });
    expect(parseArgs([])).toEqual({ issue: null, dependsOn: null, reason: null });
  });

  it('`record` writes a validated record on disk; `list` reads it back', async () => {
    const cwd = await tmp();
    const out1 = execFileSync(process.execPath, [DEPENDENCIES_CLI, 'record', '--issue', '449', '--depends-on', '457', '--reason', 'sequenced behind #457'], { cwd, encoding: 'utf8' });
    expect(out1).toMatch(/recorded #449 sequenced behind #457/);
    const out2 = execFileSync(process.execPath, [DEPENDENCIES_CLI, 'list'], { cwd, encoding: 'utf8' });
    expect(out2).toMatch(/#449.*sequenced behind #457/);
    const pending = await pendingDependencies(cwd);
    expect(pending).toHaveLength(1);
  });

  it('`record` with a malformed --issue exits non-zero and writes nothing', async () => {
    const cwd = await tmp();
    expect(() => execFileSync(process.execPath, [DEPENDENCIES_CLI, 'record', '--issue', 'not-a-number', '--depends-on', '457'], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }))
      .toThrow();
    expect(await pendingDependencies(cwd)).toEqual([]);
  });

  it('`list` on an empty store says so rather than printing nothing', async () => {
    const cwd = await tmp();
    const out = execFileSync(process.execPath, [DEPENDENCIES_CLI, 'list'], { cwd, encoding: 'utf8' });
    expect(out).toMatch(/none pending/);
  });
});
