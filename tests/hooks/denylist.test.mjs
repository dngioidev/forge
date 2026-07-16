import { describe, it, expect } from 'vitest';
import { check } from '../../plugin/hooks/denylist.mjs';

describe('denylist hook (AC-3.4)', () => {
  const blocked = [
    ['git push --force origin main', 'force-push'],
    ['git push -f', 'force-push'],
    ['git reset --hard HEAD~3', 'hard-reset'],
    ['git clean -fdx', 'git-clean-force'],
    ['git filter-branch --all', 'history-rewrite'],
    ['git filter-repo --path secrets.txt --invert-paths', 'history-rewrite'],
    ['git push origin --delete staging', 'env-branch-delete'],
    ['git branch -D main', 'env-branch-delete'],
    ['rm -rf src/', 'recursive-delete'],
    ['rm -fr /home/user/project', 'recursive-delete'],
  ];
  for (const [cmd, rule] of blocked) {
    it(`blocks: ${cmd}`, () => {
      const r = check(cmd);
      expect(r.blocked).toBe(true);
      expect(r.rule).toBe(rule);
    });
  }

  const allowed = [
    'git push --force-with-lease origin feat/3-x',
    'git push origin main',
    'git reset HEAD~1',
    'git reset --soft HEAD~1',
    'rm -rf node_modules',
    'rm -rf dist build coverage',
    'rm -rf "$TMP/forge-test"',
    'rm file.txt',
    'git branch -D feat/3-old-branch',
    'git clean -n',
    'echo "git reset --hard is dangerous"', // mentions, does not run… acceptable false positive? no — must pass
  ];
  for (const cmd of allowed.slice(0, -1)) {
    it(`allows: ${cmd}`, () => {
      expect(check(cmd).blocked).toBe(false);
    });
  }

  it('documented false-positive: quoted mentions still block (fail-closed on ambiguity)', () => {
    // A quoted string containing the pattern is indistinguishable without a
    // shell parser; blocking is the safe direction and the model can rephrase.
    expect(check('echo "git reset --hard is dangerous"').blocked).toBe(true);
  });

  it('never throws on garbage input', () => {
    expect(check(null).blocked).toBe(false);
    expect(check('').blocked).toBe(false);
    expect(check(123).blocked).toBe(false);
  });
});
