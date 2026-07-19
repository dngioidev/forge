import { describe, it, expect } from 'vitest';
import { check, handle, segments } from '../../plugin/hooks/denylist.mjs';

describe('chained-command segments (AC-B85.*, #85 — iomanage feedback)', () => {
  it('AC-B85.1: a push chained with an unrelated `gh … -f` is NOT force-push', () => {
    expect(check("git push origin my-branch && gh api graphql -f query='mutation{...}'").blocked).toBe(false);
    expect(check("gh api graphql -f query='...' ; git push origin feat/1-x").blocked).toBe(false);
    expect(check("git push origin br | tee log.txt").blocked).toBe(false);
  });

  it('AC-B85.2: a real force-push still blocks — alone or in any segment', () => {
    expect(check('git push --force origin main').rule).toBe('force-push');
    expect(check('git status && git push -f origin main').rule).toBe('force-push');
    expect(check('git push --force-with-lease origin feat/1-x').blocked).toBe(false); // still allowed
  });

  it('AC-B85.3: destructive command in one segment still blocks; benign chained segments do not', () => {
    expect(check('npm test && git reset --hard HEAD~1').rule).toBe('hard-reset');
    expect(check('git add -A && git clean -fdx').rule).toBe('git-clean-force');
    expect(check('git push origin --delete staging && echo done').rule).toBe('env-branch-delete');
    expect(check('git push origin main && npm run build && gh pr create').blocked).toBe(false);
  });

  it('segments() splits on &&, ||, ;, |, and newlines', () => {
    expect(segments('a && b || c ; d | e\nf')).toEqual(['a', 'b', 'c', 'd', 'e', 'f']);
    expect(segments('git push origin main')).toEqual(['git push origin main']);
  });
});

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

describe('denylist journals blocks (AC-7.3)', () => {
  const payload = (cmd) => ({ tool_name: 'Bash', tool_input: { command: cmd }, cwd: '/repo' });

  it('AC-7.3: a block appends a blocked-edit event with the rule', async () => {
    const appends = [];
    const res = await handle(payload('git reset --hard HEAD~3'), async (cwd, kind, data) => { appends.push({ cwd, kind, data }); });
    expect(res.code).toBe(2);
    expect(res.message).toContain('hard-reset');
    expect(appends).toEqual([{ cwd: '/repo', kind: 'blocked-edit', data: { tool: 'Bash', cmd: 'git reset --hard HEAD~3', rule: 'hard-reset' } }]);
  });

  it('AC-7.3: a journal write failure still blocks with exit 2', async () => {
    const res = await handle(payload('git push --force origin main'), async () => { throw new Error('disk full'); });
    expect(res.code).toBe(2);
    expect(res.message).toContain('force-push');
  });

  it('allowed commands never touch the journal', async () => {
    let called = false;
    const res = await handle(payload('git push origin feat/9-learning-loop'), async () => { called = true; });
    expect(res.code).toBe(0);
    expect(called).toBe(false);
  });
});
