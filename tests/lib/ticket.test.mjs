import { describe, it, expect } from 'vitest';
import { parseBranch } from '../../plugin/scripts/lib/ticket.mjs';

describe('parseBranch', () => {
  it('AC-1.5: parses a work branch into type/ticket/slug', () => {
    expect(parseBranch('feat/15-button')).toMatchObject({ kind: 'work', type: 'feat', ticket: 15, slug: 'button', role: null, isAgentChild: false });
  });

  it('parses every conventional type', () => {
    for (const t of ['feat', 'fix', 'chore', 'docs', 'refactor', 'test', 'perf']) {
      expect(parseBranch(`${t}/7-x`).ticket).toBe(7);
    }
  });

  it('AC-1.5: parses an agent child branch (--role suffix)', () => {
    expect(parseBranch('feat/15-button--implementer')).toMatchObject({ kind: 'work', ticket: 15, role: 'implementer', isAgentChild: true });
  });

  it('classifies spike and hotfix branches as their own kinds', () => {
    expect(parseBranch('spike/22-animation-lib').kind).toBe('spike');
    expect(parseBranch('hotfix/31-login-500').kind).toBe('hotfix');
  });

  it('classifies main and environment branches', () => {
    expect(parseBranch('main').kind).toBe('main');
    expect(parseBranch('staging')).toMatchObject({ kind: 'env', env: 'staging' });
    expect(parseBranch('production', { environments: ['production'] }).kind).toBe('env');
  });

  it('rejects non-conforming names, detached HEAD, and empties', () => {
    expect(parseBranch('random-branch').kind).toBe('unknown');
    expect(parseBranch('feat/no-number').kind).toBe('unknown');
    expect(parseBranch('feature/15-x').kind).toBe('unknown');
    expect(parseBranch('HEAD').kind).toBe('unknown');
    expect(parseBranch('').kind).toBe('unknown');
    expect(parseBranch(undefined).kind).toBe('unknown');
  });
});
