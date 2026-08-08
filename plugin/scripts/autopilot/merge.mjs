#!/usr/bin/env node
/**
 * autopilot auto-merge — the bar that replaces the human PR review (#127, spec §4).
 * The trust reversal: a ticket merges only when EVERY signal is green. The bar is
 * a pure function so the invariant "nothing merges on red" is mechanically tested;
 * the live squash-merge is a thin gh call gated behind it.
 */
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { run, makeGh, isPlatformOutage, platformOutageNotice } from '../lib/exec.mjs';
import { makeBoardCtx } from '../lib/boardctx.mjs';
import { loadCiWatchState } from '../monitors/ci-watch.mjs';
import { append as journalAppend } from '../lib/journal.mjs';

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
 * #407 AC.2 — is a monitor-observed transition (`{pr, state, at}`, written by
 * `monitors/ci-watch.mjs`) fresh enough to satisfy `ciGreen` WITHOUT firing a
 * redundant GraphQL re-fetch? Pure: no IO, so the boundary is unit-tested
 * directly. Deliberately narrow — same PR, state exactly `'pass'`, and within
 * `maxAgeMs` of `now` — anything else (wrong PR, stale, pending/fail, missing/
 * unparsable timestamp) returns false and the caller falls through to the real
 * re-check. This is what keeps "nothing merges on red" intact (spec §3.1/§5):
 * the shortcut can only ever confirm an ALREADY-fresh green, never skip past a
 * red or stale one.
 */
