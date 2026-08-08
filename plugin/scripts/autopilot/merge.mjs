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
 * #411: `headRefOid` is the caller's cheaply-confirmed current head commit for
 * this PR (see `runMerge` — a local `git rev-parse HEAD`, zero GraphQL cost,
 * so the call-reduction intent above is unaffected). `isFreshGreenTransition`
 * fails closed without it, so a caller that can't cheaply confirm a candidate
 * head (e.g. a `ctx` with no `cwd`) always falls through to the real re-fetch
 * below rather than trusting a possibly-stale cached reading. IMPORTANT: this
 * local read is a CHEAP PRE-FILTER, not the authoritative check — it can only
 * ever confirm "this process's own checkout hasn't moved," not "GitHub's PR
 * head hasn't moved" (an out-of-band push from another actor/bot would leave
 * both the local checkout AND the cached reading stale together, so this
 * comparison alone can't catch it). The AUTHORITATIVE bind is downstream, at
 * the live `gh pr merge --match-head-commit` call in `runMerge` — this
 * function also returns the `headRefOid` it green-lit (from `freshState.sha`
 * via the shortcut, or freshly fetched below) precisely so that call can pin
 * to it and have GitHub itself reject a merge if the real remote head has
 * since moved, atomically, with no TOCTOU between this check and the merge.
 */
export async function ciGreen(gh, pr, { freshState = null, now, maxAgeMs, headRefOid } = {}) {
  // #407 review nit: destructuring defaults already fire on an explicit `undefined`
  // (isFreshGreenTransition's own `now = Date.now()`/`maxAgeMs = ...` params handle
  // that), so passing `now`/`maxAgeMs` straight through is equivalent to — and
  // simpler than — conditionally spreading them in.
  if (isFreshGreenTransition(freshState, pr, { now, maxAgeMs, headRefOid })) {
    return { ok: true, green: true, viaFreshTransition: true, headRefOid: freshState.sha };
  }
  // headRefName rides along (#408): a red result may need `classifyCiFailure`
  // below, which needs the branch — one field added to an existing call, not
  // an extra round-trip. headRefOid (#411) is the commit this rollup reading
  // belongs to — returned below so `runMerge` can pin the live merge to it.
  const res = await gh(['pr', 'view', String(pr), '--json', 'statusCheckRollup,headRefName,headRefOid'], { parseJson: true });
  if (!res.ok) return { ok: false, green: false, error: res.stderr || 'pr view failed' };
  const rollup = res.json?.statusCheckRollup ?? [];
  if (rollup.length === 0) return { ok: true, green: false, reason: 'no checks reported yet' };
  const bad = rollup.filter((c) => {
    const state = c.conclusion ?? c.state; // CheckRun uses conclusion; StatusContext uses state
    return state !== 'SUCCESS' && state !== 'NEUTRAL' && state !== 'SKIPPED';
  });
  // #408 — a bad CheckRun carries the workflow that produced it; a repo can run
  // several workflows on the same branch/push, so `classifyCiFailure` needs
  // this to scope its `gh run list` to the actual failing workflow instead of
  // "whichever workflow happened to run last."
  //
  // Security fix (3rd review pass, #408): the bad-check SET can span more
  // than one workflow (or include a StatusContext, which carries no
  // workflowName at all — e.g. an external check like a deploy preview).
  // Picking just the FIRST bad check's workflow and classifying only that one
  // run would let a fast-failing decoy workflow (genuinely outaged) get the
  // whole CI-red waved through as "just an outage" while a REAL failure in a
  // completely different workflow was never even looked at. So `classifiable`
  // is true ONLY when every bad check is a CheckRun attributable to the SAME
  // single workflow — any ambiguity (multiple workflows, or any check we
  // can't attribute to one at all) means `runMerge` skips outage
  // classification entirely and treats the result as a real failure,
  // fail-closed. `workflowName` is only meaningful when `classifiable` is true.
  // `|| null` (not `??`) deliberately normalizes an empty-string workflowName
  // to null too — `classifyCiFailure`'s own `--workflow` guard is a plain
  // truthiness check, so an empty string there would silently skip scoping;
  // treating it as unresolved here (never classifiable) keeps the two in
  // lockstep (4th review pass, #408).
  const workflowNames = new Set(bad.map((c) => c.workflowName || null));
  const classifiable = workflowNames.size === 1 && !workflowNames.has(null);
  const workflowName = classifiable ? [...workflowNames][0] : null;
  // headRefOid (#411): the commit this rollup reading belongs to, returned so
  // `runMerge` can pin the live `gh pr merge` to it via `--match-head-commit`.
  return { ok: true, green: bad.length === 0, pending: bad.map((c) => c.name ?? c.context), branch: res.json?.headRefName ?? null, workflowName, classifiable, headRefOid: res.json?.headRefOid ?? null };
}

