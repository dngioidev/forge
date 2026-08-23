#!/usr/bin/env node
/**
 * autopilot run ledger — the top-level state the loop owns (#129, spec §3/§8).
 * One JSON file per repo: what the current run has merged / escalated / skipped
 * / filed, so a fresh session resumes and the end-of-run report is exact.
 * Per-ticket state stays inside forge:deliver — this is only the run.
 */
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readJson, writeJson } from '../lib/jsonfile.mjs';
import { mergeAuthPreflight } from './preflight.mjs';
import { pendingCount as outboxPendingCount } from '../lib/outbox.mjs';
import { runMove } from '../board/move.mjs';

export const RUN_RELPATH = join('.forge', 'autopilot', 'run.json');
// 'ready' (#466 AC-6) is the terminal outcome of a successful `forge:shape` —
// crazy mode promoting a backlog ticket to Ready. Without it a successful
// shape is unrepresentable: applyOutcome throws, so no run.json ever recorded
// one. It joins at the end so existing report ordering (merged/escalated/
// skipped/awaiting-human first) is unchanged.
// 'stalled-before-pr' (#464) is `watchdog.mjs`'s NONCONFORMING_OUTCOME — a
// subagent's terminal report that doesn't parse as the delivery contract
// (missing/free-text outcome). It is NOT a resolved state (§ Return-then-
// resume watchdog: the ticket still needs a resume/re-spawn), but it must be
// RECORDABLE — same reasoning as 'ready' above — so the run report shows the
// stall instead of `applyOutcome` throwing if the loop records it. A later
// resolved outcome for the same issue naturally supersedes it (`applyOutcome`
// is last-write-wins per issue).
export const OUTCOMES = ['merged', 'escalated', 'skipped', 'awaiting-human', 'ready', 'stalled-before-pr'];

// #517: a small rolling cap on `run.rateBudgetReadings` — only recent readings are relevant
// to "what should the next check expect," not a full run history.
export const MAX_BUDGET_READINGS = 6;

export function freshRun(startedAt = null) {
  return {
    version: 1, startedAt, iterations: 0, outcomes: [], filed: [], mergeMode: null, mergeReason: null,
    // #488 AC.4: the board size the run started at (or was first observed at, for a ledger
    // upgraded mid-run). null until `startRun` is given a `boardSize` opt — see § startRun.
    boardSizeAtStart: null,
    // #506 AC.2: the open-ticket count at run start, same persist-once/never-recompute-on-
    // resume contract as `boardSizeAtStart` above (§ startRun). Feeds `convergence`'s
    // open-now-vs-open-at-start report line (§ renderReport).
    startingOpen: null,
    // #506 AC.4: consecutive DIVERGING convergence waves. A diverging wave increments it; any
    // other verdict resets it to 0 — only two in a row trips the guard (§ convergenceGuard).
    divergingStreak: 0,
    // #517: rolling log of `remaining` readings taken at every rate-budget check — feeds
    // `recentBudgetDeltas`/`estimateTicketCost` so the low-water threshold reflects this
    // run's own observed per-ticket cost instead of a flat constant.
    rateBudgetReadings: [],
  };
}

/**
 * Read the on-disk run, tolerating a truncated/corrupt file. `writeJson` is atomic,
 * but a run.json left half-written by an older build (or hand-edited) must not wedge
 * the loop with an unhandled SyntaxError — a corrupt ledger is treated as absent (#164).
 */
async function readRun(cwd) {
  try {
    return await readJson(join(cwd, RUN_RELPATH));
  } catch (err) {
    // readJson maps a MISSING file (ENOENT) to null, but propagates a real I/O
    // error (EACCES/EIO/EBUSY/…) and a JSON.parse SyntaxError (#185). A truncated
    // or hand-corrupted ledger (SyntaxError) is treated as a fresh run; a genuine
    // read failure must surface here, not silently overwrite an in-flight run.json
    // with a fresh one. This re-throw branch is now reachable (it was dead while
    // readJson swallowed every read error as null upstream — the #185 fix).
    if (err instanceof SyntaxError) return null;
    throw err;
  }
}

