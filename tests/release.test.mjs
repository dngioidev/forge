import { describe, it, expect } from 'vitest';
import { parseCommit, deriveBump, nextVersion, groupChanges, renderChangelogSection, renderReleaseBody, summarize } from '../plugin/scripts/release/core.mjs';
import { computeReadiness } from '../plugin/scripts/release/readiness.mjs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { append } from '../plugin/scripts/lib/journal.mjs';

describe('parseCommit + deriveBump (AC-4c.1)', () => {
  it('parses conventional subjects with scope, breaking, tickets', () => {
    expect(parseCommit('feat(board): add digest script (#2)')).toMatchObject({ type: 'feat', scope: 'board', breaking: false, tickets: [2] });
    expect(parseCommit('fix!: drop legacy config (#7)')).toMatchObject({ type: 'fix', breaking: true });
    expect(parseCommit('merge branch whatever')).toBe(null);
  });

  it('bump: highest wins; chore-only → patch; nothing → null', () => {
    expect(deriveBump(['fix: a (#1)'])).toBe('patch');
    expect(deriveBump(['fix: a', 'feat: b'])).toBe('minor');
    expect(deriveBump(['feat: b', 'chore!: drop node 20'])).toBe('major');
    expect(deriveBump(['chore: tidy', 'docs: readme'])).toBe('patch');
    expect(deriveBump(['random noise', 'Merge pull request #9'])).toBe(null);
  });

  it('nextVersion: bumps semver; first release is 0.1.0', () => {
    expect(nextVersion('v1.2.3', 'patch')).toBe('1.2.4');
    expect(nextVersion('v1.2.3', 'minor')).toBe('1.3.0');
    expect(nextVersion('v1.2.3', 'major')).toBe('2.0.0');
    expect(nextVersion(null, 'minor')).toBe('0.1.0');
  });
});

describe('changelog + release body (AC-4c.2, AC-4c.4)', () => {
  const subjects = ['feat(board): digest script (#2)', 'fix: statusline crash (#5)', 'feat!: new config shape (#7)'];

  it('groups by type with linked ticket refs', () => {
    const groups = groupChanges(subjects);
    const section = renderChangelogSection('1.1.0', '2026-07-16', groups, 'https://github.com/o/r');
    expect(section).toContain('## v1.1.0 — 2026-07-16');
    expect(section).toContain('### Features');
    expect(section).toContain('[#2](https://github.com/o/r/issues/2)');
    expect(section).toContain('**[breaking]**');
    expect(section).toContain('### Fixes');
  });

  it('release body carries the generated shape incl. deploy notes + digest', () => {
    const groups = groupChanges(subjects);
    const body = renderReleaseBody({
      version: '1.1.0', summary: summarize(groups, '1.1.0'), groups, repoUrl: null,
      infraChanged: true, migrations: false, imageDigest: 'ghcr.io/o/r:sha-abc',
    });
    expect(body).toContain('### Deploy notes');
    expect(body).toContain('Infra changed: **yes**');
    expect(body).toContain('Migrations to run: no');
    expect(body).toContain('ghcr.io/o/r:sha-abc');
    expect(body).toContain('retagged `v1.1.0`');
  });
});

describe('readiness (AC-4c.3)', () => {
  function gitExec(overrides = {}) {
    return async (cmd, args) => {
      const key = `${cmd} ${args.join(' ')}`;
      for (const [prefix, res] of Object.entries(overrides)) {
        if (key.startsWith(prefix)) return typeof res === 'function' ? res() : res;
      }
      if (key.startsWith('git rev-parse --abbrev-ref')) return { ok: true, stdout: 'main\n', stderr: '' };
      if (key.startsWith('git status')) return { ok: true, stdout: '', stderr: '' };
      if (key.startsWith('git fetch')) return { ok: true, stdout: '', stderr: '' };
      if (key.startsWith('git rev-list')) return { ok: true, stdout: '0\n', stderr: '' };
      if (key.startsWith('echo-verify')) return { ok: true, stdout: '', stderr: '' };
      return { ok: true, stdout: '', stderr: '' };
    };
  }

  it('all-green readiness passes with feature items skipped', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'forge-rel-'));
    const r = await computeReadiness({ cwd, execFn: gitExec(), config: { features: {} }, verifyCmd: 'echo-verify ok' });
    expect(r.ok).toBe(true);
    expect(r.items.find((i) => i.name === 'staging-smoke').level).toBe('skip');
    expect(r.items.find((i) => i.name === 'ac-gate').level).toBe('skip');
  });

  it('refuses: wrong branch, dirty tree, behind remote, verify red, critical findings', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'forge-rel-'));
    const branch = await computeReadiness({ cwd, execFn: gitExec({ 'git rev-parse --abbrev-ref': { ok: true, stdout: 'feat/6-release\n' } }), config: {}, verifyCmd: null });
    expect(branch.ok).toBe(false);

    const dirty = await computeReadiness({ cwd, execFn: gitExec({ 'git status': { ok: true, stdout: ' M file\n' } }), config: {}, verifyCmd: null });
    expect(dirty.ok).toBe(false);

    const behind = await computeReadiness({ cwd, execFn: gitExec({ 'git rev-list': { ok: true, stdout: '2\n' } }), config: {}, verifyCmd: null });
    expect(behind.ok).toBe(false);

    const red = await computeReadiness({ cwd, execFn: gitExec({ 'pnpm verify': { ok: false, stdout: '', stderr: 'boom' } }), config: {}, verifyCmd: 'pnpm verify' });
    expect(red.ok).toBe(false);

    const cwd2 = await mkdtemp(join(tmpdir(), 'forge-rel-'));
    await append(cwd2, 'review-finding', { severity: 'critical', summary: 'injection', role: 'security' });
    const crit = await computeReadiness({ cwd: cwd2, execFn: gitExec(), config: {}, verifyCmd: null });
    expect(crit.ok).toBe(false);
    expect(crit.items.find((i) => i.name === 'findings').msg).toContain('critical');
  });
});