/**
 * #408 AC.1/AC.2 — before treating a red/pending CI result as a real gate
 * failure, rule out a GitHub Actions platform outage. Only fires when
 * `ciGreen` already found actual bad checks (`pending.length > 0`) — an
 * empty rollup ("no checks reported yet") is just "too early," not a
 * signature to investigate, so it costs nothing extra in that (common)
 * case. Never throws on a missing/malformed response — degrades to "not an
 * outage" so a genuine regression is never masked as GitHub's fault.
 *
 * Security note (found in review, #408): a job's failed-step LOG TEXT is not
 * a trustworthy signal on its own — it is whatever the repo's own workflow
 * steps printed, which an attacker (a malicious PR, or any genuinely failing
 * test/lint whose assertion message happens to echo the right words) can
 * shape. Trusting text alone would let a crafted failure message spoof the
 * outage signature and get a REAL regression (including a security-relevant
 * one) waved off as "GitHub is down," plus trigger the automatic force-push
 * recovery on attacker-influenced input. So the textual match is only
 * evidence of LAST resort, gated behind a structural corroboration GitHub's
 * own job orchestration assigns — not something a workflow step's stdout can
 * forge: whether the failing job ever got past its injected "Set up job"
 * step to run any of the repo's own defined steps. The action-download-info
 * resolution failure this ticket targets happens DURING that setup phase,
 * before user code runs — so "failed during setup" is the honest structural
 * fingerprint of an infra outage, and "a user-defined step ran and failed"
 * is definitionally a real failure regardless of what its log text says.
 */
export async function classifyCiFailure(gh, { branch, workflowName, stuckQueuedMs } = {}) {
  if (!branch) return { outage: false, reason: null };
  // #408 review fix — scope to the workflow that actually produced the bad
  // check when known; an unscoped `run list` returns the branch's single
  // latest run across EVERY workflow, which can be a different (unrelated,
  // possibly green) workflow than the one `ciGreen` found bad checks on.
  // `ciGreen` only ever passes a `workflowName` here when EVERY bad check
  // shares that one workflow (`ci.classifiable` — 3rd review pass), closing
  // the "decoy workflow masks a real failure in a different workflow" gap.
  //
  // Accepted residual risk (review, #408): `workflowName` is the workflow's
  // *display name* (editable via the workflow file's own `name:` key), not
  // an ID cross-checked back to the specific CheckRun. A same-branch decoy
  // workflow with a colliding display name could still misdirect this
  // lookup. Exploiting it requires push/workflow-modify access to the repo —
  // a materially higher privilege bar than the PR-content-only spoofing this
  // ticket's structural fixes close — and a wrong-run lookup still degrades
  // safely: it either finds no matching run (outage:false) or a
  // genuinely-outaged run that still has to pass `failedDuringSetup` below,
  // never a raw name match alone.
  const listArgs = ['run', 'list', '--branch', branch, '--limit', '1', '--json', 'databaseId,status,createdAt'];
  if (workflowName) listArgs.push('--workflow', workflowName);
  const runs = await gh(listArgs, { parseJson: true });
  const latest = runs.ok && Array.isArray(runs.json) ? runs.json[0] : null;
  if (!latest) return { outage: false, reason: null };
  if (latest.status && latest.status !== 'completed') {
    const queuedForMs = Date.now() - new Date(latest.createdAt).getTime();
    const outageOpts = stuckQueuedMs != null ? { stuckQueuedMs } : {};
    // #408 review fix — pass the run's ACTUAL status through instead of
    // hardcoding 'QUEUED': isPlatformOutage only trips its stuck-queued
    // trigger for a genuinely QUEUED run, so a merely slow but healthy
    // `in_progress`/`waiting` run past stuckQueuedMs is correctly left alone.
    if (isPlatformOutage({ status: latest.status, queuedForMs }, outageOpts)) {
      return { outage: true, reason: `job stuck ${latest.status} for ${Math.round(queuedForMs / 60000)}m with no progress` };
    }
    return { outage: false, reason: null };
  }
  if (!failedDuringSetup(await gh(['run', 'view', String(latest.databaseId), '--json', 'jobs'], { parseJson: true }))) {
    return { outage: false, reason: null }; // a real job/step ran and failed — never masked by log text alone
  }
  const log = await gh(['run', 'view', String(latest.databaseId), '--log-failed']);
  if (isPlatformOutage(log)) {
    return { outage: true, reason: 'GitHub Actions returned Service Unavailable resolving action-download-info' };
  }
  return { outage: false, reason: null };
}

