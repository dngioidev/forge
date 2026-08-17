#!/usr/bin/env node
/**
 * autopilot select — "what's the next actionable ticket?" (#128, spec §5).
 * Pure selection over normalized board tickets, so the order is testable in
 * isolation from GitHub. The loop reads the board fresh each iteration and
 * asks this for the next unit of work.
 */
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { run, makeGh } from '../lib/exec.mjs';
import { makeBoardCtx } from '../lib/boardctx.mjs';
import { isShaped } from './readiness.mjs';
import { pendingDecisions } from '../lib/situation.mjs';
import { pendingDependencies, resolveDependencies } from '../lib/dependencies.mjs';
import { WORK_TYPES } from '../lib/ticket.mjs';

// Tier: lower runs first. Resume-in-flight beats fresh work; ready beats backlog.
// Exported (#504): the env preflight's board-status-keys probe compares the
// live board's normalized Status option names against these exact keys, so
// it fails loudly on drift instead of duplicating a copy that could itself
// go stale.
export const TIER = { inProgress: 0, inReview: 0, ready: 1, backlog: 2 };
// Never selected — blocked has a pending decision; the rest are terminal.
export const SKIP = new Set(['blocked', 'done', 'wontDo']);
// Umbrella types (#175) are containers, not units of work — a program/epic
// ticket is never itself deliverable, so it must never be selected regardless
// of status. normalize() already captures `type`; this is the guard that uses it.
const UMBRELLA_TYPES = new Set(['program', 'epic']);
const PRIORITY_RANK = { p0: 0, p1: 1, p2: 2 };

/**
 * status → what the loop should do with it. A backlog ticket routes on its
 * readiness (#142, spec §6): SHAPED (has acceptance) → triage/deliver; NOT shaped
 * → `shape` under crazy mode (`--shape`), else `escalate`. When readiness is
 * unknown (not computed) it falls back to the existing auto-triage front door,
 * which itself escalates a genuinely under-specified ticket — so plain autopilot
 * is unchanged.
 */
export function actionFor(status, { shape = false, ready = null } = {}) {
  if (status === 'inProgress' || status === 'inReview') return 'resume';
  if (status === 'ready') return 'deliver';
  if (status === 'backlog') {
    if (ready === false) return shape ? 'shape' : 'escalate';
    return 'triage';
  }
  return null;
}

/**
 * Pick the next actionable ticket. `tickets` are normalized:
 * `{ number, title, status, priority, area? }`. Returns `{ ticket, action }`
 * or `null` when nothing is actionable. Order: tier, then priority, then
 * FIFO (issue number as a creation-order stand-in).
 *
 * `pendingIssues` (#499, AC-499.1/.4): a `Set<number>` of tickets that have an
 * unresolved entry in `.forge/decisions/`, threaded in by the caller (never
 * read from disk here — that would break the pure/hermetic contract, AC-499.4).
 * A ticket in this set is excluded regardless of board status, because the
 * board move that normally parks it at `blocked` can drift or fail silently
 * (#499) — the decision file is the source of truth, the board status is only
 * its usual shadow. Callers build this set from `pendingDecisions()`
 * (`lib/situation.mjs`), which already degrades a missing/unreadable
 * `.forge/decisions/` to "no pending decisions" (AC-499.3).
 *
 * `dependencyIssues` (#487 AC.1/AC.2): a `Set<number>` of tickets carrying an
 * unresolved entry in `.forge/autopilot/dependencies/` — a "sequenced behind
 * #N" triage verdict, threaded in by the caller from `lib/dependencies.mjs`
 * `pendingDependencies()` the same way `pendingIssues` is threaded in from
 * `pendingDecisions()` (never read from disk here — same hermetic/pure
 * contract). Kept as a DISTINCT parameter from `pendingIssues` rather than
 * merged into it (AC.4): the two exclusion reasons have different unblock
 * mechanics — a pending decision needs a human answer (`forge-decisions`
 * monitor), a dependency clears automatically once `dependsOn` closes
 * (`resolveDependencies`, checked every `select.mjs` invocation) — so a
 * reader/tester can always tell which store excluded a given ticket.
 */
