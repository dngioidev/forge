/**
 * Work-ordering dependency ledger (#487 AC.1): the durable representation of
 * a "sequenced behind #N" triage verdict — a ticket that IS well-specified
 * (shaped) but triage deliberately declines to promote because another
 * ticket must land first. Board status stays `backlog` (unchanged — see the
 * design note below); this file store is the resting place `select.mjs`'s
 * `selectNext` consults, so the verdict has somewhere to live instead of
 * being re-derived — and the same triage subagent re-spawned — on every pass
 * (the #449 loop this ticket exists to fix).
 *
 * AC.4 — distinct from a PENDING DECISION (`lib/situation.mjs`
 * `pendingDecisions`, `.forge/decisions/`): a decision needs a HUMAN to
 * answer it and is resolved by the `forge-decisions` monitor watching for a
 * trusted reply. A dependency recorded here needs ANOTHER TICKET
 * (`dependsOn`) to close, and is resolved automatically by
 * `resolveDependencies` re-checking that issue's state — no human involved,
 * no monitor wiring: `select.mjs` already re-runs every autopilot iteration,
 * so the check rides that existing cadence (see `resolveDependencies` below
 * for the honest framing of what this is and isn't).
 *
 * AC.1 design note — why a ledger-backed skip-list, not a new board status, a
 * dependency field, or reusing Blocked: #499 already solved the structurally
 * identical problem — "a verdict needs a durable, board-independent resting
 * place `selectNext` consults" — for pending decisions
 * (`pendingDecisions`/`pendingIssues`, shipped and tested). Reusing that
 * shape rather than inventing a fourth mechanism:
 *   1. needs no Projects-v2 schema change — works on an adopted board with no
 *      extra status/field mapped, the same degrade-gracefully posture
 *      `board/escalate.mjs` already has for a board with no `blocked` option;
 *   2. keeps the board's Status column honest — the ticket really is still
 *      in `backlog`, not falsely `blocked` awaiting a decision nobody needs
 *      to make (the #449/#480 "semantic near-miss" #487's own body calls
 *      out — Blocked's documented meaning is "has a pending decision", which
 *      a work-ordering dependency is not);
 *   3. is covered by the exact same testable, pure `selectNext` contract
 *      #499 already proved out — a `Set<number>` of excluded issue numbers,
 *      threaded in by the caller, never read from disk inside `selectNext`
 *      itself (AC-499.4's hermetic-purity rule, extended here unchanged).
 *
 * Honest scope (see #487's body — "at least three kinds, not two"): this
 * store is keyed on an ISSUE NUMBER (`dependsOn`) it can poll for closure —
 * i.e. it only covers the WORK-ORDERING dependency kind. It does not
 * generalize to an EXTERNAL/ENVIRONMENT dependency (#480's shape: no macOS/
 * Linux host, no issue number to watch for closure). That third kind is a
 * real gap this ticket does not close; Blocked remains its only (imperfect)
 * resting place for now — a follow-up would need to generalize this beyond
 * "poll an issue number" before it could cover it too.
 */
import { readdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { readJson, writeJson } from './jsonfile.mjs';

export const DEPENDENCIES_RELDIR = join('.forge', 'autopilot', 'dependencies');

function fileFor(cwd, issue) {
  return join(cwd, DEPENDENCIES_RELDIR, `${issue}.json`);
}

/**
 * Record (or overwrite) a work-ordering dependency: `issue` is not
 * actionable until `dependsOn` closes. Last write wins per issue (mirrors
 * `ledger.mjs` `applyOutcome`'s per-issue overwrite semantics) — a re-triage
 * reaching the same verdict is idempotent, and one reaching a *different*
 * verdict (a different blocking ticket, or a revised reason) naturally
 * supersedes the stale record instead of accumulating stale duplicates.
 */
export async function recordDependency(cwd, { issue, dependsOn, reason = null }) {
  const record = { issue, dependsOn, reason, recordedAt: new Date().toISOString() };
  await writeJson(fileFor(cwd, issue), record);
  return record;
}

/** Drop the dependency record for `issue`. Idempotent — a missing file is not an error. */
export async function clearDependency(cwd, issue) {
  try {
    await unlink(fileFor(cwd, issue));
  } catch (err) {
    if (err?.code !== 'ENOENT') throw err;
  }
}

/**
 * Every currently-recorded dependency, tolerating a missing directory (no
 * dependency ever recorded — the common case) or an unreadable/corrupt
 * individual record file: same degrade-safely posture as `lib/situation.mjs`
 * `pendingDecisions` — a hand-edited or half-written record must not crash
 * selection, it is simply skipped rather than propagating.
 */
export async function pendingDependencies(cwd) {
  const dir = join(cwd, DEPENDENCIES_RELDIR);
  let files;
  try {
    files = await readdir(dir);
  } catch {
    return [];
  }
  const records = [];
  for (const f of files.filter((f) => f.endsWith('.json'))) {
    try {
      const d = await readJson(join(dir, f));
      if (d && Number.isInteger(d.issue) && Number.isInteger(d.dependsOn)) records.push(d);
    } catch { /* unreadable/corrupt record — ignore, same tolerance as pendingDecisions */ }
  }
  return records;
}

/**
 * AC.3 — the discovery mechanism: re-check every recorded dependency's
 * `dependsOn` issue and clear the ones that have closed, so a sequenced
 * ticket becomes selectable again without anyone remembering to unpark it —
 * this is what closed #457 should have surfaced for #449 instead of the
 * orchestrator manually checking `gh issue view 457`.
 *
 * Honest framing (per #487's own instruction not to overclaim): this is a
 * check integrated into `select.mjs`'s existing per-iteration invocation,
 * not a new push-based background monitor like `forge-ci`/`forge-decisions`
 * (`plugin/scripts/monitors/*`). Since `select.mjs` already runs at the top
 * of every autopilot iteration, re-checking here means the clear is
 * discovered within one iteration of it happening — in practice as timely as
 * a push for a loop that already re-selects continuously — but it is a
 * checkable step riding that cadence, not an independent watcher with its
 * own polling loop and monitor-notification wiring.
 *
 * A `gh` call that fails (network blip, rate limit) leaves that record
 * untouched — fails safe toward "still blocked" rather than risking an
 * incorrect early clear on a transient read error.
 *
 * @param {object} opts
 * @param {function} opts.gh injected gh wrapper (`lib/exec.mjs` `makeGh`), same
 *   shape `boardctx.mjs` `ctx.gh` already uses elsewhere in this file's callers.
 */
export async function resolveDependencies(cwd, { gh }) {
  const pending = await pendingDependencies(cwd);
  const cleared = [];
  for (const d of pending) {
    const view = await gh(['issue', 'view', String(d.dependsOn), '--json', 'state'], { parseJson: true });
    if (view.ok && view.json?.state === 'CLOSED') {
      await clearDependency(cwd, d.issue);
      cleared.push(d);
    }
  }
  return { cleared, stillPending: pending.filter((d) => !cleared.some((c) => c.issue === d.issue)) };
}
