import { describe, it, expect } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { run } from '../plugin/scripts/lib/exec.mjs';
import { composeLine, extractContext, renderBar } from '../plugin/scripts/statusline.mjs';

const script = join(dirname(fileURLToPath(import.meta.url)), '..', 'plugin', 'scripts', 'statusline.mjs');

async function runStatusline(payloadOrRaw) {
  const { spawn } = await import('node:child_process');
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [script], { windowsHide: true });
    let stdout = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.on('close', (code) => resolve({ code, stdout }));
    child.stdin.write(typeof payloadOrRaw === 'string' ? payloadOrRaw : JSON.stringify(payloadOrRaw));
    child.stdin.end();
  });
}

async function gitRepoOnBranch(branch) {
  const dir = await mkdtemp(join(tmpdir(), 'forge-sl-'));
  await run('git', ['-C', dir, 'init', '-q', '-b', 'main']);
  await run('git', ['-C', dir, 'config', 'user.email', 't@t.t']);
  await run('git', ['-C', dir, 'config', 'user.name', 't']);
  await run('git', ['-C', dir, 'commit', '--allow-empty', '-q', '-m', 'x']);
  if (branch !== 'main') await run('git', ['-C', dir, 'checkout', '-q', '-b', branch]);
  return dir;
}

describe('statusline v2 composition (AC-B7.1, AC-B7.5)', () => {
  it('AC-B7.1: full strip when the payload provides everything', () => {
    const line = composeLine({
      situation: 'idle', pendingCount: 0, project: 'cms', branch: 'feat/12-widget', ticket: 12,
      context: { used: 450_000, max: 1_000_000 }, model: 'Fable 5', costUsd: 0.42,
    });
    expect(line).toBe('▶ cms · #12 feat/12-widget · ▓▓▓▓░░░░ 45% · Fable 5 · $0.42');
  });

  it('AC-B9.1: effort + rate-limit segments render when present, omit when absent', () => {
    const line = composeLine({
      situation: 'idle', project: 'forge', branch: 'main', effort: 'high',
      rateLimits: { five_hour: { used_percentage: 23.5 }, seven_day: { used_percentage: 41.2 } },
    });
    expect(line).toBe('· forge · main · effort:high · 5h 24% / 7d 41%');
    expect(composeLine({ situation: 'idle', project: 'f', branch: 'main', rateLimits: { seven_day: { used_percentage: 10 } } })).toContain('· 7d 10%');
    expect(composeLine({ situation: 'idle', project: 'f', branch: 'main', rateLimits: {} })).toBe('· f · main');
  });

  it('AC-B7.1: absent segments omit silently', () => {
    expect(composeLine({ situation: 'idle', project: 'forge', branch: 'main' })).toBe('· forge · main');
  });

  it('AC-B7.5: glyph priority — 🔒 > 🔥 > 🚩n > ▶ (work/hotfix branch) > ·', () => {
    const base = { project: 'x', branch: 'feat/1-a', ticket: 1 };
    expect(composeLine({ ...base, situation: 'security-response' })).toMatch(/^🔒 /);
    expect(composeLine({ ...base, situation: 'incident' })).toMatch(/^🔥 /);
    expect(composeLine({ ...base, situation: 'awaiting-decision', pendingCount: 2 })).toMatch(/^🚩2 /);
    expect(composeLine({ ...base, situation: 'idle' })).toMatch(/^▶ /);
    expect(composeLine({ project: 'x', branch: 'hotfix/2-b', ticket: 2, situation: 'idle' })).toMatch(/^▶ /);
    expect(composeLine({ project: 'x', branch: 'main', situation: 'idle' })).toMatch(/^· /);
  });
});

describe('context bar (AC-B7.2)', () => {
  it('AC-B7.2 + AC-B8.1: extractContext handles the payload shapes incl. the documented one; absent -> null', () => {
    // AC-B8.1: the documented Claude Code payload shape
    expect(extractContext({ context_window: { total_input_tokens: 489_500, total_output_tokens: 1200, context_window_size: 1_000_000, used_percentage: 49, current_usage: null } })).toEqual({ used: 489_500, max: 1_000_000 });
    expect(extractContext({ context_window: { used_percentage: 49 } })).toEqual({ used: 49, max: 100 });
    expect(extractContext({ context_window: { used_tokens: 1, max_tokens: 4 } })).toEqual({ used: 1, max: 4 });
    expect(extractContext({ context: { used: 2, max: 8 } })).toEqual({ used: 2, max: 8 });
    expect(extractContext({ usage: { input_tokens: 3, context_window_size: 6 } })).toEqual({ used: 3, max: 6 });
    expect(extractContext({ cost: { context_window: { tokens_used: 1, limit: 2 } } })).toEqual({ used: 1, max: 2 });
    expect(extractContext({ model: { display_name: 'x' } })).toBe(null);
    expect(extractContext(null)).toBe(null);
    expect(extractContext({ context: { used: 1, max: 0 } })).toBe(null); // divide-by-zero guarded
  });

  it('AC-B7.2: bar fill and percent; clamped at 100%', () => {
    expect(renderBar({ used: 0, max: 100 })).toBe('░░░░░░░░ 0%');
    expect(renderBar({ used: 50, max: 100 })).toBe('▓▓▓▓░░░░ 50%');
    expect(renderBar({ used: 100, max: 100 })).toBe('▓▓▓▓▓▓▓▓ 100%');
    expect(renderBar({ used: 250, max: 100 })).toBe('▓▓▓▓▓▓▓▓ 100%');
  });
});

describe('statusline e2e (AC-B7.3, AC-B7.4)', () => {
  it('AC-B7.3: project comes from the workspace dir basename; ticket + branch from git', async () => {
    const dir = await gitRepoOnBranch('feat/12-widget');
    const res = await runStatusline({ workspace: { current_dir: dir }, model: { display_name: 'Fable 5' }, context_window: { used_tokens: 500, max_tokens: 1000 } });
    expect(res.code).toBe(0);
    expect(res.stdout).toBe(`▶ ${dir.split(/[\\/]/).pop()} · #12 feat/12-widget · ▓▓▓▓░░░░ 50% · Fable 5`);
  });

  it('AC-B7.3: branch without a ticket still renders', async () => {
    const dir = await gitRepoOnBranch('main');
    const res = await runStatusline({ workspace: { current_dir: dir } });
    expect(res.code).toBe(0);
    expect(res.stdout).toBe(`· ${dir.split(/[\\/]/).pop()} · main`);
  });

  it('AC-B7.4: never breaks the session — non-git dir empty output, exit 0', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'forge-sl-'));
    const res = await runStatusline({ workspace: { current_dir: dir } });
    expect(res.code).toBe(0);
    expect(res.stdout).toBe('');
  });

  it('AC-B7.4: never breaks the session — garbage stdin exit 0', async () => {
    const res = await runStatusline('not json at all');
    expect(res.code).toBe(0);
  });
});