export function selectNext(tickets, { area = null, shape = false, pendingIssues = new Set(), dependencyIssues = new Set() } = {}) {
  const actionable = tickets
    .filter((t) => !SKIP.has(t.status) && TIER[t.status] !== undefined)
    .filter((t) => !UMBRELLA_TYPES.has(t.type)) // #175: umbrella items are containers, never deliverable
    .filter((t) => !pendingIssues.has(t.number)) // #499 AC-499.1: pending decision excludes regardless of status
    .filter((t) => !dependencyIssues.has(t.number)) // #487 AC.1/AC.2: sequenced-behind dependency excludes regardless of status
    .filter((t) => (area ? t.area === area : true))
    .sort((a, b) =>
      (TIER[a.status] - TIER[b.status]) ||
      ((PRIORITY_RANK[a.priority] ?? 3) - (PRIORITY_RANK[b.priority] ?? 3)) ||
      (a.number - b.number));
  const ticket = actionable[0];
  if (!ticket) return null;
  return { ticket, action: actionFor(ticket.status, { shape, ready: ticket.ready ?? null }) };
}

/** Everything the loop could still touch, in the order it will touch it. */
export function actionableQueue(tickets, opts = {}) {
  const q = [];
  let pool = tickets;
  // selectNext is stable enough to just re-rank the whole set once:
  const ranked = [];
  let pick;
  const seen = new Set();
  while ((pick = selectNext(pool.filter((t) => !seen.has(t.number)), opts))) {
    ranked.push(pick);
    seen.add(pick.ticket.number);
  }
  return ranked;
}

// #526: the WORK_TYPES prefix among the two kinds ratebudget.mjs's KIND_COST_ESTIMATES has
// measured evidence for. `estimateTicketCost` only knows a real per-kind number for docs/spike
// tickets (#462, #448) — every other real ticket-type prefix (feat/fix/chore/refactor/test/
// perf/hotfix) still falls through to the existing recentDeltas-based estimate untouched, so
// ticketKind deliberately does not surface them even though the regex below is built from the
// full WORK_TYPES vocabulary (reusing lib/ticket.mjs's branch-naming prefix list instead of
// re-inventing a parallel one, so a scoped/case-varied prefix like "spike(auth):" or "DOCS:" is
// recognized the same way a branch name would be).
const COST_KNOWN_KINDS = ['docs', 'spike'];
// Leading `<type>:` / `<type>(scope):` only — a trailing marker like "(spike)" with no leading
// prefix must never read as cheap (no false-cheap positives feeding the rate-budget gate), so
// the match is anchored to the start of the title. Requires exactly one space after the colon
// (the `(?!\s)` blocks a second space) to match real commit/branch-style titles, not "docs:  x".
const KIND_PREFIX_RE = new RegExp(`^(${WORK_TYPES.join('|')})(\\([^)]*\\))?: (?!\\s)`, 'i');