export async function loadRun(cwd) {
  return (await readRun(cwd)) ?? freshRun();
}

/**
 * Pure state transition: record what happened to one ticket this iteration.
 * Last write for an issue wins (a re-run of the same ticket supersedes), so
 * the ledger is idempotent under resume. Bumps the iteration counter.
 *
 * `stage` (#466 AC-6) names which spawned subagent produced the outcome —
 * `'shape'`/`'triage'`/`'deliver'` — so a shape wave and a delegation
 * regression are both visible in run.json instead of invisible until a human
 * notices their context bar. Optional and defaults to `null`: no existing
 * caller is required to pass it (back-compat).
 */
export function applyOutcome(run, { issue, outcome, ref = null, stage = null }) {
  if (!OUTCOMES.includes(outcome)) throw new Error(`unknown outcome '${outcome}' — valid: ${OUTCOMES.join(', ')}`);
  const outcomes = run.outcomes.filter((o) => o.issue !== issue);
  outcomes.push({ issue, outcome, ref, stage, at: new Date().toISOString() });
  return { ...run, iterations: run.iterations + 1, outcomes };
}

/**
 * Record a ticket the run filed mid-delivery (bug/spike/follow-up).
 *
 * #506 AC.6 security-adjacent hardening: `issue` is validated as a positive integer
 * BEFORE anything else. Trap found live (#506): `recordFiled(cwd, 556)` — a bare
 * number instead of `{issue,kind,from}` — destructures to `issue: undefined`, and the
 * OLD unvalidated code silently wrote `{ issue: undefined, ... }` into `run.filed`.
 * Dedup below (`f.issue === issue`) then matched `undefined === undefined` against
 * that phantom entry, so EVERY later legitimate `applyFiled` call for a real issue
 * silently no-op'd forever — the exact "run.filed reads permanently wrong" failure
 * this ticket exists to catch, just moved one level down. Failing loud here (throw)
 * turns a silent, permanent data-loss bug into an immediate, obvious one at the call
 * site instead.
 */
export function applyFiled(run, { issue, kind, from }) {
  if (!Number.isInteger(issue) || issue <= 0) {
    throw new Error(`applyFiled: issue must be a positive integer, got ${JSON.stringify(issue)}`);
  }
  if (run.filed.some((f) => f.issue === issue)) return run;
  return { ...run, filed: [...run.filed, { issue, kind, from }] };
}

/**
 * Pure state transition (#517): append a fresh `remaining` reading to
 * `run.rateBudgetReadings`, capped to the last `MAX_BUDGET_READINGS` entries
 * (drops the OLDEST once over cap). A non-finite or negative reading is
 * ignored — returns `run` unchanged rather than corrupting the log (same
 * trust-boundary posture as `sanitizePositiveInt` above).
 */
export function applyBudgetReading(run, remaining) {
  if (!Number.isFinite(remaining) || remaining < 0) return run;
  const readings = [...(run.rateBudgetReadings ?? []), remaining].slice(-MAX_BUDGET_READINGS);
  return { ...run, rateBudgetReadings: readings };
}

/**
 * Pure derivation (#517): consecutive-reading drops only. For each pair of
 * consecutive readings, `readings[i-1] - readings[i]` is pushed into the
 * result ONLY when it's `> 0` — a reading that went UP means the hourly
 * window reset, not "a ticket was cheap," and must never be counted as a
 * zero/negative cost. Returns the positive drops in chronological order.
 */
export function recentBudgetDeltas(run) {
  const readings = run?.rateBudgetReadings ?? [];
  const deltas = [];
  for (let i = 1; i < readings.length; i++) {
    const delta = readings[i - 1] - readings[i];
    if (delta > 0) deltas.push(delta);
  }
  return deltas;
}

