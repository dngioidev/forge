#!/usr/bin/env node
/**
 * Smoke test (spec §10): poll a healthcheck URL until healthy or out of
 * retries. Used by the deploy workflows post-deploy and runnable locally.
 * Exit codes: 0 healthy · 1 unhealthy after retries · 2 bad arguments.
 */
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export function parseArgs(argv) {
  const a = { url: null, retries: 10, timeout: 60_000 };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--url') a.url = argv[++i];
    else if (argv[i] === '--retries') a.retries = Number(argv[++i]);
    else if (argv[i] === '--timeout') a.timeout = Number(argv[++i]);
  }
  return a;
}

export async function smoke({ url, retries, timeout, fetchFn = fetch, log = console.log, sleepMs = null }) {
  if (!url || !/^https?:\/\//.test(url)) return { code: 2, error: `--url must be an http(s) URL, got '${url}'` };
  if (!Number.isFinite(retries) || retries < 1) return { code: 2, error: '--retries must be >= 1' };
  const deadline = Date.now() + timeout;
  const perTryDelay = Math.max(500, Math.floor(timeout / retries / 2));
  for (let i = 1; i <= retries; i++) {
    try {
      const res = await fetchFn(url, { signal: AbortSignal.timeout(5000) });
      if (res.ok) {
        log(`smoke: healthy (${res.status}) after ${i} attempt(s)`);
        return { code: 0, attempts: i };
      }
      log(`smoke: attempt ${i}/${retries} — HTTP ${res.status}`);
    } catch (err) {
      log(`smoke: attempt ${i}/${retries} — ${err.message}`);
    }
    if (Date.now() > deadline) break;
    if (i < retries) await new Promise((r) => setTimeout(r, sleepMs ?? perTryDelay));
  }
  return { code: 1, error: `unhealthy after ${retries} attempts / ${timeout}ms` };
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  smoke(parseArgs(process.argv.slice(2))).then((res) => {
    if (res.code !== 0) console.error(`smoke failed: ${res.error}`);
    process.exit(res.code);
  });
}