/**
 * Classify a ticket title by its leading `<type>:`/`<type>(scope):` prefix, case-insensitive.
 * Returns the lowercase matched type when it's one of `COST_KNOWN_KINDS` (docs/spike — the only
 * kinds `ratebudget.mjs`'s `estimateTicketCost` has a measured per-kind cost for), else `null`.
 * Never throws on a malformed `title` (non-string, `null`, `undefined`, an object) — returns
 * `null` instead, mirroring `parseBranch`'s fail-to-unknown contract.
 *
 * #530 DEMOTION — no longer the primary signal. Measured against 8 real board titles, only 2
 * classified (docs/spike); the rest — including conventional repo prefixes like `denylist:` and
 * `tests:` that simply aren't in `WORK_TYPES` — returned `null` and took the conservative MAX
 * path unconditionally, so the per-kind mechanism (#526) almost never fired. `normalize()` below
 * now sources `t.kind` from the board `type` field first (~100% coverage, see its own docblock);
 * this function survives only as the fallback for the type-missing case, per #530's own note that
 * it "need not be deleted... but must not be the primary or sole source for a decision that gates
 * spending." Kept here, unchanged in behavior, so that fallback path's cost evidence (see below)
 * remains available.
 *
 * Trust boundary (#526 security pass, narrowed by #530): a ticket TITLE is editable by anyone
 * with repo issue-write/triage access — a broader, DIFFERENT permission scope than the
 * Projects-v2 board-write access required to move a ticket to `ready` (or, per `create.mjs`, to
 * set its `type`). A mistitled ticket (e.g. a `docs:` prefix on genuinely contested code) can
 * still under-price the FALLBACK check that only runs when the board `type` field is absent. This
 * is now a materially narrower trust extension than #526 shipped (the title only matters when
 * type is unavailable, not on every ticket): (1) the ground-truth `remaining` reading is still a
 * real `gh api rate_limit` call, never attacker-supplied — only the *threshold* is influenced,
 * not the observation; (2) `UNATTRIBUTED_DRAIN_FLOOR` (`ratebudget.mjs`) still floors every
 * known-kind estimate, so it can never collapse toward zero; (3) worst case is a degraded/
 * exhausted-mid-delivery run (an availability/robustness hit on the autopilot loop itself), not
 * data exposure or an auth bypass. Treat a change that widens `ticketKind`'s recognized
 * vocabulary, removes the drain floor, or promotes it back above the board `type` field as a
 * trust-boundary change, not a routine tweak.
 */
export function ticketKind(title) {
  if (typeof title !== 'string') return null;
  const m = KIND_PREFIX_RE.exec(title);
  if (!m) return null;
  const type = m[1].toLowerCase();
  return COST_KNOWN_KINDS.includes(type) ? type : null;
}

/**
 * Map a raw board item (gh project item-list) to the normalized shape.
 *
 * #530 (AC.1): `t.kind` — the signal `ratebudget.mjs`'s `evaluateRateBudget`/`estimateTicketCost`
 * gate spending on — is now sourced from the board `type` field FIRST, falling back to the
 * title-prefix `ticketKind(title)` classifier only when `type` is unavailable (a missing Type
 * field on the board, or a raw item shape that predates one). This is a strict coverage
 * improvement: `type` is set on every ticket by `board/create.mjs --type` (Projects-v2 board-
 * write access, not free-text issue-title access — closing the #526 trust-boundary finding) and
 * was measured populated on 100% of this board's 30 currently-open tickets, vs. 2/8 for the old
 * title-only classifier on the same real titles (#530 evidence table). Unlike the title prefix,
 * `type` is never used as a cost-table lookup key here (see `ratebudget.mjs` `KIND_COST_ESTIMATES`
 * for why: this board's `type` vocabulary — epic/item/bug/test, confirmed live via
 * `gh project field-list` — has no `docs`/`spike` value at all, and the one clean same-type data
 * point available (#462 "docs" ~975pt vs. #438 "contested" ~4993pt — BOTH board type `Item`)
 * proves a single type spans a >5x measured cost range, so an unrecognized/no-cost-evidence type
 * MUST fall through to the existing #517 MAX-based path (AC.2/AC.4), unchanged.
 */
export function normalize(ctx, item) {
  const title = item.content?.title ?? item.title ?? '';
  const type = ctx.itemFieldKey(item, 'type');
  return {
    number: item.content?.number ?? null,
    title,
    status: ctx.itemFieldKey(item, 'status'),
    priority: ctx.itemFieldKey(item, 'priority'),
    type,
    area: ctx.itemFieldKey(item, 'area'), // #146: null when the board has no Area field
    // #530: board type first (primary, ~100% coverage); ticketKind(title) only when type is
    // absent (secondary/fallback — see both docblocks above). `||`, not `??`: a set-but-blank
    // type (theoretical — optionKey('') is falsy but not null/undefined) must fall back too,
    // not short-circuit to kind:''. Feeds estimateTicketCost's per-kind rate-budget estimate
    // (ratebudget.mjs).
    kind: type || ticketKind(title),
  };
}

