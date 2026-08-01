import { describe, it, expect } from 'vitest';
import { parseCommit, deriveBump, nextVersion, groupChanges, renderChangelogSection, renderReleaseBody, summarize } from '../plugin/scripts/release/core.mjs';
import { runRelease, parseArgs } from '../plugin/scripts/release/release.mjs';
import { computeReadiness } from '../plugin/scripts/release/readiness.mjs';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
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

describe('release bumps version files (AC-B10.1, #51)', () => {
  it('AC-B10.1: dry run computes the bump and lists both version files; regex targets only the version key', async () => {
    const { runRelease } = await import('../plugin/scripts/release/release.mjs');
    const { mkdir, writeFile, readFile } = await import('node:fs/promises');
    const cwd = await mkdtemp(join(tmpdir(), 'forge-rel-'));
    await mkdir(join(cwd, 'plugin', '.claude-plugin'), { recursive: true });
    await writeFile(join(cwd, 'package.json'), '{\n  "name": "forge",\n  "version": "0.1.0",\n  "private": true\n}', 'utf8');
    await writeFile(join(cwd, 'plugin', '.claude-plugin', 'plugin.json'), '{\n  "name": "forge",\n  "version": "0.1.0",\n  "description": "version 0.1.0 of things"\n}', 'utf8');
    const execFn = async (cmd, args) => {
      const j = args.join(' ');
      if (j.includes('--abbrev-ref')) return { ok: true, code: 0, stdout: 'main\n', stderr: '' };
      if (j.includes('--porcelain')) return { ok: true, code: 0, stdout: '', stderr: '' };
      if (j.includes('rev-list')) return { ok: true, code: 0, stdout: '0\n', stderr: '' };
      if (j.startsWith('describe')) return { ok: true, code: 0, stdout: 'v0.1.0\n', stderr: '' };
      if (j.startsWith('log')) return { ok: true, code: 0, stdout: 'feat(release): bump version files (#51)\n', stderr: '' };
      if (j.startsWith('diff')) return { ok: true, code: 0, stdout: '', stderr: '' };
      return { ok: true, code: 0, stdout: '', stderr: '' };
    };
    const gh = async () => ({ ok: false, stderr: 'no repo' });
    const res = await runRelease({ cwd, gh, execFn }, { dryRun: true }, () => {});
    expect(res).toMatchObject({ ok: true, dryRun: true, version: '0.2.0', bump: 'minor' });
    expect(res.bumpFiles.sort()).toEqual(['package.json', join('plugin', '.claude-plugin', 'plugin.json')].sort());
    // the replace regex must hit ONLY the version key, not other strings containing versions
    const manifest = await readFile(join(cwd, 'plugin', '.claude-plugin', 'plugin.json'), 'utf8');
    expect(manifest).toContain('"version": "0.1.0"'); // dry run wrote nothing
    const bumped = manifest.replace(/"version":\s*"[^"]+"/, '"version": "0.2.0"');
    expect(bumped).toContain('"version": "0.2.0"');
    expect(bumped).toContain('version 0.1.0 of things'); // description untouched
  });
});

