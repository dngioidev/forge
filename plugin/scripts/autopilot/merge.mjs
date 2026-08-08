#!/usr/bin/env node
/**
 * autopilot auto-merge — the bar that replaces the human PR review (#127, spec §4).
 * The trust reversal: a ticket merges only when EVERY signal is green. The bar is
 * a pure function so the invariant "nothing merges on red" is mechanically tested;
 * the live squash-merge is a thin gh call gated behind it.
 */
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { run, makeGh } from '../lib/exec.mjs';
import { makeBoardCtx } from '../lib/boardctx.mjs';
import { loadCiWatchState } from '../monitors/ci-watch.mjs';

/**
 * The five MECHANICAL signals of the merge bar (spec §4 items 1–5). All must be
 * true to merge. Item 0 — the in-session merge authorization — is confirmed by
 * the orchestrator at the run-start preflight (§4 preflight) and is not
 * evaluated here. That preflight grant is NOT a one-time, session-wide
 * guarantee: the harness auto-mode classifier evaluates authorization per
 * merge attempt, so a later attempt in the same, uncompacted session can still
 * be denied even after an earlier merge succeeded (observed directly,
 * repeatedly, in production runs; #397). There is no code-level way to detect
 * this in advance today (tracked separately, #398) — when it happens, the
 * orchestrator's only recourse is to stop, surface the denial to the user, and
 * ask for a fresh explicit grant before retrying.
 */
export const BAR_SIGNALS = ['ship', 'gates', 'reviewer', 'security', 'ci'];

/** Owner opt-out: default ON. `features.autopilotAutoMerge: false` parks at the PR. */
export function autoMergeEnabled(config) {
  return config?.features?.autopilotAutoMerge !== false;
}

/**
 * Evaluate the bar. `signals` maps each of BAR_SIGNALS to a boolean; a missing
 * signal counts as NOT green (fail-closed). `critical` (a critical security or
 * review finding) forces an escalation regardless. Returns whether to merge,
 * what it's blocked on, and whether the block is an escalation vs a fix-wave.
 */
export function evaluateMergeBar(signals = {}, { critical = false } = {}) {
  const blockedOn = BAR_SIGNALS.filter((s) => signals[s] !== true);
  if (critical) blockedOn.unshift('security:critical');
  const merge = blockedOn.length === 0;
  return { merge, blockedOn, escalate: critical };
}

/** Default freshness window for a monitor-observed transition (#407 AC.2) — one
 * `forge-ci` monitor poll interval's worth of slack (its default is 20s;
 * `FORGE_CI_INTERVAL_MS` overrides it, but this stays a fixed, conservative
 * default rather than reading that env var, so a caller with a slower monitor
 * doesn't silently widen the window). */
export const DEFAULT_FRESH_TRANSITION_MAX_AGE_MS = 20000;

/**
 * #407 AC.2 — is a monitor-observed transition (`{pr, state, sha, at}`, written
 * by `monitors/ci-watch.mjs`) fresh enough to satisfy `ciGreen` WITHOUT firing a
 * redundant GraphQL re-fetch? Pure: no IO, so the boundary is unit-tested
 * directly. Deliberately narrow — same PR, state exactly `'pass'`, within
 * `maxAgeMs` of `now`, AND (#411) bound to the caller's confirmed current head
 * commit (`headRefOid`) — anything else (wrong PR, stale, pending/fail,
 * missing/unparsable timestamp, missing/mismatched sha) returns false and the
 * caller falls through to the real re-check. The sha bind closes a gap #407
 * shipped: without it, a push landing on the PR inside the freshness window
 * (after the monitor's last "pass" poll, before its next one) could leave a
 * stale green reading for the OLD commit that this check would otherwise
 * accept for the NEW one. This is what keeps "nothing merges on red" intact
 * (spec §3.1/§5): the shortcut can only ever confirm an ALREADY-fresh green
 * for the CURRENT commit, never skip past a red, stale, or superseded one.
 */