/**
 * The two exclusion sets `selectNext` needs, gathered in one place so the CLI
 * main below stays thin (#487 fix-wave — forge:reviewer round 1 caught the
 * mutating `resolveDependencies` call running unconditionally ahead of the
 * `--dry-run` gate; extracting this made the ordering unit-testable without
 * standing up a full `makeBoardCtx`).
 *
 * `--dry-run`'s own documented contract (§ Selection) is "change nothing":
 * `resolveDependencies` performs real `gh issue view` calls AND deletes
 * on-disk records, so it is skipped entirely under `dryRun` — the set is
 * still built from whatever `pendingDependencies` currently holds, just
 * without the mutating re-check first (a dry-run may show a ticket parked
 * one pass longer than a live run would, never the reverse).
 */
export async function resolveExclusionSets(cwd, { gh, dryRun = false } = {}) {
  // #499 AC-499.1: exclude any ticket with a pending decision, independent of board status.
  const pending = await pendingDecisions(cwd);
  // Number(): a hand-edited/migrated decision file's `issue` isn't schema-enforced the
  // way the CLI/MCP writers are (Number.isInteger / {type:'integer'}) — normalize so a
  // stray string id can't silently fail the Set.has() match below and fail OPEN (#499 security pass).
  const pendingIssues = new Set(pending.map((d) => Number(d.issue)));
  // #487 AC.3: re-check every recorded "sequenced behind #N" dependency FIRST, so a
  // dependency that closed since the last pass is discovered and cleared before this
  // pass's selection reads the store — the ticket becomes selectable again the very
  // iteration its blocker lands, not one pass late. Skipped under --dry-run (see above).
  if (!dryRun) await resolveDependencies(cwd, { gh });
  const dependencies = await pendingDependencies(cwd);
  const dependencyIssues = new Set(dependencies.map((d) => Number(d.issue)));
  return { pendingIssues, dependencyIssues };
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  const gh = makeGh(run);
  makeBoardCtx({ gh, cwd: process.cwd() }).then(async (ctx) => {
    if (!ctx.ok) { console.error(ctx.error); process.exit(1); }
    const area = process.argv.includes('--area') ? process.argv[process.argv.indexOf('--area') + 1] : null;
    if (area && !ctx.fields.area) console.warn(`autopilot: --area ${area} given but this board has no Area field — forge:init maps one when the project has an "Area" single-select; nothing will match until then.`);
    const shape = process.argv.includes('--shape'); // crazy mode
    const dryRun = process.argv.includes('--dry-run');
    const list = await ctx.listItems();
    if (!list.ok) { console.error(list.error); process.exit(1); }
    const tickets = list.items.map((i) => normalize(ctx, i)).filter((t) => t.number != null);
    // Readiness routing (#142): backlog tickets branch on whether they're shaped.
    // Only the backlog set needs a body read — the rest route on status alone.
    // #176: ctx.config (already-loaded forge.json) can extend the AC-heading list
    // via readiness.acHeadings, so isShaped honors localized headings.
    for (const t of tickets.filter((x) => x.status === 'backlog')) {
      const view = await ctx.gh(['issue', 'view', String(t.number), '--json', 'body'], { parseJson: true });
      t.ready = view.ok ? isShaped(view.json?.body, ctx.config) : null;
    }
    const { pendingIssues, dependencyIssues } = await resolveExclusionSets(ctx.cwd, { gh: ctx.gh, dryRun });
    const next = selectNext(tickets, { area, shape, pendingIssues, dependencyIssues });
    if (!next) { console.log('autopilot: no actionable ticket — board is clear'); process.exit(0); }
    console.log(`next: #${next.ticket.number} [${next.ticket.status}/${next.ticket.priority ?? '—'}] → ${next.action} — ${next.ticket.title}`);
    if (dryRun) {
      const q = actionableQueue(tickets, { area, shape, pendingIssues, dependencyIssues });
      console.log(`\nqueue (${q.length})${shape ? ' — crazy mode (--shape)' : ''}:`);
      for (const { ticket, action } of q) console.log(`  #${ticket.number} [${ticket.status}/${ticket.priority ?? '—'}${ticket.kind ? `/${ticket.kind}` : ''}] → ${action} — ${ticket.title}`);
    }
  });
}
