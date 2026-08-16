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
 * Security fix-wave (#517): the minimum delta treated as real evidence of what a ticket costs,
 * rather than idle-window noise or a corrupted/hand-edited `run.json`. `run.rateBudgetReadings`
 * is disk state — the same trust boundary `ledger.mjs`'s `sanitizePositiveInt`/`sanitizeIterations`
 * already fail-closed against (#488) — and a history of near-flat consecutive readings (e.g.
 * `[5000,4999,4998,4997,4996,4995]`, deltas of 1) is indistinguishable in shape from a genuine
 * check-to-check gap where nothing was actually delivered. Without a floor, `estimateTicketCost`
 * would happily derive a ~1-point low-water threshold from either case, which silently disables
 * the pause guard (`low = remaining <= lowWater` never true until the bucket is essentially
 * already gone) — the exact failure #407/#517 exist to prevent. Set below the lowest ever-measured
 * REAL per-ticket cost (~975, #517 correction comment) with margin, so a genuinely cheap ticket's
 * delta still counts as evidence (AC-517.3b) while noise/corruption cannot.
 */
export const MIN_PLAUSIBLE_DELTA = 500;

/**
 * Per-kind measured GraphQL cost (#526, option 3 of the #526 fix-wave). #438
 * (~4993pt, an ordinary feature ticket) queued right before #462 (~975pt,
 * a docs+regression-test ticket) dragged #462's low-water up to #438's delta
 * under the old MAX-of-recentDeltas rule (AC-526.1's "#526 pathology") — a
 * known-cheap ticket kind was held hostage by a past expensive ticket's cost,
 * even though its OWN cost was already known and small. Values are the
 * actually-measured GraphQL spend for each kind, not estimates: `docs: 975`
 * is #462's measured docs+regression-test cost; `spike: 3457` is #448's
 * measured spike+docs-PR cost (#448 as it stood when #526 was measured — its
 * title/content has since changed; see the AC-530 evidence below for why this
 * makes per-title historical citations fragile and the board `type` field a
 * more stable classification key going forward). Only these two kinds carry
 * evidence — every
 * other WORK_TYPES prefix still falls through to the recentDeltas-based
 * estimate below unchanged (see `ticketKind` in `select.mjs`).
 *
 * #530 — still keyed by the TITLE-prefix vocabulary (`docs`/`spike`), not the
 * board `type` field, and deliberately so. `select.mjs`'s `normalize()` now
 * sources `t.kind` from the board `type` field FIRST (primary signal, ~100%
 * coverage, AC.1) and only falls back to `ticketKind(title)` — the sole
 * remaining consumer of this table — when `type` is unavailable. This table
 * was NOT re-keyed to the board's `type` vocabulary (AC.4) because there is no
 * safe mapping yet: the live board (`gh project field-list`) has exactly 4
 * `type` options — `epic`/`item`/`bug`/`test` — with no `docs`/`spike` value
 * at all (`newwork.mjs`'s `KIND_TO_TYPE` independently documents the same
 * fact: "No 'spike' type — a spike is tracked as an item"). Worse, the one
 * clean same-type data point available PROVES type is not a safe cost proxy
 * on this board: issue #462 (~975pt, the `docs` figure above) and issue #438
 * (~4993pt, `DEFAULT_LOW_WATER`'s source) are BOTH board type `item` — a
 * single type value spans a >5x measured range. Assigning any board `type`
 * value an optimistic cost from this table would therefore be exactly the
 * failure AC.2/AC.4 forbid (an unrecognized-or-unproven type must degrade
 * conservatively, not optimistically) — so no `type`-keyed entries exist
 * here. A future ticket can add real `type`-keyed entries once per-type
 * evidence (not per-title-prefix evidence) actually exists; until then every
 * real ticket's board-`type`-derived `kind` (`item`/`bug`/`test`/`epic`) is,
 * correctly, not a `KIND_COST_ESTIMATES` key, so it falls through to the
 * unchanged path 2 (recentDeltas MAX / `DEFAULT_LOW_WATER`) below.
 *
 * Trust boundary (#526 security pass, narrowed by #530): `kind` reaching this
 * table is now ONLY ever title-derived in the type-missing fallback case (see
 * `ticketKind`'s docblock in `select.mjs`) — a materially smaller attack
 * surface than #526 shipped, since the board `type` field (Projects-v2
 * board-write access, not free-text issue-title access) is the primary path
 * for every ticket that has one. A mistitled ticket in the fallback case can
 * still steer this lookup; that residual risk is bounded the same way #526
 * accepted it: the live `remaining` reading is never attacker-supplied, only
 * the *threshold* is influenced, and `UNATTRIBUTED_DRAIN_FLOOR` below still
 * floors how low a known-kind result can go.
 */
export const KIND_COST_ESTIMATES = { docs: 975, spike: 3457 };

/**
 * Floor under ANY per-kind estimate above (#526): #526 itself observed
 * ~1,400pt of unattributed background drain between checks with no delivery
 * actually running — bot polling, workflow status checks, board reads, etc.
 * A per-kind number below this floor would understate the real bucket cost
 * of just letting time pass, independent of what the next ticket costs to
 * deliver. Rounded up from the ~1,400pt observed figure with margin, mirroring
 * `MIN_PLAUSIBLE_DELTA`'s role on the recentDeltas side: a known-cheap kind
 * must not be dragged UP by a past expensive ticket's delta (the #526
 * pathology), but it must still never be dragged BELOW what idle drain alone
 * is known to cost.
 */
export const UNATTRIBUTED_DRAIN_FLOOR = 1500;

/**
 * Derives the low-water threshold for THIS check. Two paths (#526):
 *
 * #530: `kind`'s SOURCE changed (board `type` field first, `ticketKind(title)`
 * only as fallback — `select.mjs` `normalize()`) but this function's own logic
 * is byte-identical to #526/#517. `KIND_COST_ESTIMATES` still has no entries
 * for the board `type` vocabulary (see its docblock for the evidence why), so
 * in practice every real ticket today — `kind` of `item`/`bug`/`test`/`epic`
 * — takes path 2 below, same as an unrecognized kind always did.
 *
 * 1. Known kind (`kind` is a `KIND_COST_ESTIMATES` key, e.g. 'docs'/'spike'):
 *    short-circuits straight to `Math.max(KIND_COST_ESTIMATES[kind],
 *    UNATTRIBUTED_DRAIN_FLOOR)`, ignoring `recentDeltas`/`fallback` entirely.
 *    This is the option-5 fix: a known-cheap kind's own measured cost is
 *    strictly better evidence than a past, possibly-unrelated ticket's delta
 *    — letting `recentDeltas` override it is exactly the #526 pathology — but
 *    the result still respects `UNATTRIBUTED_DRAIN_FLOOR` because idle drain
 *    happens regardless of kind.
 *
 * 2. Unknown kind (`kind` is `null`/omitted/unrecognized — anything not a
 *    `KIND_COST_ESTIMATES` key): byte-identical to the pre-#526 (#517) logic
 *    below. Real per-ticket cost varies ~5x by ticket kind, so with no known
 *    per-kind number the MAX of the valid (finite, plausible — see
 *    `MIN_PLAUSIBLE_DELTA`) recent deltas is used, not an average: the
 *    question being answered is "does 'continue' guarantee THIS ticket can
 *    complete," which demands the conservative reading of recent evidence,
 *    not the typical one. A delta is measured between two actual `remaining`
 *    readings — whatever consumed the bucket in between, delivery or
 *    otherwise — so taking the max means any unattributed background drain
 *    observed in a recent window automatically raises the bar for the next
 *    check, without needing to know its cause (#517 correction comment).
 *    `Array.prototype.reduce`, not a spread into `Math.max`, so an oversized
 *    `recentDeltas` (a corrupted/hand-edited history) cannot blow the call
 *    stack (#517 security fix-wave) — this function must never throw. Falls
 *    back to `fallback` (the cold-start `DEFAULT_LOW_WATER`) when there is no
 *    history yet, OR when every supplied delta is below `MIN_PLAUSIBLE_DELTA`
 *    — i.e. "no plausible evidence" degrades exactly like "no evidence,"
 *    never toward zero.
 *
 * `kind` itself is untrusted the same way `recentDeltas` is (#526 AC-526.4):
 * a non-string/malformed value simply isn't a `KIND_COST_ESTIMATES` key, so
 * it falls through to path 2 rather than throwing.
 */
export function estimateTicketCost(recentDeltas, kind, fallback = DEFAULT_LOW_WATER) {
  if (Object.prototype.hasOwnProperty.call(KIND_COST_ESTIMATES, kind)) {
    return Math.max(KIND_COST_ESTIMATES[kind], UNATTRIBUTED_DRAIN_FLOOR);
  }
  const valid = Array.isArray(recentDeltas)
    ? recentDeltas.filter((d) => Number.isFinite(d) && d >= MIN_PLAUSIBLE_DELTA)
    : [];
  return valid.length ? valid.reduce((max, d) => Math.max(max, d), -Infinity) : fallback;
}

/**
 * Orchestrator-facing decision (IO wrapper, #407 AC.1): run the live
 * `rate_limit` check (`rateBudget`, itself a REST call that does NOT count
 * against any bucket) and map it through `shouldPauseForBudget`. Never hard-
 * fails the run on a broken check — degrades to "don't pause" so today's
 * reactive per-call retry keeps covering individual 403s.
 *
 * `lowWater` (#517): an explicit numeric value still wins outright — a
 * caller opting into the old explicit-constant behavior keeps it, overriding
 * both `recentDeltas` and `kind`. Otherwise the effective threshold is
 * derived via `estimateTicketCost(recentDeltas, kind, DEFAULT_LOW_WATER)`:
 * a known `kind` (#526 — the next selected ticket's `docs`/`spike`
 * classification from `select.mjs`'s `ticketKind`) short-circuits to its own
 * measured per-kind cost, otherwise falling back to the `recentDeltas` MAX,
 * and finally to `DEFAULT_LOW_WATER` when there's no history yet.
 */
export async function evaluateRateBudget(gh, { lowWater, recentDeltas, kind } = {}) {
  const effectiveLowWater = Number.isFinite(lowWater) ? lowWater : estimateTicketCost(recentDeltas, kind, DEFAULT_LOW_WATER);
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
