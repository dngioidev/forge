#!/usr/bin/env node
/**
 * autopilot self-pause near the 5h session usage window (#378, epic #183).
 *
 * Spike (docs/spikes/2026-08-05-session-window-detection.md — PR #381; read it
 * from that PR/branch if it hasn't merged to main yet) confirmed
 * no pull-based API exists for "time remaining in the current session window" —
 * the only real signal is the statusline hook's push-only `rate_limits` payload
 * (Pro/Max only, after the first response). Owner-approved mechanism (decision
 * on #378, 2026-08-05, `esc-378-msfttmev` option a): `statusline.mjs` writes that
 * payload to a local file on every invocation (a narrow, owner-signed exception
 * to ADR-0003's quota-capture removal — see ADR-0003 § Consequences); this module
 * reads it back and decides whether the loop should pause.
 *
 * Pure by design, mirroring preflight.mjs/ledger.mjs: `shouldPause` / `isFresh` /
 * `configuredThresholdPct` take no IO and are trivially unit-tested; `loadUsage`
 * and `evaluateSessionPause` are the thin IO wrappers the orchestrator (SKILL.md)
 * actually calls between tickets. Every input is optional and every failure mode
 * degrades to "don't pause" — a consumer without Pro/Max statusline data, without
 * a usage file yet, or who hasn't opted in via config sees EXACTLY today's
 * unchanged behavior (#378 AC.4).
 */
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readJson } from '../lib/jsonfile.mjs';
import { loadConfig } from '../lib/config.mjs';

/** Relative path `statusline.mjs` writes to and this module reads from. */
export const USAGE_RELPATH = join('.forge', 'autopilot', 'usage.json');

/** Suggested/default threshold when a consumer opts in without picking a custom value. */
export const DEFAULT_THRESHOLD_PCT = 90;

/** A usage.json older than this is treated as stale (§ spike: push-only, no liveness signal). */
export const DEFAULT_MAX_AGE_MS = 20 * 60 * 1000;

/**
 * Pure threshold decision (#378 AC.6). Mirrors `mergeAuthPreflight`/`guardTripped`:
 * no IO, no config reads — just the boundary math, so the invariant is mechanically
 * tested. Missing/invalid input NEVER pauses (fail-open — the safe direction for a
 * feature that must never block a run that lacks the data).
 *
 * @param {object} args
 * @param {number} [args.usedPercentage]  `rate_limits.five_hour.used_percentage` from
 *   the usage snapshot; anything other than a finite number means "no data" -> false.
 * @param {number} [args.thresholdPct]    the configured threshold, default 90.
 * @returns {boolean} true at or above the threshold (inclusive — exactly-at-threshold pauses).
 */
export function shouldPause({ usedPercentage, thresholdPct = DEFAULT_THRESHOLD_PCT } = {}) {
  if (typeof usedPercentage !== 'number' || !Number.isFinite(usedPercentage)) return false;
  if (typeof thresholdPct !== 'number' || !Number.isFinite(thresholdPct)) return false;
  return usedPercentage >= thresholdPct;
}

/**
 * Pure freshness check. The statusline write is push-only on the harness's own
 * refresh cadence (§ module docblock) — a reader has no way to know the writer is
 * still running, so a usage.json from an earlier/stale session must not be treated
 * as live data. Missing/unparsable timestamp -> stale.
 */
export function isFresh({ timestamp, now = Date.now(), maxAgeMs = DEFAULT_MAX_AGE_MS } = {}) {
  const t = typeof timestamp === 'string' ? Date.parse(timestamp) : NaN;
  if (Number.isNaN(t)) return false;
  const age = now - t;
  return age >= 0 && age <= maxAgeMs;
}

/**
 * Resolve the configured threshold from forge config. Reads ONLY
 * `autopilot.sessionPauseThresholdPct` — absent or malformed -> `null`, meaning
 * "opt-in not taken"; the pause logic must not activate (#378 AC.4). This is the
 * ONLY gate on the feature — no separate `enabled` flag, so a consumer opts in by
 * setting the one number they actually want (90 is merely the suggested value).
 */
export function configuredThresholdPct(config) {
  const v = config?.autopilot?.sessionPauseThresholdPct;
  return (typeof v === 'number' && Number.isFinite(v) && v > 0 && v <= 100) ? v : null;
}

/** Best-effort read of the usage file. Absence AND corruption both mean "no data" — never throws. */
export async function loadUsage(cwd) {
  try {
    return await readJson(join(cwd, USAGE_RELPATH));
  } catch {
    return null;
  }
}

/**
 * Orchestrator-facing decision (#378 AC.1/AC.3/AC.4): combine the on-disk usage
 * snapshot + forge config into one verdict the SKILL.md loop reads between
 * tickets (never mid-ticket — § Resume protocol stays the re-entry path, this
 * function only decides WHEN to head there). Never throws; a config load failure
 * degrades to "not configured" rather than propagating.
 */
export async function evaluateSessionPause(cwd, { now = Date.now(), maxAgeMs = DEFAULT_MAX_AGE_MS } = {}) {
  const loaded = await loadConfig(cwd).catch(() => ({ config: null }));
  const thresholdPct = configuredThresholdPct(loaded?.config);
  if (thresholdPct === null) {
    return { pause: false, thresholdPct: null, usedPercentage: null, reason: 'not configured — set autopilot.sessionPauseThresholdPct to opt in (#378)' };
  }

  const usage = await loadUsage(cwd);
  if (!isFresh({ timestamp: usage?.timestamp, now, maxAgeMs })) {
    return {
      pause: false,
      thresholdPct,
      usedPercentage: null,
      reason: usage
        ? 'usage.json is stale — no recent statusline write (session may be idle or non-Pro/Max)'
        : 'no usage.json yet — no Pro/Max statusline data observed this session',
    };
  }

  const usedPercentage = typeof usage?.five_hour?.used_percentage === 'number' ? usage.five_hour.used_percentage : null;
  const pause = shouldPause({ usedPercentage, thresholdPct });
  return {
    pause,
    thresholdPct,
    usedPercentage,
    reason: pause
      ? `5h usage at ${usedPercentage}% >= threshold ${thresholdPct}% — pause at the next safe boundary, then re-enter via the Resume protocol`
      : `5h usage at ${usedPercentage ?? 'unknown'}% < threshold ${thresholdPct}%`,
  };
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  const decision = await evaluateSessionPause(process.cwd());
  console.log(`autopilot session-pause: ${decision.pause ? 'PAUSE' : 'continue'}`);
  console.log(decision.reason);
  process.exit(decision.pause ? 3 : 0);
}
