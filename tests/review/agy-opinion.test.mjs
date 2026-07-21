import { describe, it, expect } from 'vitest';
import {
  agyEnabled, buildBrief, agyArgs, runAgyOpinion, DEFAULT_MODEL, DEFAULT_COMMAND,
} from '../../plugin/scripts/review/agy-opinion.mjs';

describe('Gemini second opinion via agy (#160)', () => {
  it('AC.4: opt-in — off unless features.geminiSecondOpinion is true', () => {
    expect(agyEnabled({})).toBe(false);
    expect(agyEnabled({ features: {} })).toBe(false);
    expect(agyEnabled({ features: { geminiSecondOpinion: true } })).toBe(true);
  });

  it('AC.1: the brief is advisory, read-only, skeptical, and carries the ACs', () => {
    const b = buildBrief({ ticket: 42, acs: ['AC-1: does X', 'AC-2: does Y'] });
    expect(b).toMatch(/ADVISORY/);
    expect(b).toMatch(/must NOT modify/i);
    expect(b).toMatch(/independent/i);
    expect(b).toMatch(/severity-tagged|critical \| high/i);
    expect(b).toMatch(/AC-1: does X/);
  });

  it('AC.2: the invocation is headless print, repo in scope, read-only plan mode', () => {
    const args = agyArgs({ prompt: 'P', cwd: '/repo', model: 'gemini-3.1-pro-high' });
    expect(args).toContain('--print');
    expect(args[args.indexOf('--add-dir') + 1]).toBe('/repo');
    expect(args[args.indexOf('--model') + 1]).toBe('gemini-3.1-pro-high');
    expect(args).toContain('--mode');
    expect(args[args.indexOf('--mode') + 1]).toBe('plan');
    expect(args).toContain('--dangerously-skip-permissions');
  });

  it('AC.3: skips when off; returns the critique when on; fails soft, never throws', async () => {
    // off → skipped, no exec
    let called = false;
    const off = await runAgyOpinion({}, { cwd: '/r' }, async () => { called = true; return { ok: true, stdout: 'x' }; });
    expect(off).toMatchObject({ ok: false, skipped: true });
    expect(called).toBe(false);

    // on → returns the model's critique
    const on = { features: { geminiSecondOpinion: true } };
    const good = await runAgyOpinion(on, { cwd: '/r', ticket: 1 }, async (cmd, args) => {
      expect(cmd).toBe(DEFAULT_COMMAND);
      expect(args).toContain('--print');
      return { ok: true, stdout: 'critical: null deref in foo()\n' };
    });
    expect(good).toMatchObject({ ok: true, model: DEFAULT_MODEL });
    expect(good.critique).toMatch(/null deref/);

    // agy missing / nonzero exit → soft failure, not a throw
    const bad = await runAgyOpinion(on, { cwd: '/r' }, async () => ({ ok: false, stderr: 'not found' }));
    expect(bad.ok).toBe(false);
    expect(bad.error).toMatch(/not found|PATH/);
    const threw = await runAgyOpinion(on, { cwd: '/r' }, async () => { throw new Error('ENOENT'); });
    expect(threw).toMatchObject({ ok: false });
    expect(threw.error).toMatch(/ENOENT/);
  });

  it('respects a configured command + model override', async () => {
    const cfg = { features: { geminiSecondOpinion: true }, agy: { command: 'agy.exe', model: 'gemini-3.5-flash-high' } };
    const seen = {};
    await runAgyOpinion(cfg, { cwd: '/r' }, async (cmd, args) => { seen.cmd = cmd; seen.model = args[args.indexOf('--model') + 1]; return { ok: true, stdout: '' }; });
    expect(seen.cmd).toBe('agy.exe');
    expect(seen.model).toBe('gemini-3.5-flash-high');
  });
});