export function isFreshGreenTransition(state, pr, { now = Date.now(), maxAgeMs = DEFAULT_FRESH_TRANSITION_MAX_AGE_MS } = {}) {
  if (!state || state.pr !== pr || state.state !== 'pass') return false;
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
 */
export async function ciGreen(gh, pr, { freshState = null, now, maxAgeMs } = {}) {
  // #407 review nit: destructuring defaults already fire on an explicit `undefined`
  // (isFreshGreenTransition's own `now = Date.now()`/`maxAgeMs = ...` params handle
  // that), so passing `now`/`maxAgeMs` straight through is equivalent to — and
  // simpler than — conditionally spreading them in.
  if (isFreshGreenTransition(freshState, pr, { now, maxAgeMs })) {
    return { ok: true, green: true, viaFreshTransition: true };
  }
  // headRefName rides along (#408): a red result may need `classifyCiFailure`
  // below, which needs the branch — one field added to an existing call, not
  // an extra round-trip.
  const res = await gh(['pr', 'view', String(pr), '--json', 'statusCheckRollup,headRefName'], { parseJson: true });
  if (!res.ok) return { ok: false, green: false, error: res.stderr || 'pr view failed' };
  const rollup = res.json?.statusCheckRollup ?? [];
  if (rollup.length === 0) return { ok: true, green: false, reason: 'no checks reported yet' };
  const bad = rollup.filter((c) => {
    const state = c.conclusion ?? c.state; // CheckRun uses conclusion; StatusContext uses state
    return state !== 'SUCCESS' && state !== 'NEUTRAL' && state !== 'SKIPPED';
  });
  return { ok: true, green: bad.length === 0, pending: bad.map((c) => c.name ?? c.context), branch: res.json?.headRefName ?? null };
}

/**
 * #408 AC.1/AC.2 — before treating a red/pending CI result as a real gate
 * failure, rule out a GitHub Actions platform outage. Only fires when
 * `ciGreen` already found actual bad checks (`pending.length > 0`) — an
 * empty rollup ("no checks reported yet") is just "too early," not a
 * signature to investigate, so it costs nothing extra in that (common)
 * case. Bounded to one extra `gh` round-trip: `run list` for the branch's
 * latest run, and only when that run is still non-terminal or failed,
 * `run view --log-failed` for the outage text. Never throws on a
 * missing/malformed response — degrades to "not an outage" so a genuine
 * regression is never masked as GitHub's fault.
 */
export async function classifyCiFailure(gh, { branch, stuckQueuedMs } = {}) {
  if (!branch) return { outage: false, reason: null };
  const runs = await gh(['run', 'list', '--branch', branch, '--limit', '1', '--json', 'databaseId,status,createdAt'], { parseJson: true });
  const latest = runs.ok && Array.isArray(runs.json) ? runs.json[0] : null;
  if (!latest) return { outage: false, reason: null };
  if (latest.status && latest.status !== 'completed') {
    const queuedForMs = Date.now() - new Date(latest.createdAt).getTime();
    const outageOpts = stuckQueuedMs != null ? { stuckQueuedMs } : {};
    if (isPlatformOutage({ status: 'QUEUED', queuedForMs }, outageOpts)) {
      return { outage: true, reason: `job stuck ${latest.status} for ${Math.round(queuedForMs / 60000)}m with no progress` };
    }
    return { outage: false, reason: null };
  }
  const log = await gh(['run', 'view', String(latest.databaseId), '--log-failed']);
  if (isPlatformOutage(log)) {
    return { outage: true, reason: 'GitHub Actions returned Service Unavailable resolving action-download-info' };
  }
  return { outage: false, reason: null };
}

/**
 * #408 AC.2 — the empirically-proven recovery: force a fresh commit SHA via a
 * trivial rebase + `--force-with-lease` repush. Re-running the SAME SHA
 * (`gh run rerun --failed`) did not reliably help this session (spec §2.2) —
 * only a new SHA broke the stuck-queue pattern. `execRun` is injected
 * (mirrors exec.mjs's own DI convention for `run`), so no real git/network
 * runs in tests.
 */
export async function forceNewSha(execRun, { base = 'origin/main' } = {}) {
  const [, remote, ref] = /^(\w+)\/(.+)$/.exec(base) ?? [null, 'origin', base];
  const fetch = await execRun('git', ['fetch', remote, ref]);
  if (!fetch.ok) return { ok: false, error: fetch.stderr || 'git fetch failed' };
  const rebase = await execRun('git', ['rebase', base]);
  if (!rebase.ok) return { ok: false, error: rebase.stderr || 'git rebase failed — resolve conflicts before retrying' };
  const push = await execRun('git', ['push', '--force-with-lease']);
  if (!push.ok) return { ok: false, error: push.stderr || 'git push --force-with-lease failed' };
  return { ok: true };
}

/**
 * Live merge, gated by the bar. `signals` carries the orchestrator's held
 * verdicts (ship/gates/reviewer/security); CI is checked here. When auto-merge
 * is disabled — either by config (features.autopilotAutoMerge:false) or by the
 * run-start merge-auth preflight resolving `mode: 'pr-only'` (#316, no in-session
 * grant) — park at the PR (awaiting-human) and let the loop continue. `mode` is
 * the effective merge mode from the preflight, recorded in run.json; pr-only
 * carries autoMergeEnabled:false semantics so a run with no live grant never
 * attempts a merge that would stall.
 *
 * #408 AC.2/AC.3 — before a real (non-empty) bad-checks result routes to the
 * ordinary "blocked on ci" fix-wave/escalation path, it is classified: is
 * this GitHub's Actions infra being down, or an actual failure? An outage
 * gets the empirically-proven recovery (a fresh commit SHA via rebase +
 * repush), bounded by `maxOutageAttempts` (default 2, "a small number" per
 * the ticket) and threaded across separate invocations via `outageAttempt` —
 * the same pattern the orchestrator already uses for `signals` (it holds the
 * count, this stays a thin per-call gate). A successful recovery returns
 * `outcome:'retry'` (a fresh SHA was just pushed — CI must be re-watched, not
 * re-checked instantly) rather than either merging or escalating. Exhausted
 * attempts fall through to a real "blocked on ci" result, but with an honest,
 * distinguishing reason (AC.3) instead of silently treating GitHub's outage
 * as if the change itself were broken. Every outage event is journaled
 * (AC.4) — `gate-fail` with `outage:true` — so the run report and
 * `board digest` can tell a real fix wave from GitHub being down twice.
 * `deps` overrides the IO (`execRun`, `classify`, `journal`) for tests — no
 * real git/gh/network runs unless the outage path actually triggers.
 */
export async function runMerge(ctx, { issue, pr, signals = {}, critical = false, mode = null, outageAttempt = 0, maxOutageAttempts = 2 } = {}, log = console.log, deps = {}) {
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
  const ci = await ciGreen(ctx.gh, pr, { freshState });
  if (!ci.ok) return { ok: false, error: ci.error };
  if (!ci.green && ci.pending?.length) {
    const classify = deps.classifyCiFailure ?? classifyCiFailure;
    const cls = await classify(ctx.gh, { branch: ci.branch });
    if (cls.outage) {
      const journal = deps.journalAppend ?? journalAppend;
      if (outageAttempt >= maxOutageAttempts) {
        const reason = `GitHub Actions platform outage, not your change (${cls.reason}) — recovery exhausted after ${maxOutageAttempts} attempt(s)`;
        log(`autopilot: ${reason}`);
        if (ctx.cwd) await journal(ctx.cwd, 'gate-fail', { gate: 'ci', ticket: `#${issue}`, pr, outage: true, phase: 'exhausted', reason: cls.reason, attempts: outageAttempt });
        return { ok: false, merged: false, blockedOn: ['ci'], outage: true, outageExhausted: true, reason };
      }
      log(platformOutageNotice(cls.reason, outageAttempt + 1, maxOutageAttempts));
      const force = deps.forceNewSha ?? forceNewSha;
      const execRun = deps.execRun ?? run;
      const recovered = await force(execRun);
      if (ctx.cwd) {
        await journal(ctx.cwd, 'gate-fail', {
          gate: 'ci', ticket: `#${issue}`, pr, outage: true,
          phase: recovered.ok ? 'recovered' : 'recovery-failed',
          reason: cls.reason, attempt: outageAttempt + 1,
        });
      }
      if (!recovered.ok) return { ok: false, error: recovered.error };
      return { ok: true, merged: false, retried: true, outage: true, outageAttempt: outageAttempt + 1, outcome: 'retry' };
    }
  }
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
  const a = { issue: null, pr: null, signals: {}, critical: false, outageAttempt: 0 };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--issue') a.issue = Number(argv[++i]);
    else if (argv[i] === '--pr') a.pr = Number(argv[++i]);
    else if (argv[i] === '--critical') a.critical = true;
    // #408 — the orchestrator threads the attempt count across separate
    // invocations (a fresh SHA needs a fresh CI run to watch in between).
    else if (argv[i] === '--outage-attempt') a.outageAttempt = Number(argv[++i]);
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
