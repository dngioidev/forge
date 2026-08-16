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

/**
 * Cold-start low-water fallback, used ONLY when a run has no `recentDeltas`
 * history yet (its first check) — see `estimateTicketCost` below for the
 * calibrated-from-history path this backs up. This is the empirically
 * measured worst-case single-ticket GraphQL cost (#438, PR #514: 4995 -> 2
 * remaining), not a guess. Deliberately NOT rounded up to 5000 (the account
 * limit): at exactly 5000, nearly every possible `remaining` reading would
 * read as "low," permanently pausing a fresh run before it can ever start —
 * the inverse failure this ticket also guards against.
 */
export const DEFAULT_LOW_WATER = 4993;

/**
 * Re-check cadence: every N iterations, on top of the mandatory run-start
 * check. The bucket can drain within ~1.3 iterations at observed real-world
 * per-ticket cost, so anything less frequent than every iteration is
 * structurally too late to ever fire before the damage. This check is one
 * cheap REST call (`gh api rate_limit`) that does not itself count against
 * any bucket, so checking every iteration costs nothing extra.
 */
export const DEFAULT_CHECK_EVERY_N = 1;

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
 * Derives the low-water threshold for THIS check from THIS run's own recent
 * GraphQL-remaining deltas rather than a flat constant (#517). Real
 * per-ticket cost varies ~5x by ticket kind, so no single number protects a
 * ticket boundary without either idling a usable bucket (too conservative)
 * or starting a ticket it can't finish (too optimistic).
 *
 * Uses the MAX of the valid (finite, positive) deltas, not an average: the
 * question being answered is "does 'continue' guarantee THIS ticket can
 * complete," which demands the conservative reading of recent evidence, not
 * the typical one. A delta is measured between two actual `remaining`
 * readings — whatever consumed the bucket in between, delivery or
 * otherwise — so taking the max means any unattributed background drain
 * observed in a recent window automatically raises the bar for the next
 * check, without needing to know its cause (#517 correction comment).
 *
 * Falls back to `fallback` (the cold-start `DEFAULT_LOW_WATER`) when there
 * is no history yet.
 */
export function estimateTicketCost(recentDeltas, fallback = DEFAULT_LOW_WATER) {
  const valid = Array.isArray(recentDeltas) ? recentDeltas.filter((d) => Number.isFinite(d) && d > 0) : [];
  return valid.length ? Math.max(...valid) : fallback;
}

/**
 * Orchestrator-facing decision (IO wrapper, #407 AC.1): run the live
 * `rate_limit` check (`rateBudget`, itself a REST call that does NOT count
 * against any bucket) and map it through `shouldPauseForBudget`. Never hard-
 * fails the run on a broken check — degrades to "don't pause" so today's
 * reactive per-call retry keeps covering individual 403s.
 *
 * `lowWater` (#517): an explicit numeric value still wins outright — a
 * caller opting into the old explicit-constant behavior keeps it. Otherwise
 * the effective threshold is derived from `recentDeltas` via
 * `estimateTicketCost`, falling back to `DEFAULT_LOW_WATER` when there's no
 * history yet.
 */
export async function evaluateRateBudget(gh, { lowWater, recentDeltas } = {}) {
  const effectiveLowWater = Number.isFinite(lowWater) ? lowWater : estimateTicketCost(recentDeltas, DEFAULT_LOW_WATER);
  const budget = await rateBudget(gh, { lowWater: effectiveLowWater });
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
