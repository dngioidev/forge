import { describe, it, expect } from 'vitest';
import { newDeps, checkPackage, runDepGuard, MIN_AGE_DAYS } from '../../plugin/scripts/gates/depguard.mjs';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const noop = () => {};
const NOW = Date.parse('2026-07-16T00:00:00Z');

function fetchFor(registry) {
  return async (url) => {
    if (url.startsWith('https://registry.npmjs.org/')) {
      const name = decodeURIComponent(url.split('/').pop());
      const pkg = registry[name];
      if (!pkg) return { ok: false, status: 404 };
      return { ok: true, json: async () => ({ time: { created: pkg.created } }) };
    }
    if (url.startsWith('https://api.npmjs.org/downloads')) {
      const name = decodeURIComponent(url.split('/').pop());
      const pkg = registry[name];
      return { ok: true, json: async () => ({ downloads: pkg?.downloads ?? 0 }) };
    }
    return { ok: false, status: 500 };
  };
}

describe('dep guard (AC-5.4)', () => {
  it('newDeps diffs dependencies + devDependencies vs base', () => {
    const base = { dependencies: { a: '1' }, devDependencies: { vitest: '3' } };
    const branch = { dependencies: { a: '1', 'left-pad': '1' }, devDependencies: { vitest: '3', 'brand-new': '0.0.1' } };
    expect(newDeps(base, branch).sort()).toEqual(['brand-new', 'left-pad']);
    expect(newDeps(branch, base)).toEqual([]); // removals are fine
  });

  it('checkPackage: nonexistent, too-young, low-downloads, healthy', async () => {
    const fetchFn = fetchFor({
      healthy: { created: '2020-01-01T00:00:00Z', downloads: 100000 },
      young: { created: '2026-07-01T00:00:00Z', downloads: 100000 },
      obscure: { created: '2020-01-01T00:00:00Z', downloads: 3 },
    });
    expect((await checkPackage('ghost-pkg', { fetchFn, now: NOW })).reason).toContain('does not exist');
    expect((await checkPackage('young', { fetchFn, now: NOW })).reason).toContain(`< ${MIN_AGE_DAYS}`);
    expect((await checkPackage('obscure', { fetchFn, now: NOW })).reason).toContain('weekly downloads');
    expect((await checkPackage('healthy', { fetchFn, now: NOW })).ok).toBe(true);
  });

  it('runDepGuard: only new deps are checked; violations fail the gate', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'forge-dep-'));
    await writeFile(join(cwd, 'package.json'), JSON.stringify({ dependencies: { existing: '1', 'ghost-pkg': '1' } }), 'utf8');
    const execFn = async (cmd, args) => ({ ok: true, stdout: JSON.stringify({ dependencies: { existing: '1' } }), stderr: '' });
    const res = await runDepGuard({ cwd, execFn, fetchFn: fetchFor({}), log: noop });
    expect(res.ok).toBe(false);
    expect(res.added).toEqual(['ghost-pkg']);
    expect(res.violations[0].reason).toContain('does not exist');
  });

  it('runDepGuard: no new deps passes without registry calls', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'forge-dep-'));
    await writeFile(join(cwd, 'package.json'), JSON.stringify({ dependencies: { existing: '1' } }), 'utf8');
    let fetched = 0;
    const execFn = async () => ({ ok: true, stdout: JSON.stringify({ dependencies: { existing: '1' } }), stderr: '' });
    const res = await runDepGuard({ cwd, execFn, fetchFn: async () => { fetched++; return { ok: false, status: 500 }; }, log: noop });
    expect(res.ok).toBe(true);
    expect(fetched).toBe(0);
  });
});
