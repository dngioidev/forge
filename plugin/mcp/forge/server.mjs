#!/usr/bin/env node
/**
 * forge-core MCP server (#288, ADR-0007 AC2 / §b) — the structured-return
 * enhancement over forge's portable node engine. A sibling to forge-graph, it
 * reuses the same hand-rolled, zero-dep JSON-RPC transport factored into
 * ../lib/rpc.mjs, and exposes the board / gate / release / autopilot capabilities
 * whose CALLER needs a typed return to decide its next move (pass/fail,
 * changed/verified, the merge-bar vector, the readiness checklist) — not stdout
 * scraping. Each tool wraps the existing `scripts/<area>/*.mjs` exported runX /
 * pure function directly (import, not subprocess) and returns its structured
 * object. Nothing here holds board or gate logic of its own; it is a thin,
 * validated MCP facade over the portable core.
 *
 * Policy line (ADR-0007 §b, owner decision): autopilot_merge_bar COMPUTES the
 * {merge, blockedOn} vector on every host, but performs no merge side effect.
 * autopilot_merge (this server) is the CANONICAL live-merge path: it computes
 * the same bar AND executes the squash-merge behind it (via scripts/autopilot/
 * merge.mjs runMerge), so an in-host autopilot merge goes through the bar by
 * construction — nothing merges on red. The live merge stays Claude-only by
 * policy: hosts that must not auto-merge simply never call it (and
 * features.autopilotAutoMerge:false remains the parks-at-PR guard).
 */
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { validateInput, canonicalize, rpcError, toolText, makeRpcHandler, serve } from '../lib/rpc.mjs';
import { run, makeGh } from '../../scripts/lib/exec.mjs';
import { makeBoardCtx } from '../../scripts/lib/boardctx.mjs';
import { loadConfig } from '../../scripts/lib/config.mjs';
import { runMove } from '../../scripts/board/move.mjs';
import { runComment, PHASES } from '../../scripts/board/comment.mjs';
import { runCreate, withDefaults } from '../../scripts/board/create.mjs';
import { runEscalate } from '../../scripts/board/escalate.mjs';
import { runStatus } from '../../scripts/board/status.mjs';
import { selectNext, actionableQueue, normalize } from '../../scripts/autopilot/select.mjs';
import { isShaped } from '../../scripts/autopilot/readiness.mjs';
import { evaluateMergeBar, runMerge } from '../../scripts/autopilot/merge.mjs';
import { computeReadiness } from '../../scripts/release/readiness.mjs';
import { runAcGate } from '../../scripts/gates/acgate.mjs';
import { runConventions } from '../../scripts/gates/conventions.mjs';
import { runDepGuard } from '../../scripts/gates/depguard.mjs';
import { runDocSync } from '../../scripts/gates/docsync.mjs';
import { runGroundGate } from '../../scripts/gates/groundgate.mjs';
import { runLicenseGate } from '../../scripts/gates/license.mjs';
import { runPlanDrift } from '../../scripts/gates/plandrift.mjs';
import { runGate as runSituationGate } from '../../scripts/gates/situationgate.mjs';
import { runTestIntent } from '../../scripts/gates/testintent.mjs';

const noop = () => {};

/** The gate names gate_run dispatches to (spec §b enum). */
export const GATE_NAMES = ['ac', 'conventions', 'dep', 'docsync', 'ground', 'license', 'plandrift', 'situation', 'testintent'];

