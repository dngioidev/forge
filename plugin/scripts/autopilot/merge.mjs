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

/**
 * The five MECHANICAL signals of the merge bar (spec §4 items 1–5). All must be
 * true to merge. Item 0 — the in-session merge authorization — is a one-time
 * run-start preflight (§4 preflight, not a per-merge signal): the orchestrator
 * confirms it up front, so it is not evaluated here.
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

/** Is the PR's CI fully green? Empty rollup counts as NOT green (fail-closed). */
export async function ciGreen(gh, pr) {
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

/**
 * Live merge, gated by the bar. `signals` carries the orchestrator's held
 * verdicts (ship/gates/reviewer/security); CI is checked here. When auto-merge
 * is disabled — either by config (features.autopilotAutoMerge:false) or by the
 * run-start merge-auth preflight resolving `mode: 'pr-only'` (#316, no in-session
 * grant) — park at the PR (awaiting-human) and let the loop continue. `mode` is
 * the effective merge mode from the preflight, recorded in run.json; pr-only
 * carries autoMergeEnabled:false semantics so a run with no live grant never
 * attempts a merge that would stall.
 */
export async function runMerge(ctx, { issue, pr, signals = {}, critical = false, mode = null }, log = console.log) {
  if (!Number.isInteger(issue) || !Number.isInteger(pr)) return { ok: false, error: '--issue and --pr are required' };
  if (mode === 'pr-only' || !autoMergeEnabled(ctx.config)) {
    const why = mode === 'pr-only' ? 'merge-auth preflight resolved pr-only (no in-session grant)' : 'features.autopilotAutoMerge=false';
    log(`autopilot: ${why} — parking #${issue} at PR #${pr} (awaiting-human)`);
    return { ok: true, merged: false, parked: true, outcome: 'awaiting-human' };
  }
  const ci = await ciGreen(ctx.gh, pr);
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