describe('runRelease mutating path (#165)', () => {
  // Seed a temp repo the mutating path can read/write: two version files + a CHANGELOG.
  async function seedRepo({ changelog, pkgPrivate = false } = {}) {
    const cwd = await mkdtemp(join(tmpdir(), 'forge-rel-mut-'));
    await mkdir(join(cwd, 'plugin', '.claude-plugin'), { recursive: true });
    const pkg = { name: 'forge', version: '0.1.0', ...(pkgPrivate ? { private: true } : {}) };
    await writeFile(join(cwd, 'package.json'), JSON.stringify(pkg, null, 2), 'utf8');
    await writeFile(
      join(cwd, 'plugin', '.claude-plugin', 'plugin.json'),
      '{\n  "name": "forge",\n  "version": "0.1.0",\n  "description": "version 0.1.0 of things"\n}',
      'utf8',
    );
    if (changelog !== undefined) await writeFile(join(cwd, 'CHANGELOG.md'), changelog, 'utf8');
    return cwd;
  }

  // Injected git + gh fakes. Every mutating git subcommand and the gh release
  // create push a marker onto `order` AND record its full argv on `calls`, so
  // the test can assert both the exact pipeline sequence and the exact args
  // (version string / refspec) each mutation is invoked with. At `git add` time
  // we snapshot the on-disk files to prove the version-file rewrite + CHANGELOG
  // prepend both happened BEFORE the commit.
  function makeFakes({ cwd, commitOk = true } = {}) {
    const order = [];
    const calls = {};
    const snapshot = {};
    const record = (op, args) => { order.push(op); calls[op] = args; };
    const git = async (_cmd, args) => {
      const sub = args[0];
      const ok = { ok: true, code: 0, stdout: '', stderr: '' };
      switch (sub) {
        case 'rev-parse': return { ...ok, stdout: 'main\n' }; // readiness: on main
        case 'status': return ok; // clean worktree
        case 'fetch': return ok;
        case 'rev-list': return { ...ok, stdout: '0\n' }; // up to date
        case 'describe': return { ...ok, stdout: 'v0.1.0\n' }; // last tag
        case 'log': return { ...ok, stdout: 'feat(release): cover mutating path (#165)\n' };
        case 'diff': return { ...ok, stdout: 'plugin/scripts/release/release.mjs\n' };
        case 'add':
          record('add', args);
          snapshot.pkg = await readFile(join(cwd, 'package.json'), 'utf8');
          snapshot.manifest = await readFile(join(cwd, 'plugin', '.claude-plugin', 'plugin.json'), 'utf8');
          snapshot.changelog = await readFile(join(cwd, 'CHANGELOG.md'), 'utf8');
          return ok;
        case 'commit':
          record('commit', args);
          return commitOk ? ok : { ok: false, code: 1, stdout: '', stderr: 'nothing staged' };
        case 'tag': record('tag', args); return ok;
        case 'push': record('push', args); return ok;
        default: return ok;
      }
    };
    const gh = async (args) => {
      if (args[0] === 'repo') return { ok: true, json: { owner: { login: 'o' }, name: 'r', defaultBranchRef: { name: 'main' } } };
      if (args[0] === 'release') { record('release', args); return { ok: true, stdout: '', stderr: '' }; }
      return { ok: true, stdout: '', stderr: '' };
    };
    return { git, gh, order, calls, snapshot };
  }

  it('AC1: mutates in order version-files -> changelog -> commit -> tag -> push -> release', async () => {
    const cwd = await seedRepo({ changelog: '# Changelog\n\n## v0.1.0 — 2026-01-01\n\n- prior entry\n' });
    const { git, gh, order, calls, snapshot } = makeFakes({ cwd });
    const res = await runRelease({ cwd, gh, execFn: git }, { dryRun: false }, () => {});

    expect(res).toMatchObject({ ok: true, version: '0.2.0', bump: 'minor' });
    // full pipeline sequence, exactly once, in order
    expect(order).toEqual(['add', 'commit', 'tag', 'push', 'release']);

    // each mutation is invoked with the right version string / refspec — a
    // wrong-ref regression (e.g. pushing the wrong tag) fails here.
    expect(calls.add).toEqual(['add', 'CHANGELOG.md', 'package.json', join('plugin', '.claude-plugin', 'plugin.json')]);
    expect(calls.commit).toEqual(['commit', '-m', 'chore(release): v0.2.0']);
    expect(calls.tag).toEqual(['tag', '-a', 'v0.2.0', '-m', 'v0.2.0']);
    expect(calls.push).toEqual(['push', 'origin', 'main', 'v0.2.0']);
    expect(calls.release.slice(0, 3)).toEqual(['release', 'create', 'v0.2.0']);

    // version files + changelog were already rewritten on disk BEFORE the commit
    // (snapshot captured at `git add`, which the code runs right after writing).
    expect(snapshot.pkg).toContain('"version": "0.2.0"');
    expect(snapshot.manifest).toContain('"version": "0.2.0"');
    expect(snapshot.manifest).toContain('version 0.1.0 of things'); // description untouched — regex hit only the version key
    // CHANGELOG marker/startsWith branch: new section inserted right after the marker, prior entry retained
    expect(snapshot.changelog.startsWith('# Changelog\n\n## v0.2.0 — ')).toBe(true);
    expect(snapshot.changelog).toContain('## v0.1.0 — 2026-01-01');
    expect(snapshot.changelog).toContain('- prior entry');

    // final on-disk state matches the snapshot (no post-commit rewrite)
    expect(await readFile(join(cwd, 'package.json'), 'utf8')).toContain('"version": "0.2.0"');

    // npm-publish note derivation (public package)
    expect(res.notes.some((n) => n.includes('npm publish'))).toBe(true);
  });

  it('AC1 (else branch): prepends the section when CHANGELOG lacks the marker; private package suppresses the npm note', async () => {
    // private package also exercises the note-derivation branch at release.mjs:112
    const cwd = await seedRepo({ changelog: 'legacy changelog without marker\n', pkgPrivate: true });
    const { git, gh, order } = makeFakes({ cwd });
    const res = await runRelease({ cwd, gh, execFn: git }, { dryRun: false }, () => {});
    expect(res.ok).toBe(true);
    expect(order).toEqual(['add', 'commit', 'tag', 'push', 'release']);
    const cl = await readFile(join(cwd, 'CHANGELOG.md'), 'utf8');
    expect(cl.startsWith('## v0.2.0 — ')).toBe(true); // no marker -> section prepended verbatim
    expect(cl).toContain('legacy changelog without marker');
    expect(res.notes.some((n) => n.includes('npm publish'))).toBe(false); // private -> no publish note
  });

  it('AC-badge: bumps the README shields.io version badge and stages it (#308 drift guard)', async () => {
    const cwd = await seedRepo({ changelog: '# Changelog\n\n' });
    await writeFile(join(cwd, 'README.md'), '# forge\n[![version](https://img.shields.io/badge/version-0.1.0-blue.svg)](CHANGELOG.md)\n', 'utf8');
    const { git, gh, calls, order } = makeFakes({ cwd });
    const res = await runRelease({ cwd, gh, execFn: git }, { dryRun: false }, () => {});
    expect(res.ok).toBe(true);
    const readme = await readFile(join(cwd, 'README.md'), 'utf8');
    expect(readme).toContain('version-0.2.0-blue.svg'); // badge bumped in lockstep
    expect(readme).not.toContain('version-0.1.0-');
    // README.md is staged alongside the version files + changelog
    expect(calls.add).toEqual(['add', 'CHANGELOG.md', 'package.json', join('plugin', '.claude-plugin', 'plugin.json'), 'README.md']);
    expect(order).toEqual(['add', 'commit', 'tag', 'push', 'release']);
  });

  it('AC2: a failed git commit aborts BEFORE tagging/pushing (no dangling tag, no release)', async () => {
    const cwd = await seedRepo({ changelog: '# Changelog\n\n' });
    const { git, gh, order } = makeFakes({ cwd, commitOk: false });
    const res = await runRelease({ cwd, gh, execFn: git }, { dryRun: false }, () => {});

    expect(res).toEqual({ ok: false, error: 'changelog commit failed' });
    // pipeline stops exactly at the failed commit — no tag ('no dangling local
    // tag'), no push, no gh release ever run.
    expect(order).toEqual(['add', 'commit']);
  });

  it('AC3: parseArgs reads --dry-run and the optional --date override', () => {
    expect(parseArgs(['--dry-run'])).toEqual({ dryRun: true, date: null });
    expect(parseArgs([])).toEqual({ dryRun: false, date: null });
    expect(parseArgs(['--other', '--dry-run', 'x'])).toEqual({ dryRun: true, date: null });
    expect(parseArgs(['--notdryrun'])).toEqual({ dryRun: false, date: null });
    expect(parseArgs(['--date', '2026-08-02'])).toEqual({ dryRun: false, date: '2026-08-02' });
    expect(parseArgs(['--dry-run', '--date', '2026-08-02'])).toEqual({ dryRun: true, date: '2026-08-02' });
  });

  it('AC4: --date overrides the changelog date; a malformed --date is refused', async () => {
    const cwd = await seedRepo({ changelog: '# Changelog\n\n' });
    const { git, gh } = makeFakes({ cwd });
    const lines = [];
    const res = await runRelease({ cwd, gh, execFn: git }, { dryRun: true, date: '2026-08-02' }, (m) => lines.push(m));
    expect(res.ok).toBe(true);
    expect(lines.join('\n')).toContain('## v0.2.0 — 2026-08-02');

    const bad = await runRelease({ cwd, gh, execFn: git }, { dryRun: true, date: 'Aug 2 2026' }, () => {});
    expect(bad).toMatchObject({ ok: false });
    expect(bad.error).toContain('YYYY-MM-DD');
  });
});