export const TOOLS = [
  {
    name: 'board_move',
    description: 'Move a ticket to a board status; returns whether it changed and whether the move VERIFIED (re-read confirms it persisted).',
    inputSchema: {
      type: 'object',
      properties: { issue: { type: 'integer' }, status: { type: 'string', minLength: 1 } },
      required: ['issue', 'status'],
    },
  },
  {
    name: 'board_comment',
    description: 'Post an idempotent ticket-trail comment for a lifecycle phase (started/plan/pr/ci-green/...).',
    inputSchema: {
      type: 'object',
      properties: {
        issue: { type: 'integer' },
        phase: { type: 'string', enum: PHASES },
        body: { type: 'string', minLength: 1 },
        actor: { type: 'string' },
        session: { type: 'string' },
      },
      required: ['issue', 'phase', 'body'],
    },
  },
  {
    name: 'board_create',
    description: 'Create (or resume) a ticket with board item + fields; returns the new/existing number and url.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', minLength: 1 },
        body: { type: 'string' },
        type: { type: 'string' },
        priority: { type: 'string' },
        size: { type: 'string' },
        area: { type: 'string' },
        parent: { type: 'integer' },
      },
      required: ['title'],
    },
  },
  {
    name: 'board_escalate',
    description: 'The halt-and-ask spine: block the ticket, post a decision comment with >=2 options, write a pending decision.',
    inputSchema: {
      type: 'object',
      properties: {
        issue: { type: 'integer' },
        reason: { type: 'string', minLength: 1, maxLength: 2000 },
        // Bounded fan-out/size (#296/AC2): a decision has a handful of options, each a short label.
        options: { type: 'array', items: { type: 'string', maxLength: 2000 }, minItems: 2, maxItems: 20 },
        recommend: { type: 'string', maxLength: 2000 },
        context: { type: 'string', maxLength: 10000 },
      },
      required: ['issue', 'reason', 'options'],
    },
  },
  {
    name: 'board_status',
    description: 'The same catch-up card `forge board status` prints (situation, pending decisions, counts, blocked/in-progress, open PRs, next expected human action), plus normalized items[] (number/title/status/priority/type/area), optionally filtered to one issue.',
    inputSchema: { type: 'object', properties: { issue: { type: 'integer' } }, required: [] },
  },
  {
    name: 'gate_run',
    description: 'Run one mechanical gate and return its verdict as {level:pass|fail, findings[]}. gate is one of ac|conventions|dep|docsync|ground|license|plandrift|situation|testintent.',
    inputSchema: {
      type: 'object',
      properties: {
        gate: { type: 'string', enum: GATE_NAMES },
        // union of per-gate args; each gate reads only its own and teaches on a miss
        plan: { type: 'string' },
        ticket: { type: 'integer' },
        // Bounded fan-out (#296/AC2): each entry is a vitest-json path fed to glob/readFile; cap the count and path length.
        results: { type: 'array', items: { type: 'string', maxLength: 1024 }, maxItems: 256 },
        acs: { type: 'string' },
        base: { type: 'string' },
        manifest: { type: 'string' },
        action: { type: 'string' },
        branch: { type: 'string' },
        skill: { type: 'string' },
      },
      required: ['gate'],
    },
  },
  {
    name: 'release_readiness',
    description: 'Evaluate the release-readiness checklist item-by-item; returns {items:[{name,level,msg}]} (level pass|skip|fail).',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'autopilot_select',
    description: 'Pick the next actionable ticket and the ordered queue; returns {next|null, queue[]}. Read-only.',
    inputSchema: {
      type: 'object',
      properties: { area: { type: 'string' }, shape: { type: 'boolean' } },
      required: [],
    },
  },
  {
    name: 'autopilot_merge_bar',
    description: 'COMPUTE the merge-bar vector from the signal set; returns {merge, blockedOn[]}. Pure computation, no merge side effect (live merge is Claude-only per ADR-0007).',
    inputSchema: {
      type: 'object',
      properties: {
        signals: { type: 'object' },
        critical: { type: 'boolean' },
      },
      required: ['signals'],
    },
  },
  {
    name: 'autopilot_merge',
    description: 'EXECUTE the gated live merge — the SINGLE sanctioned autopilot merge path. Checks CI, evaluates the full bar over {ship,gates,reviewer,security,ci}, and squash-merges ONLY when every signal is green (fail-closed: a missing/red signal or critical never merges). Returns {merged, parked, outcome, blockedOn}. Claude-only by policy per ADR-0007 — a raw `gh pr merge` bypasses this bar and is NOT sanctioned; features.autopilotAutoMerge:false parks at the PR.',
    inputSchema: {
      type: 'object',
      properties: {
        issue: { type: 'integer' },
        pr: { type: 'integer' },
        signals: { type: 'object' },
        critical: { type: 'boolean' },
        mode: { type: 'string', enum: ['auto-merge', 'pr-only'], description: 'Effective merge mode from the run-start merge-auth preflight (run.json). "pr-only" (no in-session grant) parks at the PR — never merges.' },
      },
      required: ['issue', 'pr', 'signals'],
    },
  },
];

/** Default engine bindings; injectable so each tool's contract is testable without live gh/git. */
export const DEFAULT_DEPS = {
  runMove, runComment, runCreate, runEscalate, runStatus,
  selectNext, actionableQueue, normalize, isShaped,
  evaluateMergeBar, runMerge, computeReadiness, loadConfig,
  execFn: run,
  gates: { ac: runAcGate, conventions: runConventions, dep: runDepGuard, docsync: runDocSync, ground: runGroundGate, license: runLicenseGate, plandrift: runPlanDrift, situation: runSituationGate, testintent: runTestIntent },
};

