/**
 * Claude Code quota capture + summary (C8/#79; spec §3d). The statusline payload
 * carries rate_limits (5h/7d used %) and cost, but only Claude Code sees it. An
 * OPT-IN statusline side-effect appends numeric-only samples here; the console
 * reads them into a quota panel. Numbers only — never prompt content (§13).
 *
 * Opt-in by design: capture happens only when `.forge/quota.capture` exists.
 * Honest limit: the panel is only as fresh as the last status-line refresh.
 */
import { appendFile, mkdir, readFile, stat } from 'node:fs/promises';
import { join, dirname } from 'node:path';

export const QUOTA_RELPATH = join('.forge', 'quota.jsonl');
export const QUOTA_MARKER = join('.forge', 'quota.capture');

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** Opt-in switch: the marker file's presence enables capture. */
export async function captureEnabled(cwd) {
  try { await stat(join(cwd, QUOTA_MARKER)); return true; } catch { return false; }
}

/**
 * Append one sample — ONLY the four numbers, nothing else can leak. No-op unless
 * capture is enabled; silent on any failure (a status line must never break).
 */
export async function appendQuotaSample(cwd, { ts, fiveHour, sevenDay, cost } = {}) {
  try {
    if (!(await captureEnabled(cwd))) return { ok: true, wrote: false };
    const rec = { ts: typeof ts === 'string' ? ts : new Date().toISOString(), fiveHour: num(fiveHour), sevenDay: num(sevenDay), cost: num(cost) };
    const path = join(cwd, QUOTA_RELPATH);
    await mkdir(dirname(path), { recursive: true });
    await appendFile(path, JSON.stringify(rec) + '\n', 'utf8');
    return { ok: true, wrote: true, rec };
  } catch { return { ok: false, wrote: false }; }
}

/** Read parsed samples (oldest→newest), tolerant of a missing/partial file. */
export async function readSamples(cwd, { limit = 500 } = {}) {
  let raw;
  try { raw = await readFile(join(cwd, QUOTA_RELPATH), 'utf8'); } catch { return []; }
  const out = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch { /* skip half-written tail */ }
  }
  return out.slice(-limit);
}

const dir = (a, b) => (num(a) == null || num(b) == null ? null : a - b > 1 ? 'up' : b - a > 1 ? 'down' : 'flat');

/**
 * Summarize samples into panel data. `latest` = newest sample's numbers; `trend`
 * = direction vs the window's first sample; `costByDay` = the peak session cost
 * seen per calendar day (the payload cost is a running session total, so per-day
 * max is the honest approximation). Empty/partial → {count:0,…}, never throws.
 */
export function summarizeQuota(samples, { now } = {}) {
  void now;
  const s = (samples ?? []).filter((x) => x && typeof x === 'object');
  if (!s.length) return { count: 0, latest: null, trend: null, costByDay: [] };
  const latest = s[s.length - 1];
  const first = s[0];
  const byDay = new Map();
  for (const x of s) {
    const day = typeof x.ts === 'string' ? x.ts.slice(0, 10) : null;
    if (!day || num(x.cost) == null) continue;
    if (x.cost > (byDay.get(day) ?? 0)) byDay.set(day, x.cost);
  }
  return {
    count: s.length,
    latest: { fiveHour: num(latest.fiveHour), sevenDay: num(latest.sevenDay), cost: num(latest.cost) },
    trend: { fiveHour: dir(latest.fiveHour, first.fiveHour), sevenDay: dir(latest.sevenDay, first.sevenDay) },
    costByDay: [...byDay.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([day, cost]) => ({ day, cost })),
  };
}