// #488: PR #468's no-fused-routes rule made every `select.mjs` action its own spawn with
// its own recorded outcome, so a ticket that needs triage now costs 2 iterations
// (triage→record, deliver→record) and an unshaped ticket under `--shape` costs up to 3
// (shape→record, then triage/deliver→record). The old default of 2 was calibrated for the
// pre-#468 economics (~1 iteration/ticket) and, post-#468, sits AT the real cost rather than
// above it — a perfect full clear lands exactly on the cap (the bug this ticket fixes).
// DEFAULT_RUNAWAY_FACTOR is raised strictly above the worst known per-ticket cost (3) so a
// healthy clear — even an all-unshaped `--shape` board — never lands exactly on the cap,
// while a run resolving fewer than one ticket per 4 iterations is unambiguously not
// converging at any known-healthy pace.
export const DEFAULT_RUNAWAY_FACTOR = 4;

// #488 AC.5: healthy pace resolves roughly one ticket every PER_TICKET_COST_CEILING
// iterations (the worst known per-ticket cost, #468). HEALTHY_RATIO_FLOOR is half that
// rate — a generous floor below which iterations are being spent without closing tickets,
// which is what #317's backstop exists to catch (diagnostic only; does not affect the trip).
const PER_TICKET_COST_CEILING = 3;
const HEALTHY_RATIO_FLOOR = 1 / (PER_TICKET_COST_CEILING * 2);

/**
 * #488 security fix-wave: `run.json` is disk state, in principle writable by a prior
 * compromised process, a crashed half-write, or a hand-edit — the same threat model the
 * rest of this file already treats `run.iterations`/outcomes as subject to (see
 * `readRun`'s corrupt-file handling above). A disk-sourced numeric field must never be
 * trusted verbatim: `Math.max(1, x)` does NOT neutralize `NaN` (comparisons against NaN
 * are always false) or `Infinity` (valid, parseable JSON — e.g. `1e999` — and `x >= Infinity`
 * is false for any finite x), either of which would make the cap `Infinity`/`NaN` and
 * PERMANENTLY DISABLE the runaway backstop — the exact unbounded-autopilot-with-auto-merge
 * failure mode this guard exists to prevent. Returns `fallback` (default `null`) for
 * anything that isn't a finite positive number, never a garbage value.
 */
export function sanitizePositiveInt(value, fallback = null) {
  // #488 2nd security pass: check the FLOORED value against > 0, not the raw value — a
  // corrupted input in the open interval (0, 1) (e.g. `boardSizeAtStart: 0.5`) is finite
  // and > 0, but floors to 0, which is not "a finite positive number" per this function's
  // own contract. Flooring first (then re-checking) closes that gap instead of silently
  // returning 0 as if it were a validated anchor.
  if (!Number.isFinite(value)) return fallback;
  const floored = Math.floor(value);
  return floored > 0 ? floored : fallback;
}

/**
 * #488 AC.4 + security fix-wave: the cap must not shrink as the board shrinks — it anchors
 * to the board size recorded at run start (`run.boardSizeAtStart`, set once by `startRun`)
 * rather than the live count a caller passes each iteration. Falls back to the live
 * `boardSize` argument when the run predates #488 (an older ledger with no
 * `boardSizeAtStart` field), was never given one, or — critically — the stored anchor is
 * corrupted (non-finite/non-positive): reading around a bad on-disk value this way means a
 * corrupted anchor can never silently disable the guard, even though (per AC.4) it is never
 * rewritten on disk once set. Always returns a finite positive integer; falls all the way
 * back to `1` (the smallest possible, most conservative anchor) if BOTH the stored anchor
 * and the live argument are garbage or absent.
 */
function resolveAnchorBoardSize(run, boardSize) {
  return sanitizePositiveInt(run?.boardSizeAtStart) ?? sanitizePositiveInt(boardSize, 1);
}