/** Per-gate: how to invoke it with root+args, and how to read its verdict into {level,findings}. */
const GATE_SPEC = {
  ac: {
    invoke: (fn, a, root) => fn({ acs: a.acs ?? null, plan: a.plan ?? null, ticket: a.ticket ?? null, results: a.results ?? [], cwd: root }, noop),
    verdict: (r) => ({ level: r.ok ? 'pass' : 'fail', findings: [...(r.missing ?? []).map((i) => `AC ${i}: no passing test`), ...(r.failing ?? []).map((i) => `AC ${i}: failing test`)] }),
  },
  conventions: {
    invoke: (fn, a, root) => fn({ cwd: root, base: a.base ?? 'main', log: noop }),
    verdict: (r) => ({ level: r.ok ? 'pass' : 'fail', findings: (r.violations ?? []).map((v) => `${v.sha} "${v.subject}": ${v.reason}`) }),
  },
  dep: {
    invoke: (fn, a, root) => fn({ cwd: root, base: a.base ?? 'main', log: noop }),
    verdict: (r) => ({ level: r.ok ? 'pass' : 'fail', findings: (r.violations ?? []).map((v) => `${v.name}: ${v.reason}`) }),
  },
  docsync: {
    invoke: (fn, a, root) => fn({ cwd: root, base: a.base ?? 'main', log: noop }),
    verdict: (r) => ({ level: r.ok ? 'pass' : 'fail', findings: [...(r.routeGaps ?? []).map((g) => `unindexed doc: ${g}`), ...(r.skillGaps ?? []).map((s) => `undocumented skill: ${s}`), ...(r.badgeDrift ? [`README version badge ${r.badgeDrift.badge} ≠ package.json ${r.badgeDrift.pkg}`] : [])] }),
  },
  ground: {
    invoke: (fn, a, root) => fn({ cwd: root, manifestPath: a.manifest, log: noop }),
    verdict: (r) => ({ level: r.ok ? 'pass' : 'fail', findings: (r.ungrounded ?? []).map((u) => `ungrounded: ${u.claim}`) }),
  },
  license: {
    invoke: (fn, a, root) => fn({ cwd: root, log: noop }),
    verdict: (r) => ({ level: r.ok ? 'pass' : 'fail', findings: [...(r.plugin?.problems ?? []).map((p) => `plugin-license: ${p}`), ...(r.violations ?? []).map((v) => `${v.name}: ${v.license} — ${v.reason}`)] }),
  },
  plandrift: {
    invoke: (fn, a, root) => fn({ cwd: root, planPath: a.plan, base: a.base ?? 'main', log: noop }),
    verdict: (r) => ({ level: r.ok ? 'pass' : 'fail', findings: (r.deviations ?? []).map((f) => `off-plan: ${f}`) }),
  },
  situation: {
    invoke: (fn, a, root) => fn(root, { action: a.action, branch: a.branch ?? '', skill: a.skill ?? null }, noop),
    verdict: (r) => ({ level: r.allowed ? 'pass' : 'fail', findings: r.allowed ? [] : [r.why] }),
  },
  testintent: {
    invoke: (fn, a, root) => fn({ cwd: root, base: a.base ?? 'main', log: noop }),
    verdict: (r) => ({ level: r.ok ? 'pass' : 'fail', findings: (r.weakenings ?? []).map((w) => `weakened: ${w.file ?? ''}`) }),
  },
};

/** Keep only defined keys so board_create's withDefaults isn't clobbered by undefined. */
function definedOnly(obj) {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined));
}

/** A git-ref-safe token: no shell chars, no leading dash (so it can't pose as a git option). */
const REF_SAFE = /^[A-Za-z0-9._/-]+$/;
function refSafe(v) {
  return typeof v === 'string' && REF_SAFE.test(v) && !v.startsWith('-');
}

/**
 * Harden the caller-supplied gate args before they reach filesystem reads and
 * git revision-specs. Path args are confined to the repo root (the same
 * blast_radius precedent in forge-graph); base/branch are ref-validated so an
 * adversarial value can't slip in as a git option through a single argv token.
 * Returns { args } on success or { error } with a teaching message.
 */