export function isFreshGreenTransition(state, pr, { now = Date.now(), maxAgeMs = DEFAULT_FRESH_TRANSITION_MAX_AGE_MS, headRefOid } = {}) {
  if (!state || state.pr !== pr || state.state !== 'pass') return false;
  // #411: fail closed unless both sides of the sha bind are present and equal —
  // an omitted/unresolvable headRefOid must never silently skip the check.
  if (!headRefOid || !state.sha || state.sha !== headRefOid) return false;
  const at = Date.parse(state.at ?? '');
  if (Number.isNaN(at)) return false;
  const age = now - at;
  return age >= 0 && age <= maxAgeMs;
}

/**
 * Is the PR's CI fully green? Empty rollup counts as NOT green (fail-closed).
 *
 * #407 AC.2: when `freshState` (the `forge-ci` monitor's last observed
 * transition, read from disk by the caller — see `runMerge`) is a very recent
 * known-green reading for THIS pr, that satisfies the check without a new
 * GraphQL call — one of the 3 independent CI-status pollers becomes free for
 * that ticket lifecycle instead of firing its own redundant `pr view`. Any
 * other case (no freshState, wrong pr, stale, or non-pass) is unchanged: the
 * real re-fetch always runs, so the mandatory pre-merge green confirmation is
 * never skipped, only its network cost is — the safety property spec §5 calls
 * out is untouched.
 *
 * #411: `headRefOid` is the caller's live-confirmed current head commit for
 * this PR (see `runMerge` — a local `git rev-parse HEAD`, zero GraphQL cost,
 * so the call-reduction intent above is unaffected). `isFreshGreenTransition`
 * fails closed without it, so a caller that can't cheaply confirm the current
 * head (e.g. a `ctx` with no `cwd`) always falls through to the real re-fetch
 * below rather than trusting a possibly-stale cached reading.
 */
export async function ciGreen(gh, pr, { freshState = null, now, maxAgeMs, headRefOid } = {}) {
  // #407 review nit: destructuring defaults already fire on an explicit `undefined`
  // (isFreshGreenTransition's own `now = Date.now()`/`maxAgeMs = ...` params handle
  // that), so passing `now`/`maxAgeMs` straight through is equivalent to — and
  // simpler than — conditionally spreading them in.
  if (isFreshGreenTransition(freshState, pr, { now, maxAgeMs, headRefOid })) {
    return { ok: true, green: true, viaFreshTransition: true };
  }
  const res = await gh(['pr', 'view', String(pr), '--json', 'statusCheckRollup'], { parseJson: true });
  if (!res.ok) return { ok: false, green: false, error: res.stderr || 'pr view failed' };
  const rollup = res.json?.statusCheckRollup ?? [];
  if (rollup.length === 0) return { ok: true, green: false, reason: 'no checks reported yet' };
  const bad = rollup.filter((c) => {
    const state = c.conclusion ?? c.state; // CheckRun uses conclusion; StatusContext uses state
    return state !== 'SUCCESS' && state !== 'NEUTRAL' && state !== 'SKIPPED';
  });
  return { ok: true, green: bad.length === 0, pending: bad.map((c) => c.name ?? c.context) };
}

/** #411: the shortcut's own binding check — a cheap LOCAL `git rev-parse HEAD`
 * (no GraphQL call, so AC.2's call-reduction intent is unaffected). Returns
 * null on any failure (detached weirdness, not a repo, etc.) so the caller
 * fails closed to the real re-fetch rather than binding to a wrong/empty sha. */
async function currentHeadSha(cwd, execFn) {
  const res = await execFn('git', ['-C', cwd, 'rev-parse', 'HEAD']);
  const sha = res.ok ? res.stdout.trim() : '';
  return sha || null;
}