/**
 * #488 security fix-wave: `run.iterations` is the same disk-sourced trust boundary as the
 * anchor above. A corrupted value (non-finite, negative, wrong type) must FAIL CLOSED — read
 * as "trip the guard now" (`Infinity`), not "never trip" — because the latter is the harm
 * this backstop exists to prevent; a false-positive halt+escalate on genuinely corrupt state
 * is the safe direction to err in, an unbounded auto-merge-authorized loop is not.
 */
export function sanitizeIterations(run) {
  return Number.isFinite(run?.iterations) && run.iterations >= 0 ? run.iterations : Number.POSITIVE_INFINITY;
}

/**
 * #488 AC.5: at trip time, distinguish "no progress is being made" from "this run has
 * simply been long" using state `run.outcomes` already carries — no new tracking. Counts
 * distinct issues with a recorded outcome (already deduplicated per-issue, last-write-wins,
 * by `applyOutcome`); `stalled-before-pr` is excluded because it is a stall awaiting
 * resume/respawn, not resolved progress (see the OUTCOMES comment above) — a run stuck
 * respawning the same ticket must not read as "long but healthy".
 */
function progressRatio(run) {
  const resolvedIssues = new Set(
    (run.outcomes ?? []).filter((o) => o.outcome !== 'stalled-before-pr').map((o) => o.issue),
  ).size;
  const iterations = sanitizeIterations(run);
  return { resolvedIssues, ratio: iterations > 0 ? resolvedIssues / iterations : 0 };
}

/**
 * Loop backstop (spec §8): a pathological file-a-ticket-per-iteration run must
 * not loop forever. Once iterations exceed the anchored board size × factor, stop and
 * escalate. `boardSize` is the live count the caller passes; `resolveAnchorBoardSize`
 * prefers `run.boardSizeAtStart` when present (#488 AC.4) and both it and
 * `sanitizeIterations` fail closed against corrupted disk state (#488 security fix-wave).
 */
/** Shared cap computation — the single place `guardTripped`/`nextIteration` derive the
 * anchored, sanitized cap from, so the two never risk computing it differently (#488
 * reviewer note). */
function capFor(run, boardSize, factor) {
  return resolveAnchorBoardSize(run, boardSize) * factor;
}

export function guardTripped(run, boardSize, factor = DEFAULT_RUNAWAY_FACTOR) {
  return sanitizeIterations(run) >= capFor(run, boardSize, factor);
}

/**
 * Per-iteration runaway backstop — the real caller for `guardTripped` (#317, spec §8).
 * The orchestrator loop MUST call this at the TOP of every iteration, BEFORE selecting
 * or delivering the next ticket, and honour a `stop` decision (halt the loop + escalate)
 * — that is what turns the backstop from prose into a mechanical contract. Pure, no IO:
 * it reads `run.iterations` (bumped + persisted to run.json by `applyOutcome`, so the
 * bound is resume-safe and auditable) and delegates the trip test to `guardTripped`.
 * When it trips, the loop is runaway and must HALT + ESCALATE rather than loop forever;
 * otherwise the loop continues. It never mutates the run — the iteration counter it reads
 * is owned by `applyOutcome`, so the natural stop (board clear) and `--limit` are intact.
 *
 * #488: the cap anchors to `run.boardSizeAtStart` when set (AC.4) and the `reason` text
 * distinguishes a no-progress runaway from a merely-long healthy run (AC.5) via
 * `progressRatio` — diagnostic only, it never changes whether the guard trips.
 */
export function nextIteration(run, boardSize, factor = DEFAULT_RUNAWAY_FACTOR) {
  const cap = capFor(run, boardSize, factor);
  const stop = sanitizeIterations(run) >= cap;
  const anchor = resolveAnchorBoardSize(run, boardSize); // for the reason text only — same value capFor used
  const { resolvedIssues, ratio } = progressRatio(run);
  const healthyButLong = ratio >= HEALTHY_RATIO_FLOOR;
  return {
    stop,
    escalate: stop, // the only reason this guard stops is the runaway backstop → escalate
    iterations: run.iterations, // raw, for human/report visibility — even if corrupted, never silently reshaped
    cap,
    reason: stop
      ? `runaway backstop tripped: ${run.iterations} iteration(s) reached the cap of ${cap} ` +
        `(board size ${anchor} × ${factor}, anchored at run start) — ` +
        (healthyButLong
          ? `${resolvedIssues} issue(s) resolved in that span — this run has simply been long, not stalled — `
          : `only ${resolvedIssues} issue(s) resolved in that span — no progress is being made — `) +
        `halting the loop and escalating`
      : null,
  };
}