function sanitizeGateArgs(root, raw) {
  let args = raw;
  for (const key of ['plan', 'manifest']) {
    if (args[key] != null) {
      const rel = canonicalize(root, args[key]);
      if (rel == null) return { error: `'${key}' must stay inside the repo root` };
      args = { ...args, [key]: rel };
    }
  }
  if (Array.isArray(args.results)) {
    const rels = args.results.map((f) => canonicalize(root, f));
    if (rels.some((r) => r == null)) return { error: "'results' paths must stay inside the repo root" };
    args = { ...args, results: rels };
  }
  for (const key of ['base', 'branch']) {
    if (args[key] != null && !refSafe(args[key])) return { error: `'${key}' must be a git-ref-safe name (letters, digits, . _ / -, no leading dash)` };
  }
  return { args };
}

/**
 * Build the forge-core protocol handler. `getCtx()` resolves the board context
 * lazily (gh + forge.json), so gate/merge-bar tools that need neither still work
 * when gh is unavailable. `deps` is injectable for tests.
 */
export function makeHandler({ root, getCtx, deps = DEFAULT_DEPS }) {
  const teach = (id, error) => toolText(id, { ok: false, error }, true);

  async function board(id, fn) {
    const ctx = await getCtx();
    if (!ctx.ok) return teach(id, ctx.error);
    return fn(ctx);
  }

  const onCall = async ({ id, tool, args }) => {
    const invalid = validateInput(tool.inputSchema, args);
    if (invalid) return rpcError(id, -32602, `invalid arguments for ${tool.name}: ${invalid}`);
    try {
      switch (tool.name) {
        case 'board_move':
          return board(id, async (ctx) => {
            const r = await deps.runMove(ctx, { issue: args.issue, status: args.status }, noop);
            if (!r.ok) return teach(id, r.error);
            return toolText(id, { ok: true, changed: r.changed ?? false, verified: r.verified ?? null, status: args.status });
          });

        case 'board_comment':
          return board(id, async (ctx) => {
            const r = await deps.runComment(ctx, { issue: args.issue, phase: args.phase, body: args.body, actor: args.actor ?? null, session: args.session ?? null }, noop);
            if (!r.ok) return teach(id, r.error);
            return toolText(id, { ok: true, action: r.action });
          });

        case 'board_create':
          return board(id, async (ctx) => {
            const spec = withDefaults(definedOnly({ title: args.title, body: args.body, type: args.type, priority: args.priority, size: args.size, area: args.area, parent: args.parent }));
            const r = await deps.runCreate(ctx, spec, noop);
            if (!r.ok) return teach(id, r.error);
            // runCreate returns the number; synthesize the canonical issue URL.
            const url = `https://github.com/${ctx.owner}/${ctx.repo}/issues/${r.number}`;
            return toolText(id, { ok: true, number: r.number, url, resumed: r.resumed ?? false, parentless: r.parentless ?? false });
          });

        case 'board_escalate':
          return board(id, async (ctx) => {
            // Pass the typed array straight through (#300 AC.1): the schema's maxItems
            // bound then genuinely holds — no pipe-join for an embedded '|' to re-split past.
            const r = await deps.runEscalate(ctx, { issue: args.issue, reason: args.reason, options: args.options, recommend: args.recommend ?? null, context: args.context ?? '' }, noop);
            if (!r.ok) return teach(id, r.error);
            return toolText(id, { ok: true, id: r.id, boardNote: r.boardNote ?? null, pending: r.pending ?? true });
          });

        case 'board_status':
          // #399: delegate the catch-up card (situation/counts/blocked/next) to the
          // SAME runStatus the CLI (`forge board status`) uses, instead of a separate
          // inline reimplementation — the two paths now compute identical data for the
          // same board state. items[] (optionally filtered to one issue) stays a
          // separate, additive read-model on top, unaffected by that computation.
          return board(id, async (ctx) => {
            const list = await ctx.listItems();
            if (!list.ok) return teach(id, list.error);
            let items = list.items.filter((i) => i.content?.number != null).map((i) => deps.normalize(ctx, i));
            if (args.issue != null) items = items.filter((t) => t.number === args.issue);
            const status = await deps.runStatus(ctx, noop);
            if (!status.ok) return teach(id, status.error);
            const { owner, repo, projectNumber, situation, counts, blocked, inProgress, openPrs, next } = status.data;
            return toolText(id, { ok: true, items, owner, repo, projectNumber, situation, counts, blocked, inProgress, openPrs, next });
          });

        case 'gate_run': {
          const clean = sanitizeGateArgs(root, args);
          if (clean.error) return rpcError(id, -32602, `invalid arguments for gate_run: ${clean.error}`);
          const spec = GATE_SPEC[args.gate];
          const fn = deps.gates[args.gate];
          const r = await spec.invoke(fn, clean.args, root);
          if (r.error) return teach(id, r.error); // operational/teaching failure (bad args, unreadable input)
          const { level, findings } = spec.verdict(r);
          return toolText(id, { ok: true, gate: args.gate, level, findings });
        }

        case 'release_readiness': {
          const cfg = await deps.loadConfig(root);
          // #296/AC3: a missing/broken forge.json used to be swallowed as config:{}, hiding
          // the breakage and evaluating readiness against empty config. Teach the caller instead.
          if (!cfg.ok) {
            const why = cfg.missing ? '.claude/forge.json is missing' : '.claude/forge.json is broken';
            const detail = (cfg.errors ?? []).join('; ');
            return teach(id, `release-readiness cannot evaluate: ${why}${detail ? ` (${detail})` : ''} — run /forge:init to repair it`);
          }
          const config = cfg.config;
          const r = await deps.computeReadiness({ cwd: root, execFn: deps.execFn, config, verifyCmd: config.conventions?.verify });
          return toolText(id, { ok: r.ok, items: r.items });
        }

        case 'autopilot_select':
          return board(id, async (ctx) => {
            const list = await ctx.listItems();
            if (!list.ok) return teach(id, list.error);
            const tickets = list.items.map((i) => deps.normalize(ctx, i)).filter((t) => t.number != null);
            // Backlog tickets route on readiness (#142): one body read each; the rest route on status alone.
            for (const t of tickets.filter((x) => x.status === 'backlog')) {
              const view = await ctx.gh(['issue', 'view', String(t.number), '--json', 'body'], { parseJson: true });
              t.ready = view.ok ? deps.isShaped(view.json?.body, ctx.config) : null;
            }
            const opts = { area: args.area ?? null, shape: args.shape ?? false };
            const next = deps.selectNext(tickets, opts);
            const queue = deps.actionableQueue(tickets, opts);
            return toolText(id, { ok: true, next: next ?? null, queue });
          });

        case 'autopilot_merge_bar': {
          const bar = deps.evaluateMergeBar(args.signals, { critical: args.critical ?? false });
          return toolText(id, { ok: true, merge: bar.merge, blockedOn: bar.blockedOn });
        }

        case 'autopilot_merge':
          // The canonical live-merge path: runMerge re-checks CI, evaluates the
          // bar, and only then squash-merges — so the merge cannot happen on red
          // by construction. A red bar is NOT an operational error: surface it as
          // a structured {merged:false, blockedOn} so the caller sees the block.
          return board(id, async (ctx) => {
            const r = await deps.runMerge(ctx, { issue: args.issue, pr: args.pr, signals: args.signals, critical: args.critical ?? false, mode: args.mode ?? null }, noop);
            if (r.error) return teach(id, r.error);
            return toolText(id, { ok: true, merged: r.merged ?? false, parked: r.parked ?? false, outcome: r.outcome ?? null, blockedOn: r.blockedOn ?? [], escalate: r.escalate ?? false });
          });
      }
    } catch (e) {
      return toolText(id, { ok: false, error: `${tool.name} failed: ${e.message}` }, true);
    }
    return rpcError(id, -32603, 'unreachable');
  };

  return makeRpcHandler({ serverInfo: { name: 'forge-core', version: '0.1.0' }, tools: TOOLS, onCall });
}

/**
 * Lazy, memoized board-context resolver. Board identity (owner/repo/project)
 * is stable for a session, so resolve once; a failed resolution is NOT cached,
 * so a transient gh hiccup can recover on the next call.
 */
export function makeCtxResolver(root, { gh = makeGh(run) } = {}) {
  let cached = null;
  return async () => {
    if (cached) return cached;
    const ctx = await makeBoardCtx({ gh, cwd: root });
    if (ctx.ok) cached = ctx;
    return ctx;
  };
}

async function main() {
  const root = process.cwd();
  const getCtx = makeCtxResolver(root);
  const handler = makeHandler({ root, getCtx });
  serve((msg) => handler(msg));
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) main();