/**
 * Live merge, gated by the bar. `signals` carries the orchestrator's held
 * verdicts (ship/gates/reviewer/security); CI is checked here. When auto-merge
 * is disabled — either by config (features.autopilotAutoMerge:false) or by the
 * run-start merge-auth preflight resolving `mode: 'pr-only'` (#316, no in-session
 * grant) — park at the PR (awaiting-human) and let the loop continue. `mode` is
 * the effective merge mode from the preflight, recorded in run.json; pr-only
 * carries autoMergeEnabled:false semantics so a run with no live grant never
 * attempts a merge that would stall. `execFn` (default `run`) is the injected
 * process runner for the #411 local head-sha check — swappable in tests.
 */
export async function runMerge(ctx, { issue, pr, signals = {}, critical = false, mode = null }, log = console.log, execFn = run) {
  if (!Number.isInteger(issue) || !Number.isInteger(pr)) return { ok: false, error: '--issue and --pr are required' };
  if (mode === 'pr-only' || !autoMergeEnabled(ctx.config)) {
    const why = mode === 'pr-only' ? 'merge-auth preflight resolved pr-only (no in-session grant)' : 'features.autopilotAutoMerge=false';
    log(`autopilot: ${why} — parking #${issue} at PR #${pr} (awaiting-human)`);
    return { ok: true, merged: false, parked: true, outcome: 'awaiting-human' };
  }
  // #407 AC.2: a `ctx` resolved via `makeBoardCtx` carries `cwd` — read the
  // forge-ci monitor's last observed state (if any) so a very recent known-
  // green transition skips the redundant GraphQL re-fetch. A ctx without
  // `cwd` (e.g. a test double) or a missing/stale/wrong-pr file both degrade
  // to today's unconditional re-fetch — never a behavior change on their own.
  // loadCiWatchState already never throws (internal try/catch in ci-watch.mjs) —
  // no .catch() needed here (#407 review nit).
  const freshState = ctx.cwd ? await loadCiWatchState(ctx.cwd) : null;
  // #411: only bother resolving the local head sha when there's an actual
  // freshState candidate to bind it to — no point paying even a local spawn
  // for the (common, once CI is slow) case where there's nothing on disk yet.
  const headRefOid = freshState && ctx.cwd ? await currentHeadSha(ctx.cwd, execFn) : null;
  const ci = await ciGreen(ctx.gh, pr, { freshState, headRefOid });
  if (!ci.ok) return { ok: false, error: ci.error };
  const bar = evaluateMergeBar({ ...signals, ci: ci.green }, { critical });
  if (!bar.merge) {
    log(`autopilot: merge bar RED for #${issue} — blocked on ${bar.blockedOn.join(', ')}${bar.escalate ? ' (escalate)' : ''}`);
    return { ok: false, merged: false, blockedOn: bar.blockedOn, escalate: bar.escalate };
  }
  const merged = await ctx.gh(['pr', 'merge', String(pr), '--squash', '--delete-branch']);
  if (!merged.ok) return { ok: false, error: merged.stderr || 'gh pr merge failed' };
  log(`autopilot: merged #${issue} via PR #${pr} (squash)`);
  return { ok: true, merged: true, outcome: 'merged' };
}

function parseArgs(argv) {
  const a = { issue: null, pr: null, signals: {}, critical: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--issue') a.issue = Number(argv[++i]);
    else if (argv[i] === '--pr') a.pr = Number(argv[++i]);
    else if (argv[i] === '--critical') a.critical = true;
    else if (argv[i].startsWith('--') && BAR_SIGNALS.includes(argv[i].slice(2))) a.signals[argv[i].slice(2)] = true;
  }
  return a;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  const gh = makeGh(run);
  makeBoardCtx({ gh, cwd: process.cwd() }).then(async (ctx) => {
    if (!ctx.ok) { console.error(ctx.error); process.exit(1); }
    // signals default false: the orchestrator passes --ship --gates --reviewer --security once it holds those verdicts.
    const res = await runMerge(ctx, parseArgs(process.argv.slice(2)));
    if (!res.ok && res.error) { console.error(`merge failed: ${res.error}`); process.exit(1); }
    if (!res.merged && !res.parked) process.exit(2); // bar red — not an error, but not merged
  });
}