/**
 * #506 AC.1: pure per-wave convergence verdict — no IO, no board access (AC.5). A
 * "wave" is one convergence check (the caller decides cadence, mirroring the
 * rate-budget check). `closed` counts THIS RUN's own `merged` outcomes (the only
 * outcome that actually closes a GitHub issue — `escalated`/`skipped`/`awaiting-
 * human`/`ready`/`stalled-before-pr` never do) and `filed` is `run.filed.length` —
 * both scoped to what this run itself did, immune to unrelated board churn (a human
 * closing something, another run filing something) that `startingOpen`/`currentOpen`
 * alone can't distinguish. `netDelta = closed - filed`: positive is healthy (this run
 * is shrinking the backlog it touches), negative is the #506 problem (`verdict:
 * 'diverging'`) — a run that files more than it closes reading as a good run. Zero is
 * `'flat'`. `startingOpen`/`currentOpen` are threaded straight through on the returned
 * object (not folded into the verdict) purely so `renderReport` can show "open-now vs
 * open-at-start" (AC.3) from the same call, without a second board read.
 */
export function convergence(run, { startingOpen, currentOpen }) {
  const closed = (run.outcomes ?? []).filter((o) => o.outcome === 'merged').length;
  const filed = (run.filed ?? []).length;
  const netDelta = closed - filed;
  const verdict = netDelta > 0 ? 'converging' : netDelta < 0 ? 'diverging' : 'flat';
  return { closed, filed, netDelta, verdict, startingOpen, currentOpen };
}

/** #506 AC.4: disk-sourced streak — fails closed to 0 (not "trust it"), mirroring this
 * file's other disk-state sanitizers (`sanitizePositiveInt`/`sanitizeIterations`) —
 * never lets a corrupted/non-integer streak silently jam above or below the trip line. */
function sanitizeDivergingStreak(value) {
  return Number.isInteger(value) && value >= 0 ? value : 0;
}

/**
 * #506 AC.4: two CONSECUTIVE diverging waves — not one — stop the loop and escalate.
 * Pure (AC.5): folds this wave's `convergence()` verdict into `run.divergingStreak`
 * (a diverging wave increments it; `converging`/`flat` resets it to 0) and returns a
 * `{stop, escalate, reason}` decision shaped exactly like `nextIteration`'s, so the
 * orchestrator treats every loop backstop the same way. One diverging wave alone
 * never trips it (`divergingStreak` reaches 1, `stop` stays false) — a single wave
 * that files a batch of follow-ups from one messy ticket is normal and healthy; only
 * a SECOND consecutive diverging wave (`divergingStreak` reaches 2) trips. Never
 * mutates `run` — the caller persists the returned `divergingStreak` (see
 * `recordConvergence`), same split as `applyBudgetReading`/`recordBudgetReading`.
 * Escalation itself routes through the existing `board/escalate.mjs` path (naming the
 * filed tickets in `reason`) — this function only decides, it never calls it.
 */
export function convergenceGuard(run, { startingOpen, currentOpen }) {
  const wave = convergence(run, { startingOpen, currentOpen });
  const priorStreak = sanitizeDivergingStreak(run?.divergingStreak);
  const divergingStreak = wave.verdict === 'diverging' ? priorStreak + 1 : 0;
  const stop = divergingStreak >= 2;
  const filedList = (run.filed ?? []).map((f) => `#${f.issue}`).join(', ') || 'none';
  return {
    ...wave,
    divergingStreak,
    stop,
    escalate: stop,
    reason: stop
      ? `convergence backstop tripped: 2 consecutive diverging waves — this wave closed ${wave.closed}, ` +
        `filed ${wave.filed} (net ${wave.netDelta}) — filed this run: ${filedList} — halting the loop and escalating`
      : null,
  };
}

