#!/usr/bin/env node
/**
 * autopilot GraphQL rate-budget preflight (#407, epic #183) — the demand-
 * reduction half of #360 that was shipped as dead code. #360 AC.4 delivered
 * `rateBudget()` (`lib/exec.mjs`) fully implemented and exported, but
 * `grep -rn "rateBudget("` found exactly one hit — its own definition. The loop
 * only ever reacted to a 403 *after* it happened (`makeGh`'s per-call backoff);
 * nothing checked the shared, account-wide 5,000 pt/hr GraphQL bucket
 * proactively before spawning another delivery. This module wires it in at the
 * two points the orchestrator (SKILL.md) actually calls: the run-start
 * preflight (alongside `preflight.mjs` `mergeAuthPreflight`) and a periodic
 * recheck every N iterations (alongside `ledger.mjs` `nextIteration`).
 *
 * Mirrors `sessionpause.mjs`'s split (itself mirroring `preflight.mjs`/
 * `ledger.mjs`): `shouldPauseForBudget` is the pure boundary decision — no IO,
 * so it's driven with a mocked `rateBudget` result, no real API and no real
 * sleep (#407 AC.4). `evaluateRateBudget` is the thin IO wrapper the
 * orchestrator actually calls between spawns.
 *
 * Degrade, don't hard-block (spec §3.1, docs/specs/2026-08-08-github-resilience.md):
 * a FAILED check (`budget.ok === false` — network down, gh broken, anything
 * short of a completed low/not-low reading) is NOT "low". It degrades to
 * today's reactive per-call retry (`makeGh`'s own backoff already covers an
 * individual 403) instead of pausing the whole run on a check that itself
 * couldn't complete.
 */
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { run, makeGh, rateBudget } from '../lib/exec.mjs';

/** Default GraphQL remaining-points floor that trips a pause (mirrors `rateBudget`'s own default). */
export const DEFAULT_LOW_WATER = 200;

/** Re-check cadence: every N iterations, on top of the mandatory run-start check. */
export const DEFAULT_CHECK_EVERY_N = 10;

/**
 * Pure boundary decision (mirrors `shouldPause`/`guardTripped`): no IO. Only a
 * COMPLETED check (`ok:true`) reporting `low:true` pauses — a failed check
 * never does (fail-open on the check itself; fail-safe on a confirmed low
 * reading — see module docblock).
 */
export function shouldPauseForBudget(budget) {
  return !!budget && budget.ok === true && budget.low === true;
}

/**
 * Is THIS iteration due for a periodic recheck? Iteration 0 is the mandatory
 * run-start check — the orchestrator calls `evaluateRateBudget` there
 * unconditionally, so this only governs the periodic-recheck cadence
 * afterward (never double-fires on the run-start iteration itself).
 */
export function budgetCheckDue(iterations, everyN = DEFAULT_CHECK_EVERY_N) {
  const n = Number.isInteger(everyN) && everyN > 0 ? everyN : DEFAULT_CHECK_EVERY_N;
  return Number.isInteger(iterations) && iterations > 0 && iterations % n === 0;
}

/** The actionable pause line, mirroring `rateLimitNotice`'s shape (#360 AC.2). */
export function budgetPauseNotice(budget) {
  return `forge: GraphQL budget low (remaining ${budget.remaining}/${budget.limit}, resets in ~${budget.resetInSec}s) — pausing the autopilot run until the window resets instead of burning the shared bucket to zero.`;
}

/**
 * Orchestrator-facing decision (IO wrapper, #407 AC.1): run the live
 * `rate_limit` check (`rateBudget`, itself a REST call that does NOT count
 * against any bucket) and map it through `shouldPauseForBudget`. Never hard-
 * fails the run on a broken check — degrades to "don't pause" so today's
 * reactive per-call retry keeps covering individual 403s.
 */
export async function evaluateRateBudget(gh, { lowWater = DEFAULT_LOW_WATER } = {}) {
  const budget = await rateBudget(gh, { lowWater });
  if (!budget.ok) {
    return {
      pause: false,
      ok: false,
      budget,
      reason: `rate-budget check failed (${budget.error}) — degrading to reactive per-call retry, not pausing the run`,
    };
  }
  const pause = shouldPauseForBudget(budget);
  return {
    pause,
    ok: true,
    budget,
    reason: pause ? budgetPauseNotice(budget) : `GraphQL budget OK (remaining ${budget.remaining}/${budget.limit})`,
  };
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  const gh = makeGh(run);
  evaluateRateBudget(gh).then((decision) => {
    console.log(`autopilot rate-budget preflight: ${decision.pause ? 'PAUSE' : 'continue'}`);
    console.log(decision.reason);
    process.exit(decision.pause ? 3 : 0);
  });
}
