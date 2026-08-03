import { describe, it, expect } from 'vitest';
import { run, makeGh, isRateLimited, retryDelayFrom, rateLimitNotice, rateBudget } from '../../plugin/scripts/lib/exec.mjs';

describe('run', () => {
  it('runs a real process and captures stdout', async () => {
    const res = await run(process.execPath, ['-e', 'console.log("hi")']);
    expect(res.ok).toBe(true);
    expect(res.stdout.trim()).toBe('hi');
  });

  it('reports nonzero exit codes as not ok', async () => {
    const res = await run(process.execPath, ['-e', 'process.exit(3)']);
    expect(res.ok).toBe(false);
    expect(res.code).toBe(3);
  });

  it('resolves (never throws) for a missing binary', async () => {
    const res = await run('definitely-not-a-real-binary-xyz', []);
    expect(res.ok).toBe(false);
    expect(res.code).not.toBe(0); // -1 direct, or cmd.exe's nonzero on the Windows retry path
  });

  it('bare .cmd-shim commands resolve cross-platform (the pnpm ENOENT lesson)', async () => {
    const res = await run('pnpm', ['--version']);
    expect(res.ok).toBe(true);
    expect(res.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('the .cmd EINVAL lesson: cmd scripts are routed through cmd.exe on Windows', async function () {
    if (process.platform !== 'win32') return; // Windows-only regression
    const { mkdtemp, writeFile } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = await mkdtemp(join(tmpdir(), 'forge-exec-'));
    const script = join(dir, 'hello.cmd');
    await writeFile(script, '@echo cmd-ok\r\n', 'utf8');
    const res = await run(script, []);
    expect(res.ok).toBe(true);
    expect(res.stdout).toContain('cmd-ok');
  });
});

describe('makeGh', () => {
  it('is injectable: consumers can script gh responses', async () => {
    const calls = [];
    const gh = makeGh(async (cmd, args) => {
      calls.push([cmd, ...args]);
      return { ok: true, code: 0, stdout: '{"title":"forge - AI dev platform"}', stderr: '' };
    });
    const res = await gh(['project', 'view', '8'], { parseJson: true });
    expect(calls[0][0]).toBe('gh');
    expect(res.json.title).toContain('forge');
  });

  it('flags unparseable JSON instead of throwing', async () => {
    const gh = makeGh(async () => ({ ok: true, code: 0, stdout: 'not json', stderr: '' }));
    const res = await gh(['x'], { parseJson: true });
    expect(res.ok).toBe(false);
    expect(res.json).toBe(null);
  });
});

// #360 — GraphQL rate-limit backoff.
const RL_403 = { ok: false, code: 1, stdout: '', stderr: 'HTTP 403: API rate limit exceeded for user ID 123 (https://docs.github.com/…)' };

describe('isRateLimited (AC-360.1)', () => {
  it('detects the REST/GraphQL "API rate limit exceeded" body', () => {
    expect(isRateLimited(RL_403)).toBe(true);
  });
  it('detects x-ratelimit-remaining: 0 headers', () => {
    expect(isRateLimited({ ok: false, code: 1, stdout: '', stderr: 'HTTP 403\nx-ratelimit-remaining: 0\nx-ratelimit-reset: 1785764483' })).toBe(true);
  });
  it('detects the GraphQL RATE_LIMITED type and secondary limits', () => {
    expect(isRateLimited({ ok: false, stderr: '{"errors":[{"type":"RATE_LIMITED"}]}' })).toBe(true);
    expect(isRateLimited({ ok: false, stderr: 'You have exceeded a secondary rate limit' })).toBe(true);
  });
  it('does NOT flag a plain success or an unrelated 403', () => {
    expect(isRateLimited({ ok: true, stdout: '{}', stderr: '' })).toBe(false);
    expect(isRateLimited({ ok: false, stderr: 'HTTP 403: Resource not accessible by integration' })).toBe(false);
    expect(isRateLimited(null)).toBe(false);
  });
});

describe('retryDelayFrom (AC-360.1)', () => {
  it('honors the reset window when x-ratelimit-reset is present', () => {
    const now = 1_000_000_000_000; // ms
    const res = { ok: false, stderr: `x-ratelimit-reset: ${now / 1000 + 30}` }; // reset 30s out
    const delay = retryDelayFrom(res, { now, attempt: 0 });
    expect(delay).toBe(30_000 + 1000); // wait to reset + 1s cushion
  });
  it('caps a far-future reset at resetCapMs', () => {
    const now = 1_000_000_000_000;
    const res = { ok: false, stderr: `x-ratelimit-reset: ${now / 1000 + 99999}` };
    expect(retryDelayFrom(res, { now, attempt: 0 })).toBe(15 * 60 * 1000);
  });
  it('falls back to exponential backoff (capped) with no reset header', () => {
    const r = RL_403;
    expect(retryDelayFrom(r, { attempt: 0 })).toBe(1000);
    expect(retryDelayFrom(r, { attempt: 3 })).toBe(8000);
    expect(retryDelayFrom(r, { attempt: 20 })).toBe(60_000); // capMs
  });
});

describe('makeGh rate-limit backoff (AC-360.1 / AC-360.2)', () => {
  it('a mocked rate-limited response is handled gracefully: retry → succeed', async () => {
    let calls = 0;
    const slept = [];
    const logs = [];
    const gh = makeGh(
      async () => (++calls === 1 ? RL_403 : { ok: true, code: 0, stdout: '{"ok":true}', stderr: '' }),
      { sleep: async (ms) => { slept.push(ms); }, now: () => 0, log: (m) => logs.push(m) },
    );
    const res = await gh(['project', 'item-list'], { parseJson: true });
    expect(res.ok).toBe(true);          // recovered rather than hard-failing
    expect(res.json.ok).toBe(true);
    expect(calls).toBe(2);              // one rate-limited attempt, then success
    expect(slept).toEqual([1000]);      // backed off once (injected sleep, no real delay)
    // AC.2: an actionable line, not a raw 403
    expect(logs[0]).toMatch(/rate limit hit .*reset in ~1s.*retrying \(attempt 1\/5\)/);
  });

  it('gives up after maxRetries and returns the last rate-limited result (bounded)', async () => {
    let calls = 0;
    const gh = makeGh(async () => { calls++; return RL_403; }, { maxRetries: 3, sleep: async () => {}, now: () => 0, log: () => {} });
    const res = await gh(['x']);
    expect(res.ok).toBe(false);
    expect(calls).toBe(4); // initial + 3 retries, then stop
  });

  it('does not retry a non-rate-limit failure', async () => {
    let calls = 0;
    const gh = makeGh(async () => { calls++; return { ok: false, code: 1, stdout: '', stderr: 'HTTP 404: Not Found' }; }, { sleep: async () => {}, log: () => {} });
    const res = await gh(['x']);
    expect(res.ok).toBe(false);
    expect(calls).toBe(1);
  });
});

describe('rateLimitNotice (AC-360.2)', () => {
  it('surfaces remaining + reset-in-Ns + retrying', () => {
    const line = rateLimitNotice({ stderr: 'x-ratelimit-remaining: 0' }, 42_000, 2, 5);
    expect(line).toContain('remaining 0');
    expect(line).toContain('reset in ~42s');
    expect(line).toContain('attempt 2/5');
  });
});

describe('rateBudget (AC-360.4)', () => {
  const RATE = { resources: { graphql: { limit: 5000, remaining: 120, reset: 100 } } };
  it('reports the shared GraphQL budget and flags low', async () => {
    const gh = makeGh(async (cmd, args) => {
      expect(args).toEqual(['api', 'rate_limit']);
      return { ok: true, code: 0, stdout: JSON.stringify(RATE), stderr: '' };
    });
    const b = await rateBudget(gh, { lowWater: 200, now: () => 40 });
    expect(b).toMatchObject({ ok: true, remaining: 120, limit: 5000, resetInSec: 60, low: true });
  });
  it('not low when remaining is comfortable', async () => {
    const gh = makeGh(async () => ({ ok: true, code: 0, stdout: JSON.stringify({ resources: { graphql: { limit: 5000, remaining: 4000, reset: 0 } } }), stderr: '' }));
    expect((await rateBudget(gh, { lowWater: 200 })).low).toBe(false);
  });
  it('surfaces an error when the query fails', async () => {
    const gh = makeGh(async () => ({ ok: false, code: 1, stdout: '', stderr: 'boom' }));
    expect(await rateBudget(gh)).toMatchObject({ ok: false });
  });
});
