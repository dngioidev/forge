import { describe, it, expect } from 'vitest';
import { parseBackendId, resolveBackend, ROLES, SWAPPABLE } from '../../plugin/scripts/backends/loader.mjs';

describe('parseBackendId', () => {
  it('parses runtime:model, bare runtime, and rejects junk', () => {
    expect(parseBackendId('agy:gemini-flash')).toEqual({ runtime: 'agy', model: 'gemini-flash' });
    expect(parseBackendId('claude:sonnet')).toEqual({ runtime: 'claude', model: 'sonnet' });
    expect(parseBackendId('agy')).toEqual({ runtime: 'agy', model: null });
    expect(parseBackendId('')).toBe(null);
    expect(parseBackendId(null)).toBe(null);
  });
});

describe('resolveBackend — swap allowlist (AC-4.2)', () => {
  it('swappable roles accept non-Claude backends', () => {
    for (const role of SWAPPABLE) {
      const r = resolveBackend(role, { [role]: { backend: 'agy:gemini-flash' } }, 'feat/4-x');
      expect(r).toMatchObject({ ok: true, runtime: 'agy', model: 'gemini-flash', warnings: [] });
    }
  });

  it('pinned roles ignore non-Claude entries with a warning', () => {
    for (const role of ['reviewer', 'security', 'scoper', 'test-architect', 'devops', 'designer', 'design-reviewer']) {
      const r = resolveBackend(role, { [role]: { backend: 'codex:gpt-5' } }, 'feat/4-x');
      expect(r.runtime).toBe('claude');
      expect(r.warnings[0]).toContain('pinned to claude');
    }
  });

  it('pinned roles may still change Claude model via roster', () => {
    const r = resolveBackend('reviewer', { reviewer: { backend: 'claude:opus' } }, 'feat/4-x');
    expect(r).toMatchObject({ runtime: 'claude', model: 'opus', warnings: [] });
  });

  it('implementer: non-Claude only on an agent child branch', () => {
    const onChild = resolveBackend('implementer', { implementer: { backend: 'agy:gemini-pro' } }, 'feat/15-button--implementer');
    expect(onChild).toMatchObject({ runtime: 'agy', model: 'gemini-pro', warnings: [] });

    const onWork = resolveBackend('implementer', { implementer: { backend: 'agy:gemini-pro' } }, 'feat/15-button');
    expect(onWork.runtime).toBe('claude');
    expect(onWork.warnings[0]).toContain('child branch');

    const wrongRole = resolveBackend('implementer', { implementer: { backend: 'agy' } }, 'feat/15-button--reviewer');
    expect(wrongRole.runtime).toBe('claude');
  });

  it('defaults apply when the roster is silent; unknown role errors', () => {
    expect(resolveBackend('security', {}, 'x')).toMatchObject({ runtime: 'claude', model: 'fable' });
    expect(resolveBackend('librarian', {}, 'x')).toMatchObject({ runtime: 'claude', model: 'haiku' });
    const bad = resolveBackend('wizard', {}, 'x');
    expect(bad.ok).toBe(false);
    expect(ROLES.length).toBe(11);
  });

  it('optional + fallback flow through', () => {
    const r = resolveBackend('second-opinion', { 'second-opinion': { backend: 'codex:gpt-5', optional: true } }, 'x');
    expect(r).toMatchObject({ runtime: 'codex', optional: true });
    const f = resolveBackend('investigator', { investigator: { backend: 'agy:gemini-flash', fallback: 'claude:haiku' } }, 'x');
    expect(f.fallback).toMatchObject({ runtime: 'claude', model: 'haiku' });
  });
});
