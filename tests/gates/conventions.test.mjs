import { describe, it, expect } from 'vitest';
import { lintSubject, runConventions, CONVENTIONAL_TYPES } from '../../plugin/scripts/gates/conventions.mjs';

const noop = () => {};

describe('conventions gate — commit-subject lint (#310)', () => {
  it('AC-310.2: rejects a garbage subject ("@") and accepts a valid one ("fix(hooks): block pipe-to-shell")', () => {
    const garbage = lintSubject('@');
    expect(garbage.ok).toBe(false);
    expect(garbage.reason).toMatch(/punctuation-only/);

    expect(lintSubject('fix(hooks): block pipe-to-shell')).toEqual({ ok: true });
  });

  it('AC-310.1: rejects empty, whitespace-only, and punctuation-only subjects', () => {
    expect(lintSubject('').ok).toBe(false);
    expect(lintSubject('   ').ok).toBe(false);
    expect(lintSubject('...').ok).toBe(false);
    expect(lintSubject('!!!').ok).toBe(false);
  });

  it('AC-310.1: rejects the exact #310 root-cause subject "@ (#297)"', () => {
    const v = lintSubject('@ (#297)');
    expect(v.ok).toBe(false);
  });

  it('AC-310.1: rejects a header whose description is only an issue ref / punctuation', () => {
    expect(lintSubject('fix: (#297)').ok).toBe(false); // no words after the type
    expect(lintSubject('feat: ...').ok).toBe(false);
  });

  it('AC-310.1: rejects a non-conventional prose subject and an unknown type', () => {
    expect(lintSubject('just fixed some stuff').ok).toBe(false);
    const bad = lintSubject('wibble: do a thing');
    expect(bad.ok).toBe(false);
    expect(bad.reason).toMatch(/unknown type/);
  });

  it('AC-310.1: accepts real historical subject shapes (scope, !, spike, refs)', () => {
    const valid = [
      'feat(gates): guard README version-badge drift in the docsync gate (#327)',
      'fix(hooks): block rm long flags (--recursive --force) in denylist (#324)',
      'test(hooks): contract-test agy safety shims (agy-deny + agy-capture) (#313) (#325)',
      'spike(cross-gai): scope agy-only + decompose #174 into build tickets',
      'chore: release v0.18.0',
      'feat!: drop the legacy roster format',
      'refactor(mcp): factor rpc transport',
    ];
    for (const s of valid) expect(lintSubject(s), s).toEqual({ ok: true });
  });

  it('every accepted type is a lowercase conventional/known type', () => {
    expect(CONVENTIONAL_TYPES).toContain('feat');
    expect(CONVENTIONAL_TYPES).toContain('spike');
    for (const t of CONVENTIONAL_TYPES) expect(t).toMatch(/^[a-z]+$/);
  });

  it('AC-310.1: runConventions wires git log and fails on a garbage subject, passes when clean', async () => {
    const withGarbage = async () => ({
      ok: true,
      stdout: 'abc1234567 @ (#297)\ndef8901234 feat(x): a real change (#5)\n',
      stderr: '',
    });
    const bad = await runConventions({ cwd: '.', execFn: withGarbage, log: noop });
    expect(bad.ok).toBe(false);
    expect(bad.violations).toHaveLength(1);
    expect(bad.violations[0]).toMatchObject({ sha: 'abc1234', subject: '@ (#297)' });

    const clean = async () => ({ ok: true, stdout: 'aaa1111222 fix(hooks): block pipe-to-shell (#311)\n', stderr: '' });
    const good = await runConventions({ cwd: '.', execFn: clean, log: noop });
    expect(good.ok).toBe(true);
    expect(good.violations).toEqual([]);
  });

  it('runConventions surfaces a git error instead of throwing', async () => {
    const boom = async () => ({ ok: false, stdout: '', stderr: 'fatal: bad revision' });
    const res = await runConventions({ cwd: '.', execFn: boom, log: noop });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/git log failed/);
  });
});