/**
 * `outboxPending` (#414, spike §4) is an optional, purely additive line: how
 * many deferred board writes (`.forge/autopilot/outbox.json`) are still
 * queued at report time. Read-only — never changes the outcome tallies above,
 * never manufactures a `blocked` ticket. Defaults to 0 so an omitted arg is
 * silent (no behavior change for a caller that hasn't wired the outbox read).
 */
/**
 * #506 AC.3: `currentOpen` is optional (mirrors `outboxPending`'s additive-only
 * shape) — a caller with no live board count in hand (e.g. the bare CLI `report`
 * subcommand below) still gets the pre-#506 report unchanged. The convergence line
 * only appears once BOTH `run.startingOpen` (persisted once by `startRun`, § AC.2)
 * and a live `currentOpen` are available.
 */
export function renderReport(run, { outboxPending = 0, currentOpen = null } = {}) {
  const by = (o) => run.outcomes.filter((x) => x.outcome === o);
  const line = (o) => {
    const items = by(o);
    return items.length ? `  ${o}: ${items.map((x) => `#${x.issue}${x.ref ? ` (${x.ref})` : ''}`).join(', ')}` : null;
  };
  const parts = [
    `autopilot run — ${run.iterations} iteration(s)`,
    ...OUTCOMES.map(line).filter(Boolean),
    run.filed.length ? `  filed: ${run.filed.map((f) => `#${f.issue} (${f.kind})`).join(', ')}` : null,
  ].filter(Boolean);
  if (parts.length === 1) parts.push('  (nothing actionable — board was already clear)');
  if (run.startingOpen != null && currentOpen != null) {
    const wave = convergence(run, { startingOpen: run.startingOpen, currentOpen });
    const sign = wave.netDelta > 0 ? '+' : '';
    parts.push(
      `  convergence: closed ${wave.closed}, filed ${wave.filed}, net ${sign}${wave.netDelta} (${wave.verdict}) ` +
      `— open now ${currentOpen} vs ${run.startingOpen} at start`,
    );
  }
  if (outboxPending > 0) parts.push(`  outbox: ${outboxPending} item(s) still queued (GitHub unreachable for part of this run)`);
  return parts.join('\n');
}

// IO wrappers the loop calls.
/**
 * #556: a triage `outcome:"ready"` verdict never landed on the board. `forge:triage`
 * deliberately places tickets at `--status backlog` by design (triage/SKILL.md — an
 * intentional, protected contract, AC-2 forbids changing it), and — before this fix —
 * nothing else ever promoted the status once triage returned `pass`/`ready`. `select.mjs`
 * routes purely on LIVE board status, so the very next `selectNext` pass re-picked the SAME
 * ticket as `triage` again: one full triage subagent burned per iteration, forever
 * (reproduced live for #490 and #550 — both needed a manual `move.mjs --status ready`
 * before `select.mjs` would return `deliver`).
 *
 * `recordOutcome` is already the one choke point every triage report passes through on its
 * way to `run.json` — this is where the promotion is wired in, so it can't be forgotten at a
 * call site, and WITHOUT requiring the triage subagent itself to change its placement
 * contract (the orchestrator's record step performs it from the outside, per AC-2's explicit
 * either/or).
 *
 * Narrowly scoped (AC-4): only a triage `outcome:"ready"` verdict promotes anything.
 * `outcome:"skipped"` still rests on the `dependencies/` record at `backlog` (#487) and
 * `outcome:"escalated"` still parks at `blocked` via `escalate.mjs` — neither's entry shape
 * matches `stage==='triage' && outcome==='ready'`, so neither ever reaches `runMove` below.
 * A `shape` `outcome:"ready"` entry (`stage:'shape'`) also never reaches it: shape's own
 * subagent already performs its OWN board promotion as part of "promotes it Backlog→Ready"
 * (shape/SKILL.md) — re-promoting here would be redundant, so the stage check excludes it
 * on purpose rather than relying on `runMove`'s no-op being merely harmless.
 *
 * Idempotent (AC-3): `runMove` itself already no-ops (`changed:false`, no mutation, no
 * error) when the ticket is already at the target status, so recording the same `ready`
 * outcome twice — e.g. a resumed session re-processing a report it already handled — never
 * errors and never re-fires a redundant board mutation beyond that safe idempotent re-check.
 *
 * `ctx` (a `makeBoardCtx` board context, the same shape every `board/*.mjs` script already
 * takes) is optional and defaults to `null`: omitting it degrades to the pre-fix behavior
 * (record to `run.json` only, no board call), so every existing 2-arg `recordOutcome` call
 * site — deliver's `merged`/`escalated`/`awaiting-human`, shape's own `ready`/`escalated` —
 * is completely unaffected. A real orchestrator run passes `ctx` so the promotion actually
 * happens; a `runMove` failure is fail-loud (throws) rather than silently leaving the ticket
 * unpromoted (§ Auto-triage front door — autopilot never silently drops a resolved verdict).
 */