/**
 * Structural corroboration for `classifyCiFailure` above: did EVERY failing
 * job in the run never get past GitHub's own injected "Set up job" step?
 * `gh run view --json jobs` returns each job's `steps` array with
 * GitHub-assigned conclusions (`success`/`failure`/`skipped`/`cancelled`/
 * null) — every job has "Set up job" as `steps[0]` and "Complete job" as the
 * last entry, injected by the Actions service itself, not by the workflow
 * file or any step's own output. A job's failure counts as "during setup"
 * when `steps[0]` didn't succeed, or every step between the bookends is
 * unset/skipped/cancelled (none of the repo's own steps ever ran) — matching
 * where an action-download-info resolution failure actually occurs.
 *
 * Security fix (2nd review pass, #408): this must require ALL failing jobs
 * to pass that test, not just one. `classifyCiFailure`'s subsequent
 * `--log-failed` fetch is RUN-WIDE (every failing job's log, concatenated),
 * not scoped to a single job — so checking only the first failing job left a
 * bypass: a workflow with a genuine decoy job that fails during setup (e.g.
 * a bad `uses:` ref) would corroborate the check while a SECOND, real job's
 * genuine failure (whose own message could echo the outage phrases,
 * deliberately or by coincidence) rides along in the same aggregated log
 * text and still gets classified as "outage." Requiring every failing job to
 * be a setup-phase failure closes that: the moment ANY failing job ran a
 * real step, the whole run is correctly treated as a real failure and the
 * log text is never even fetched — a single real failure can no longer hide
 * behind a co-occurring one that's structurally legitimate. Degrades to
 * `false` (not an outage) on any malformed/empty response or when no job
 * actually failed.
 */
