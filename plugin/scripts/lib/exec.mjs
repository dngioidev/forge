import { spawn } from 'node:child_process';

/**
 * Windows-safe process runner. Always argv arrays, never a shell string —
 * untrusted content cannot become shell syntax (spec §13 anti-injection).
 *
 * The `.cmd`/`.bat` EINVAL lesson: Node refuses to spawn cmd scripts without
 * a shell (CVE-2024-27980 fix). We never pass shell:true with interpolated
 * strings; instead cmd scripts are routed through cmd.exe with an argv array.
 */
export async function run(command, args = [], options = {}) {
  const first = await spawnOnce(command, args, options);
  // Windows: bare commands that are .cmd/.bat shims (pnpm, npm, npx…) fail
  // ENOENT without a shell — retry routed through cmd.exe, still argv-only.
  if (!first.ok && first.code === -1 && process.platform === 'win32'
      && /ENOENT/.test(first.stderr) && !/[\\/]/.test(command) && !/\.(exe|cmd|bat)$/i.test(command)) {
    return spawnOnce(command, args, options, true);
  }
  return first;
}

function spawnOnce(command, args = [], options = {}, viaComSpec = false) {
  let cmd = command;
  let argv = args;
  if (process.platform === 'win32' && (viaComSpec || /\.(cmd|bat)$/i.test(command))) {
    cmd = process.env.ComSpec || 'cmd.exe';
    argv = ['/d', '/s', '/c', command, ...args];
  }
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(cmd, argv, { shell: false, windowsHide: true, ...options });
    } catch (err) {
      resolve({ ok: false, code: -1, stdout: '', stderr: String(err && err.message || err) });
      return;
    }
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (d) => { stdout += d; });
    child.stderr?.on('data', (d) => { stderr += d; });
    child.on('error', (err) => resolve({ ok: false, code: -1, stdout, stderr: String(err && err.message || err) }));
    child.on('close', (code) => resolve({ ok: code === 0, code, stdout, stderr }));
  });
}

/**
 * #360 — GitHub rate-limit backoff.
 *
 * The GraphQL bucket is 5,000 points/hour *shared account-wide* across every
 * repo and tool. A multi-repo forge user (or forge running alongside other
 * tooling) exhausts it fast; Projects v2 board ops and the merge bar's
 * statusCheckRollup are all GraphQL. Without backoff the run hard-fails on a raw
 * 403 and stalls. These helpers are pure so the retry decision is unit-tested
 * with a mocked rate-limited response — no real API and no real sleep.
 */

/** Does a gh result carry GitHub's rate-limit signature? (pure — AC.1) */
export function isRateLimited(res) {
  if (!res || res.ok) return false;
  const text = `${res.stderr || ''}\n${res.stdout || ''}`;
  // `x-ratelimit-remaining: 0` (headers on a -i/verbose error), the REST/GraphQL
  // "API rate limit exceeded" body, the GraphQL RATE_LIMITED type, or a secondary
  // (abuse) limit. A bare 403 alone is NOT enough — it must mention a rate limit.
  if (/x-ratelimit-remaining:\s*0/i.test(text)) return true;
  if (/API rate limit exceeded/i.test(text)) return true;
  if (/secondary rate limit/i.test(text)) return true;
  if (/\bRATE_LIMITED\b/.test(text)) return true;
  if (/\b403\b/.test(text) && /rate limit/i.test(text)) return true;
  return false;
}

/**
 * How long to wait before the next retry, in ms (pure — AC.1). Honors the reset
 * window when the response exposes it (`x-ratelimit-reset` epoch seconds, or a
 * `retry-after` seconds hint for secondary limits); otherwise exponential
 * backoff by attempt. Bounded: reset waits cap at `resetCapMs`, the exponential
 * fallback at `capMs`. `now`/`attempt` are injected so a test drives it without
 * a real clock.
 */
export function retryDelayFrom(res, { now = Date.now(), attempt = 0, baseMs = 1000, capMs = 60000, resetCapMs = 15 * 60 * 1000 } = {}) {
  const text = `${(res && res.stderr) || ''}\n${(res && res.stdout) || ''}`;
  const reset = /x-ratelimit-reset:\s*(\d+)/i.exec(text);
  if (reset) {
    const wait = Number(reset[1]) * 1000 - now;
    if (wait > 0) return Math.min(wait + 1000, resetCapMs); // +1s cushion past the reset
  }
  const retryAfter = /retry-after:\s*(\d+)/i.exec(text);
  if (retryAfter) return Math.min(Number(retryAfter[1]) * 1000 + 1000, resetCapMs);
  return Math.min(baseMs * 2 ** attempt, capMs); // 1s, 2s, 4s, 8s … capped
}

/** The clear, actionable line forge surfaces instead of a raw 403 (AC.2). */
export function rateLimitNotice(res, delayMs, attempt, max) {
  const text = `${(res && res.stderr) || ''}\n${(res && res.stdout) || ''}`;
  const rem = /x-ratelimit-remaining:\s*(\d+)/i.exec(text);
  const remaining = rem ? rem[1] : '0';
  const secs = Math.ceil(delayMs / 1000);
  return `forge: GitHub API rate limit hit (remaining ${remaining}, reset in ~${secs}s) — backing off, retrying (attempt ${attempt}/${max})`;
}

const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * gh CLI wrapper factory. The exec function is injectable so every consumer
 * (init, doctor) is testable with scripted responses instead of a live gh.
 *
 * #360: a rate-limited response is not hard-failed — the wrapper backs off and
 * retries (bounded by `maxRetries`), honoring the reset window, and surfaces an
 * actionable line each wait (AC.1 + AC.2). `sleep`/`now`/`log` are injected so a
 * test drives the retry→succeed path with no real API and no real delay.
 */
export function makeGh(execFn = run, { maxRetries = 5, sleep = defaultSleep, now = Date.now, log = console.error } = {}) {
  return async function gh(args, { parseJson = false } = {}) {
    let res;
    for (let attempt = 0; ; attempt++) {
      res = await execFn('gh', args);
      if (res.ok || attempt >= maxRetries || !isRateLimited(res)) break;
      const delay = retryDelayFrom(res, { now: now(), attempt });
      log(rateLimitNotice(res, delay, attempt + 1, maxRetries));
      await sleep(delay);
    }
    if (parseJson && res.ok) {
      try {
        return { ...res, json: JSON.parse(res.stdout) };
      } catch {
        return { ...res, ok: false, json: null, stderr: `gh returned unparseable JSON for: gh ${args.join(' ')}` };
      }
    }
    return res;
  };
}

/**
 * AC.4 — GraphQL budget preflight. Reads `gh api rate_limit` (a REST call that
 * itself does NOT count against any bucket) so a batch (e.g. an autopilot
 * iteration) can check the shared GraphQL budget and degrade gracefully — pause
 * and surface the reset window — rather than firing calls that will 403.
 * Returns `{ ok, remaining, limit, resetInSec, low }`; `low` trips at `lowWater`.
 */
export async function rateBudget(gh, { lowWater = 200, now = () => Math.floor(Date.now() / 1000) } = {}) {
  const res = await gh(['api', 'rate_limit'], { parseJson: true });
  if (!res.ok || !res.json) return { ok: false, error: res.stderr || 'rate_limit query failed' };
  const g = res.json.resources?.graphql ?? {};
  const remaining = g.remaining ?? 0;
  const resetInSec = Math.max(0, (g.reset ?? 0) - now());
  return { ok: true, remaining, limit: g.limit ?? 0, resetInSec, low: remaining <= lowWater };
}
