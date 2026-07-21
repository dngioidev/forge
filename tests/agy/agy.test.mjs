import { describe, it, expect } from 'vitest';
import { agyEnabled, agyArgs, runAgy, INLINE_RULE, DEFAULT_MODEL } from '../../plugin/scripts/agy/core.mjs';
import { buildAsk, runAgyAsk } from '../../plugin/scripts/agy/ask.mjs';
import { buildBrief } from '../../plugin/scripts/review/agy-opinion.mjs';

describe('agy shared core (#162)', () => {
  it('AC.2: features.agy is the umbrella; geminiSecondOpinion still works', () => {
    expect(agyEnabled({})).toBe(false);
    expect(agyEnabled({ features: { agy: true } })).toBe(true);
    expect(agyEnabled({ features: { geminiSecondOpinion: true } })).toBe(true); // back-compat
  });

  it('AC.1: every brief demands complete INLINE output (the live-test fix — no file)', () => {
    expect(INLINE_RULE).toMatch(/Do NOT write it to a file/i);
    expect(buildBrief({})).toContain(INLINE_RULE);
    expect(buildAsk('where is X')).toContain(INLINE_RULE);
  });

  it('runAgy: skips when off (no exec), returns output when on, fails soft', async () => {
    let called = false;
    const off = await runAgy({}, { prompt: 'p', cwd: '/r' }, async () => { called = true; return { ok: true, stdout: 'x' }; });
    expect(off).toMatchObject({ ok: false, skipped: true });
    expect(called).toBe(false);

    const on = { features: { agy: true } };
    const good = await runAgy(on, { prompt: 'p', cwd: '/r' }, async (cmd, args) => {
      expect(args).toContain('--print');
      expect(args[args.indexOf('--mode') + 1]).toBe('plan'); // read-only
      return { ok: true, stdout: 'answer' };
    });
    expect(good).toMatchObject({ ok: true, model: DEFAULT_MODEL, output: 'answer' });

    expect((await runAgy(on, { prompt: 'p', cwd: '/r' }, async () => ({ ok: false, stderr: 'nope' }))).ok).toBe(false);
    const threw = await runAgy(on, { prompt: 'p', cwd: '/r' }, async () => { throw new Error('ENOENT'); });
    expect(threw).toMatchObject({ ok: false });
    expect(threw.error).toMatch(/ENOENT/);
  });

  it('agyArgs is headless + read-only', () => {
    const a = agyArgs({ prompt: 'P', cwd: '/r' });
    expect(a).toContain('--print');
    expect(a).toContain('--dangerously-skip-permissions');
    expect(a[a.indexOf('--mode') + 1]).toBe('plan');
  });
});

describe('agy ask — read-only codebase Q&A (#162, AC.3)', () => {
  it('brief is read-only and factual, and carries the question', () => {
    const b = buildAsk('where does the merge bar live?');
    expect(b).toMatch(/READ-ONLY/i);
    expect(b).toMatch(/Do NOT modify/i);
    expect(b).toMatch(/where does the merge bar live\?/);
    expect(b).toMatch(/not found.*rather than guessing/i);
  });

  it('requires a question, returns the answer via injected exec, skips when off', async () => {
    const on = { features: { agy: true } };
    expect((await runAgyAsk(on, { cwd: '/r', question: '' })).error).toMatch(/question is required/);
    const ans = await runAgyAsk(on, { cwd: '/r', question: 'where is X' }, async () => ({ ok: true, stdout: 'in foo.mjs' }));
    expect(ans).toMatchObject({ ok: true, answer: 'in foo.mjs' });
    const off = await runAgyAsk({}, { cwd: '/r', question: 'where is X' }, async () => ({ ok: true, stdout: 'x' }));
    expect(off).toMatchObject({ ok: false, skipped: true });
  });
});