export async function recordOutcome(cwd, entry, { ctx = null, log = console.log } = {}) {
  const run = applyOutcome(await loadRun(cwd), entry);
  await writeJson(join(cwd, RUN_RELPATH), run);
  if (ctx && entry.stage === 'triage' && entry.outcome === 'ready') {
    // #556 security pass (forge:security round 1): `entry.issue` is a triage subagent's
    // self-reported field, now one hop from a live board mutation (`runMove` below) — validate
    // it as a positive integer here rather than trusting it verbatim, mirroring
    // `lib/dependencies.mjs`'s `fileFor` guard for the same class of untrusted-issue-number
    // input (#487 security fix-wave). Closes the type-confusion shape of the finding;
    // `runMove`/`findItemByIssue` already fail closed on a well-typed but off-board issue
    // number, so together neither a malformed nor a not-on-this-board issue number ever
    // reaches the mutation.
    if (!Number.isInteger(entry.issue) || entry.issue <= 0) {
      throw new Error(`recordOutcome: triage ready promotion needs a positive integer issue, got ${JSON.stringify(entry.issue)}`);
    }
    const moved = await runMove(ctx, { issue: entry.issue, status: 'ready' }, log);
    if (!moved.ok) throw new Error(`recordOutcome: triage ready → board promotion failed for #${entry.issue} — ${moved.error}`);
  }
  return run;
}
export async function recordFiled(cwd, entry) {
  const run = applyFiled(await loadRun(cwd), entry);
  await writeJson(join(cwd, RUN_RELPATH), run);
  return run;
}
/**
 * #506 AC.4 IO wrapper: computes this wave's `convergenceGuard` decision AND persists
 * the resulting `divergingStreak` — same pure/IO split as `applyBudgetReading`/
 * `recordBudgetReading`, so the streak survives a resume (mirrors `boardSizeAtStart`).
 */
