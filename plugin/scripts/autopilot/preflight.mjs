#!/usr/bin/env node
/**
 * autopilot merge-authorization preflight (#316, epic #183).
 *
 * The merge-auth requirement used to live only as prose in SKILL.md. An
 * unattended/scheduled run has no live user turn to grant it, so a run would
 * deliver a whole ticket and then SILENTLY wedge at the first merge (the
 * observed failure). The engine can't detect the harness auto-mode classifier
 * from code — so this is NOT a classifier probe. It is a run-start decision that
 * requires an EXPLICIT authorization to be recorded up front; absent it, the run
 * degrades to PR-only (awaiting-human) instead of proceeding into deliveries
 * that will stall at merge.
 *
 * Pure by design: `mergeAuthPreflight` maps (authorized, config) → the effective
 * merge mode + a human-readable reason the orchestrator surfaces. The ledger
 * records the chosen mode at startRun (auditable, resume-safe); `runMerge` gates
 * on it (pr-only parks at the PR, exactly like features.autopilotAutoMerge:false).
 */
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { autoMergeEnabled } from './merge.mjs';

export const MERGE_MODES = ['auto-merge', 'pr-only'];

/**
 * Resolve the effective merge mode for this run.
 *
 * @param {object} args
 * @param {boolean} args.authorized  an EXPLICIT in-session user grant to auto-merge
 *   is held. Anything file-backed (a value in run.json), config (features.
 *   autopilotAutoMerge), the gh allowlist, or agent narration is NOT authorization
 *   and the caller must pass `false` for those — only a live user grant is `true`.
 * @param {object} [args.config]     forge config (features.autopilotAutoMerge opt-out).
 * @returns {{ mode: 'auto-merge'|'pr-only', reason: string, authorized: boolean }}
 *   `auto-merge` ONLY when the grant is present AND config doesn't disable it;
 *   otherwise `pr-only` with the exact notice to surface.
 */
export function mergeAuthPreflight({ authorized = false, config = {} } = {}) {
  const authorizedBool = authorized === true;
  const enabled = autoMergeEnabled(config);

  if (!enabled) {
    return {
      mode: 'pr-only',
      authorized: authorizedBool,
      reason:
        'features.autopilotAutoMerge=false — running PR-only: each ticket stops at its open green PR (awaiting-human). Merge policy is opt-out by config.',
    };
  }
  if (!authorizedBool) {
    return {
      mode: 'pr-only',
      authorized: false,
      reason:
        'No in-session merge authorization — running PR-only (awaiting-human) instead of stalling at the first merge. ' +
        'features.autopilotAutoMerge:true and the gh-pr-merge allowlist are necessary but NOT sufficient; they do not clear the ' +
        'harness auto-mode classifier. To auto-merge, obtain a live user grant (answer the run-start "Merge policy" prompt) and re-run the preflight.',
    };
  }
  return {
    mode: 'auto-merge',
    authorized: true,
    reason: 'In-session merge authorization held — delivery subagents may unattended-merge on a green bar.',
  };
}

/** True when the resolved mode permits an unattended live merge. */
export function isAutoMergeMode(mode) {
  return mode === 'auto-merge';
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  // Thin CLI: print the effective mode + notice. `--authorized` asserts a live grant
  // is held (the orchestrator only passes it after a genuine in-session user turn).
  const authorized = process.argv.slice(2).includes('--authorized');
  const decision = mergeAuthPreflight({ authorized });
  console.log(`autopilot merge-auth preflight: ${decision.mode}`);
  console.log(decision.reason);
  process.exit(decision.mode === 'auto-merge' ? 0 : 3);
}