export function failedDuringSetup(jobsRes) {
  const jobs = jobsRes?.ok && Array.isArray(jobsRes.json?.jobs) ? jobsRes.json.jobs : [];
  const failing = jobs.filter((j) => j.conclusion && j.conclusion !== 'success' && j.conclusion !== 'skipped');
  if (failing.length === 0) return false;
  return failing.every((job) => {
    const steps = Array.isArray(job.steps) ? job.steps : [];
    if (steps.length === 0) return true; // no step breakdown at all — this job never even got that far
    const setup = steps[0];
    if (setup?.conclusion && setup.conclusion !== 'success') return true;
    const middle = steps.slice(1, -1);
    return middle.every((s) => !s.conclusion || s.conclusion === 'skipped' || s.conclusion === 'cancelled');
  });
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
 * attempts a merge that would stall.
 *
 * #408 AC.2/AC.3 - before a real (non-empty) bad-checks result routes to the
 * ordinary "blocked on ci" fix-wave/escalation path, it is classified: is
 * this GitHubs Actions infra being down, or an actual failure? An outage
 * gets the empirically-proven recovery (a fresh commit SHA via rebase +
 * repush), bounded by `maxOutageAttempts` (default 2, "a small number" per
 * the ticket) and threaded across separate invocations via `outageAttempt` -
 * the same pattern the orchestrator already uses for `signals` (it holds the
 * count, this stays a thin per-call gate). A successful recovery returns
 * `outcome:retry` (a fresh SHA was just pushed - CI must be re-watched, not
 * re-checked instantly) rather than either merging or escalating. Exhausted
 * attempts fall through to a real "blocked on ci" result, but with an honest,
 * distinguishing reason (AC.3) instead of silently treating GitHubs outage
 * as if the change itself were broken. Every outage event is journaled
 * (AC.4) - `gate-fail` with `outage:true` - so the run report and
 * `board digest` can tell a real fix wave from GitHub being down twice.
 * `deps` overrides the IO (`execRun`, `classify`, `journal`, and - #411 -
 * `execFn`, the local head-sha checks process runner) for tests - no real
 * git/gh/network runs unless the relevant path actually triggers.
 */
// #408 review fix (LOW) - the MCP tool schema types outageAttempt/maxOutageAttempts
// as `integer` but the shared RPC validator (`plugin/mcp/lib/rpc.mjs` validateInput)
// has no min/max enforcement, so a schema `maximum` alone would be documentation
// only. Clamp for real, here, the one place both the CLI and every host (MCP,
// direct script) funnel through - a caller can shrink the bound but never grow it
// past a sane ceiling, so "a small number of attempts" holds regardless of input.
const MAX_OUTAGE_ATTEMPTS_CEILING = 10;

export async function runMerge(ctx, { issue, pr, signals = {}, critical = false, mode = null, outageAttempt = 0, maxOutageAttempts = 2 } = {}, log = console.log, deps = {}) {
  // #411: the local head-sha checks process runner - swappable via deps like
  // every other injected IO in this function (execRun, classifyCiFailure, journal).
  const execFn = deps.execFn ?? run;
  if (!Number.isInteger(issue) || !Number.isInteger(pr)) return { ok: false, error: '--issue and --pr are required' };
  outageAttempt = Number.isInteger(outageAttempt) && outageAttempt >= 0 ? outageAttempt : 0;
  maxOutageAttempts = Number.isInteger(maxOutageAttempts) ? Math.min(Math.max(maxOutageAttempts, 0), MAX_OUTAGE_ATTEMPTS_CEILING) : 2;
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
  // #408 — `ci.classifiable` (fail-closed): only attempt outage classification
  // when every bad check is attributable to the SAME single workflow. A bad
  // set spanning multiple workflows (or any check with no resolvable
  // workflow) skips classification entirely — never risk waving through a
  // real failure in one workflow behind another's genuine outage.
  //
  // Security fix (4th review pass, #408): `!critical` gates this whole branch.
  // A critical finding (security/review) must force an escalation "regardless
  // of the other signals" (see `evaluateMergeBar`'s own doc comment below) —
  // that invariant would be silently violated if an autonomous force-push
  // recovery attempt could still fire and `return` before `evaluateMergeBar`
  // ever runs. `critical` is an orchestrator-held verdict, not attacker
  // input, but the fix is cheap and the invariant is exactly what this
  // ticket's own merge bar promises, so outage recovery never preempts it.
  if (!ci.green && ci.pending?.length && ci.classifiable && !critical) {
    const classify = deps.classifyCiFailure ?? classifyCiFailure;
    const cls = await classify(ctx.gh, { branch: ci.branch, workflowName: ci.workflowName });
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
      // #408 review fix — a failed recovery attempt (rebase conflict, rejected
      // push) still carries the outage context forward: without `outage`/
      // `reason` here, a caller (incl. the MCP tool's error path) sees only a
      // raw git error string and loses "this was outage-recovery attempt N,"
      // making the run report/trail dishonestly silent about why it happened.
      if (!recovered.ok) {
        return {
          ok: false, error: recovered.error, outage: true, outageAttempt: outageAttempt + 1,
          reason: `platform-outage recovery attempt ${outageAttempt + 1}/${maxOutageAttempts} failed: ${recovered.error}`,
        };
      }
      return { ok: true, merged: false, retried: true, outage: true, outageAttempt: outageAttempt + 1, outcome: 'retry' };
    }
  }
  const bar = evaluateMergeBar({ ...signals, ci: ci.green }, { critical });
  if (!bar.merge) {
    log(`autopilot: merge bar RED for #${issue} — blocked on ${bar.blockedOn.join(', ')}${bar.escalate ? ' (escalate)' : ''}`);
    return { ok: false, merged: false, blockedOn: bar.blockedOn, escalate: bar.escalate };
  }
  // #411: pin the LIVE merge to the exact commit `ciGreen` just confirmed green
  // — `--match-head-commit` is validated server-side by GitHub at the moment
  // of merge, atomically. This is the AUTHORITATIVE bind (see the `ciGreen`
  // doc comment): it closes the gap the local `headRefOid` pre-filter above
  // can't — an out-of-band push that moved the PR's real remote head between
  // the check and this call (or one this checkout was never even aware of)
  // makes `gh pr merge` fail instead of squashing an uncorroborated commit.
  // `ci.headRefOid` can be null in a degenerate case (a `gh` double/response
  // that omits it) — degrade to the pre-#411 unpinned call rather than
  // blocking a legitimately green merge on a missing hardening signal.
  const mergeArgs = ['pr', 'merge', String(pr), '--squash', '--delete-branch'];
  if (ci.headRefOid) mergeArgs.push('--match-head-commit', ci.headRefOid);
  const merged = await ctx.gh(mergeArgs);
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