export async function recordConvergence(cwd, { startingOpen, currentOpen }) {
  const run = await loadRun(cwd);
  const decision = convergenceGuard(run, { startingOpen, currentOpen });
  await writeJson(join(cwd, RUN_RELPATH), { ...run, divergingStreak: decision.divergingStreak });
  return decision;
}
export async function recordBudgetReading(cwd, remaining) {
  const run = applyBudgetReading(await loadRun(cwd), remaining);
  await writeJson(join(cwd, RUN_RELPATH), run);
  return run;
}
/**
 * Begin (or resume) the run and record the merge-authorization decision (#316).
 * When `opts` carries an `authorized` flag, the run-start merge-auth preflight is
 * evaluated and its effective mode + reason are persisted into run.json so the
 * decision is auditable and the merge path can gate on it. The in-session grant is
 * NOT file-backed — a resumed/restarted session is a new session and must re-obtain
 * a live grant — so on resume we keep the original start time but REFRESH the mode
 * from the freshly re-run preflight (absent an `authorized` opt, resume is untouched).
 *
 * #488 AC.4: when `opts` carries a `boardSize`, it is persisted as `boardSizeAtStart`
 * — but ONLY ONCE. A fresh run sets it; a resume BACKFILLS it if absent (an existing
 * ledger written before this fix) but NEVER recomputes an anchor that's already set —
 * the whole point is that the cap must not shrink as the live board shrinks. Omitting
 * `boardSize` (an un-upgraded call site) leaves the anchor unset, same as before this
 * ticket — `nextIteration`/`guardTripped` fall back to the live boardSize argument.
 *
 * #488 security fix-wave: `opts.boardSize` is sanitized (`sanitizePositiveInt`) before
 * it's ever written to disk — a non-finite/non-positive value (e.g. a buggy upstream
 * board-count computation) is never persisted as a corrupted anchor in the first place.
 * `nextIteration`/`guardTripped` additionally sanitize on every READ, so even a
 * `boardSizeAtStart` that predates this write-time guard (or was hand-edited) can never
 * silently disable the backstop — see `resolveAnchorBoardSize`/`sanitizeIterations`.
 */
export async function startRun(cwd, opts = {}) {
  const hasAuth = Object.prototype.hasOwnProperty.call(opts, 'authorized');
  const sanitizedBoardSize = sanitizePositiveInt(opts.boardSize); // null if absent or garbage — never persisted either way
  // #506 AC.2: `startingOpen` follows `boardSizeAtStart`'s exact precedent — sanitized the
  // same way, persisted once, backfilled on a pre-#506 resume, never recomputed thereafter.
  const sanitizedStartingOpen = sanitizePositiveInt(opts.startingOpen);
  const preflight = hasAuth ? mergeAuthPreflight(opts) : null;
  const decision = preflight ? { mergeMode: preflight.mode, mergeReason: preflight.reason } : {};
  const existing = await readRun(cwd);
  if (existing?.startedAt) {
    const needsAnchor = existing.boardSizeAtStart == null && sanitizedBoardSize != null;
    const needsOpenAnchor = existing.startingOpen == null && sanitizedStartingOpen != null;
    const anchor = {
      ...(needsAnchor ? { boardSizeAtStart: sanitizedBoardSize } : {}),
      ...(needsOpenAnchor ? { startingOpen: sanitizedStartingOpen } : {}),
    };
    if (!preflight && !needsAnchor && !needsOpenAnchor) return existing; // pure resume — no new decision, nothing to backfill
    const run = { ...existing, ...decision, ...anchor }; // resume — re-run preflight and/or backfill the anchor(s)
    await writeJson(join(cwd, RUN_RELPATH), run);
    return run;
  }
  const anchor = {
    ...(sanitizedBoardSize != null ? { boardSizeAtStart: sanitizedBoardSize } : {}),
    ...(sanitizedStartingOpen != null ? { startingOpen: sanitizedStartingOpen } : {}),
  };
  const run = { ...freshRun(new Date().toISOString()), ...decision, ...anchor };
  await writeJson(join(cwd, RUN_RELPATH), run);
  return run;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  const sub = process.argv[2];
  if (sub === 'report') {
    // A genuine read failure on an existing run.json (EACCES/EBUSY/AV-lock) now
    // propagates (#185) — catch it so it exits cleanly instead of surfacing as a
    // raw unhandled-rejection trace (#204).
    Promise.all([loadRun(process.cwd()), outboxPendingCount(process.cwd()).catch(() => 0)])
      .then(([run, outboxPending]) => console.log(renderReport(run, { outboxPending })))
      .catch((err) => { console.error(`ledger report failed: ${err.message}`); process.exit(1); });
  } else {
    console.error('usage: ledger.mjs report');
    process.exit(1);
  }
}
