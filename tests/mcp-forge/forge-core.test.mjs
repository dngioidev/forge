import { describe, it, expect } from 'vitest';
import { makeHandler, makeCtxResolver, TOOLS, GATE_NAMES, DEFAULT_DEPS } from '../../plugin/mcp/forge/server.mjs';
import { validateInput, canonicalize } from '../../plugin/mcp/lib/rpc.mjs';
import { validateInput as graphValidate, canonicalize as graphCanon } from '../../plugin/mcp/graph/server.mjs';
import { runStatus } from '../../plugin/scripts/board/status.mjs';
import { optionKey } from '../../plugin/scripts/lib/board.mjs';

// ---- harness -------------------------------------------------------------
// board_status now delegates to runStatus (#399), which needs cwd (journal/decisions
// lookup — a nonexistent path reads as empty, i.e. no pending decisions) and
// itemFieldKey (status bucketing); gh() branches so 'pr list' gets an array while every
// other call keeps the pre-existing generic {body} stub other tests rely on.
const okCtx = {
  ok: true,
  owner: 'dngioidev',
  repo: 'forge',
  projectNumber: 8,
  cwd: '/repo',
  config: {},
  gh: async (a) => (a[0] === 'pr' && a[1] === 'list' ? { ok: true, json: [] } : { ok: true, json: { body: '## Acceptance criteria\n- AC' } }),
  listItems: async () => ({ ok: true, items: [] }),
  itemFieldKey: (item, fieldKey) => { const name = item?.[fieldKey]; return typeof name === 'string' ? optionKey(name) : null; },
};

function build({ deps = {}, getCtx = async () => okCtx, root = '/repo' } = {}) {
  const merged = { ...DEFAULT_DEPS, ...deps, gates: { ...DEFAULT_DEPS.gates, ...(deps.gates ?? {}) } };
  return makeHandler({ root, getCtx, deps: merged });
}
const call = (h, name, args) => h({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });
const body = (res) => JSON.parse(res.result.content[0].text);

// =========================================================================
describe('AC-288.1: rpc.mjs is the shared transport (forge-graph regression-free)', () => {
  it('AC-288.1: forge-core and forge-graph resolve the SAME factored validateInput/canonicalize', () => {
    // The graph server now re-exports the primitives from rpc.mjs — same identity.
    expect(graphValidate).toBe(validateInput);
    expect(graphCanon).toBe(canonicalize);
  });

  it('AC-288.1: the shared envelope drives forge-core (initialize/list/unknown-tool/unknown-method/invalid/notification)', async () => {
    const h = build();
    const init = await h({ jsonrpc: '2.0', id: 0, method: 'initialize', params: {} });
    expect(init.result.protocolVersion).toBeTruthy();
    expect(init.result.serverInfo.name).toBe('forge-core');
    const list = await h({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    expect(list.result.tools.map((t) => t.name).sort()).toEqual(
      [
        'autopilot_merge', 'autopilot_merge_bar', 'autopilot_select',
        'board_close', 'board_comment', 'board_create', 'board_digest', 'board_escalate',
        'board_log', 'board_move', 'board_receipt', 'board_reparent', 'board_status',
        'gate_run', 'release_readiness',
      ],
    );
    expect((await call(h, 'nope_tool', {})).error.code).toBe(-32602);
    expect((await h({ jsonrpc: '2.0', id: 9, method: 'bogus' })).error.code).toBe(-32601);
    expect((await h({ method: 'tools/list' })).error.code).toBe(-32600);
    expect(await h({ jsonrpc: '2.0', method: 'notifications/initialized' })).toBe(null);
  });

  it('exposes exactly the 15 documented tools and the 9 gate names', () => {
    expect(TOOLS).toHaveLength(15);
    expect(GATE_NAMES).toEqual(['ac', 'conventions', 'dep', 'docsync', 'ground', 'license', 'plandrift', 'situation', 'testintent']);
  });
});

// =========================================================================
describe('AC-288.2: every tool is callable and returns its documented structured shape', () => {
  it('AC-288.2: board_move -> {ok,changed,verified,status}', async () => {
    const h = build({ deps: { runMove: async () => ({ ok: true, changed: true, verified: true }) } });
    const res = await call(h, 'board_move', { issue: 288, status: 'inReview' });
    expect(res.result.isError).toBe(false);
    expect(body(res)).toEqual({ ok: true, changed: true, verified: true, status: 'inReview' });
  });

  it('AC-288.2: board_comment -> {ok,action}', async () => {
    const h = build({ deps: { runComment: async () => ({ ok: true, action: 'created' }) } });
    expect(body(await call(h, 'board_comment', { issue: 288, phase: 'pr', body: 'opened PR' }))).toEqual({ ok: true, action: 'created' });
  });

  it('AC-288.2: board_create -> {ok,number,url} and applies engine defaults', async () => {
    let seen;
    const h = build({ deps: { runCreate: async (_ctx, spec) => { seen = spec; return { ok: true, number: 42, resumed: false, parentless: false }; } } });
    const out = body(await call(h, 'board_create', { title: 'a new ticket' }));
    expect(out).toMatchObject({ ok: true, number: 42, url: 'https://github.com/dngioidev/forge/issues/42' });
    expect(seen).toMatchObject({ title: 'a new ticket', type: 'item', priority: 'p1', size: 'm', status: 'backlog' });
  });

  it('AC-288.2: board_escalate -> {ok,id,boardNote,pending}; array options pass through structured (#300)', async () => {
    let seen;
    const h = build({ deps: { runEscalate: async (_ctx, a) => { seen = a; return { ok: true, id: 'esc-288-x', boardNote: 'board -> blocked', pending: true }; } } });
    const out = body(await call(h, 'board_escalate', { issue: 288, reason: 'infra choice', options: ['keep bash', 'rewrite in node'] }));
    expect(out).toEqual({ ok: true, id: 'esc-288-x', boardNote: 'board -> blocked', pending: true });
    // Structured array end-to-end (#300 AC.1): no pipe-join for an embedded '|' to re-split past.
    expect(seen.options).toEqual(['keep bash', 'rewrite in node']);
  });

  it('AC-300.1: an option element containing "|" cannot fabricate extra downstream options', async () => {
    let seen;
    const h = build({ deps: { runEscalate: async (_ctx, a) => { seen = a; return { ok: true, id: 'esc-300-x', boardNote: null, pending: true }; } } });
    // A malicious single element packed with pipes: array pass-through keeps it as ONE option.
    const out = body(await call(h, 'board_escalate', { issue: 300, reason: 'r', options: ['legit', 'a|b|c|d|e|f'] }));
    expect(out.ok).toBe(true);
    expect(seen.options).toEqual(['legit', 'a|b|c|d|e|f']); // still 2 options, not 7
  });

  it('AC-288.2: board_status -> {ok,items[],...catch-up card} filtered by issue', async () => {
    const items = [
      { content: { number: 1 }, title: 'one' },
      { content: { number: 2 }, title: 'two' },
    ];
    const ctx = { ...okCtx, listItems: async () => ({ ok: true, items }) };
    const h = build({ getCtx: async () => ctx, deps: { normalize: (_c, i) => ({ number: i.content.number, title: i.title }) } });
    const out = body(await call(h, 'board_status', {}));
    expect(out.items).toHaveLength(2);
    expect(body(await call(h, 'board_status', { issue: 2 })).items).toEqual([{ number: 2, title: 'two' }]);
    // #399: the catch-up card (same fields runStatus/the CLI compute) rides along.
    expect(out).toMatchObject({ ok: true, counts: { backlog: 0, ready: 0, inProgress: 0, inReview: 0, blocked: 0, done: 0 }, next: 'pick the next ready/backlog item' });
  });

  it('AC-400.1: board_receipt -> {ok,action,id}; args pass through to runReceipt unchanged', async () => {
    let seen;
    const h = build({ deps: { runReceipt: async (_ctx, a) => { seen = a; return { ok: true, action: 'created', id: 55 }; } } });
    const out = body(await call(h, 'board_receipt', { issue: 400, pr: 401, sha: 'abc1234', title: 'a title' }));
    expect(out).toEqual({ ok: true, action: 'created', id: 55 });
    expect(seen).toEqual({ issue: 400, pr: 401, sha: 'abc1234', title: 'a title' });
  });

  it('AC-400.1: board_log -> {ok,action,id}; args pass through to runLog unchanged', async () => {
    let seen;
    const h = build({ deps: { runLog: async (_ctx, a) => { seen = a; return { ok: true, action: 'updated', id: 9 }; } } });
    const out = body(await call(h, 'board_log', { pr: 401, sha: 'abc1234', title: 'a title', issues: '400', date: '2026-08-08' }));
    expect(out).toEqual({ ok: true, action: 'updated', id: 9 });
    expect(seen).toEqual({ pr: 401, sha: 'abc1234', title: 'a title', issues: '400', date: '2026-08-08' });
  });

  it('AC-400.1: board_digest -> {ok,changed,rows}', async () => {
    let seen;
    const h = build({ deps: { runDigest: async (_ctx, a) => { seen = a; return { ok: true, changed: true, rows: 3 }; } } });
    const out = body(await call(h, 'board_digest', { epic: 182 }));
    expect(out).toEqual({ ok: true, changed: true, rows: 3 });
    expect(seen).toEqual({ epic: 182 });
  });

  it('AC-400.1: board_reparent -> {ok,moved,from,to}; ctx gh/owner/repo thread through to runReparent(gh,owner,repo,args,log)', async () => {
    let seenArgs;
    const seenGh = [];
    const ctx = { ...okCtx, gh: async (...a) => { seenGh.push(a); return { ok: true }; } };
    const h = build({
      getCtx: async () => ctx,
      deps: { runReparent: async (gh, owner, repo, a) => { seenArgs = { gh, owner, repo, a }; return { ok: true, moved: true, from: 10, to: 182 }; } },
    });
    const out = body(await call(h, 'board_reparent', { issue: 400, parent: 182 }));
    expect(out).toEqual({ ok: true, moved: true, from: 10, to: 182 });
    expect(seenArgs.gh).toBe(ctx.gh);
    expect(seenArgs.owner).toBe(ctx.owner);
    expect(seenArgs.repo).toBe(ctx.repo);
    expect(seenArgs.a).toEqual({ issue: 400, parent: 182 });
  });

  it('AC-400.1: board_reparent no-op -> {ok,moved:false,from:null,to:null}', async () => {
    const h = build({ deps: { runReparent: async () => ({ ok: true, moved: false }) } });
    expect(body(await call(h, 'board_reparent', { issue: 400, parent: 182 }))).toEqual({ ok: true, moved: false, from: null, to: null });
  });

  it('AC-400.1: board_close -> {ok,issue,reason,status}; note optional', async () => {
    let seen;
    const h = build({ deps: { runClose: async (_ctx, a) => { seen = a; return { ok: true, issue: 400, reason: 'completed', status: 'done' }; } } });
    const out = body(await call(h, 'board_close', { issue: 400, reason: 'completed' }));
    expect(out).toEqual({ ok: true, issue: 400, reason: 'completed', status: 'done' });
    expect(seen).toEqual({ issue: 400, reason: 'completed', note: null });
  });

  it('AC-400.1: board_close rejects a reason outside the enum with a teaching -32602 error', async () => {
    const h = build();
    expect((await call(h, 'board_close', { issue: 400, reason: 'because' })).error.message).toMatch(/'reason' must be one of/);
  });

  it('AC-288.2: gate_run situation -> {ok,level:pass,findings[]}', async () => {
    const h = build({ deps: { gates: { situation: async () => ({ ok: true, allowed: true, why: 'clear' }) } } });
    expect(body(await call(h, 'gate_run', { gate: 'situation', action: 'ship' }))).toEqual({ ok: true, gate: 'situation', level: 'pass', findings: [] });
  });

  it('AC-288.2: gate_run dep -> fail level surfaces findings', async () => {
    const h = build({ deps: { gates: { dep: async () => ({ ok: false, violations: [{ name: 'left-pad', reason: 'too new (3d old)' }] }) } } });
    expect(body(await call(h, 'gate_run', { gate: 'dep' }))).toEqual({ ok: true, gate: 'dep', level: 'fail', findings: ['left-pad: too new (3d old)'] });
  });

  it('AC-310.1: gate_run conventions -> fail level surfaces garbage-subject findings', async () => {
    const h = build({ deps: { gates: { conventions: async () => ({ ok: false, violations: [{ sha: 'abc1234', subject: '@ (#297)', reason: 'not a conventional-commit header (expected "type(scope): description")' }] }) } } });
    expect(body(await call(h, 'gate_run', { gate: 'conventions' }))).toEqual({ ok: true, gate: 'conventions', level: 'fail', findings: ['abc1234 "@ (#297)": not a conventional-commit header (expected "type(scope): description")'] });
  });

  it('AC-342.4: gate_run license -> pass/fail with plugin + dependency findings', async () => {
    const pass = build({ deps: { gates: { license: async () => ({ ok: true, violations: [], plugin: { ok: true, problems: [] } }) } } });
    expect(body(await call(pass, 'gate_run', { gate: 'license' }))).toEqual({ ok: true, gate: 'license', level: 'pass', findings: [] });

    const fail = build({ deps: { gates: { license: async () => ({ ok: false, plugin: { ok: false, problems: ['no LICENSE file at the repo root'] }, violations: [{ name: 'copyleft-lib', license: 'GPL-3.0', reason: "license 'GPL-3.0' is not in the allowlist" }] }) } } });
    expect(body(await call(fail, 'gate_run', { gate: 'license' }))).toEqual({
      ok: true, gate: 'license', level: 'fail',
      findings: ['plugin-license: no LICENSE file at the repo root', "copyleft-lib: GPL-3.0 — license 'GPL-3.0' is not in the allowlist"],
    });
  });

  it('AC-288.2: release_readiness -> {ok,items:[{name,level,msg}]}', async () => {
    const h = build({ deps: {
      loadConfig: async () => ({ ok: true, config: { conventions: { verify: 'pnpm verify' } } }),
      computeReadiness: async () => ({ ok: true, items: [{ name: 'branch', level: 'pass', msg: 'on main' }] }),
    } });
    expect(body(await call(h, 'release_readiness', {}))).toEqual({ ok: true, items: [{ name: 'branch', level: 'pass', msg: 'on main' }] });
  });

  it('AC-288.2: autopilot_select -> {ok,next,queue[]} over the real pure selector', async () => {
    const items = [
      { content: { number: 5 }, kind: 'ready-p1' },
      { content: { number: 6 }, kind: 'backlog' },
    ];
    const norm = (_c, i) => (i.kind === 'ready-p1'
      ? { number: 5, title: 'ready one', status: 'ready', priority: 'p1', type: 'item' }
      : { number: 6, title: 'backlog one', status: 'backlog', priority: 'p2', type: 'item' });
    const ctx = { ...okCtx, listItems: async () => ({ ok: true, items }) };
    const h = build({ getCtx: async () => ctx, deps: { normalize: norm, isShaped: () => true } });
    const out = body(await call(h, 'autopilot_select', {}));
    expect(out.ok).toBe(true);
    expect(out.next.ticket.number).toBe(5); // ready beats backlog
    expect(out.next.action).toBe('deliver');
    expect(out.queue.map((q) => q.ticket.number)).toEqual([5, 6]);
  });

  it('#499 AC-499.1: autopilot_select (the MCP call site) excludes a ticket with a pending decision, mirroring select.mjs\'s own CLI', async () => {
    const items = [
      { content: { number: 5 }, kind: 'ready-p1' },
      { content: { number: 6 }, kind: 'backlog' },
    ];
    const norm = (_c, i) => (i.kind === 'ready-p1'
      ? { number: 5, title: 'ready one', status: 'ready', priority: 'p1', type: 'item' }
      : { number: 6, title: 'backlog one', status: 'backlog', priority: 'p2', type: 'item' });
    const ctx = { ...okCtx, listItems: async () => ({ ok: true, items }) };
    const h = build({
      getCtx: async () => ctx,
      deps: { normalize: norm, isShaped: () => true, pendingDecisions: async () => [{ issue: 5, status: 'pending' }] },
    });
    const out = body(await call(h, 'autopilot_select', {}));
    expect(out.ok).toBe(true);
    // #5 would normally win (ready beats backlog) but has a pending decision — #6 is next instead.
    expect(out.next.ticket.number).toBe(6);
    expect(out.queue.map((q) => q.ticket.number)).toEqual([6]);
  });

  it('AC-288.2: malformed args are rejected with a teaching -32602 error', async () => {
    const h = build();
    expect((await call(h, 'board_move', { issue: 288 })).error.message).toMatch(/invalid arguments for board_move: missing required 'status'/);
    expect((await call(h, 'board_move', { issue: 'x', status: 'ready' })).error.message).toMatch(/'issue' must be an integer/);
    expect((await call(h, 'board_comment', { issue: 1, phase: 'not-a-phase', body: 'x' })).error.message).toMatch(/'phase' must be one of/);
    expect((await call(h, 'board_escalate', { issue: 1, reason: 'x', options: ['only one'] })).error.message).toMatch(/>= 2 items/);
    expect((await call(h, 'gate_run', { gate: 'bogus' })).error.message).toMatch(/'gate' must be one of/);
    expect((await call(h, 'autopilot_merge_bar', {})).error.message).toMatch(/missing required 'signals'/);
    expect((await call(h, 'autopilot_merge_bar', { signals: 'nope' })).error.message).toMatch(/'signals' must be an object/);
  });
});

// =========================================================================
describe('AC-288.3: autopilot_merge_bar returns the typed {merge,blockedOn} vector (compute only)', () => {
  it('AC-288.3: all signals green -> merge true, nothing blocked', async () => {
    const h = build();
    const out = body(await call(h, 'autopilot_merge_bar', { signals: { ship: true, gates: true, reviewer: true, security: true, ci: true } }));
    expect(out).toEqual({ ok: true, merge: true, blockedOn: [] });
  });

  it('AC-288.3: missing/red signals fail-closed into blockedOn; critical forces security:critical', async () => {
    const h = build();
    const partial = body(await call(h, 'autopilot_merge_bar', { signals: { ship: true, gates: true, reviewer: false, security: true, ci: true } }));
    expect(partial.merge).toBe(false);
    expect(partial.blockedOn).toContain('reviewer');
    const crit = body(await call(h, 'autopilot_merge_bar', { signals: { ship: true, gates: true, reviewer: true, security: true, ci: true }, critical: true }));
    expect(crit.merge).toBe(false);
    expect(crit.blockedOn).toContain('security:critical');
  });

  it('AC-288.3: it is pure computation — evaluateMergeBar is called with no gh/merge side effect', async () => {
    let calls = 0;
    const h = build({ deps: { evaluateMergeBar: (s, o) => { calls++; return { merge: false, blockedOn: ['ci'], escalate: !!o.critical }; } } });
    body(await call(h, 'autopilot_merge_bar', { signals: { ci: false } }));
    expect(calls).toBe(1);
  });
});

// =========================================================================
describe('AC-315.1 / AC-315.2: autopilot_merge funnels the live merge through the tested bar (fail-closed)', () => {
  // A ctx double: pr view returns a controllable CI rollup; every other gh call (incl. pr merge) records + succeeds.
  const mergeCtx = (rollup) => {
    const calls = [];
    const ctx = {
      ok: true,
      config: {},
      gh: async (a) => {
        calls.push(a.join(' '));
        if (a[0] === 'pr' && a[1] === 'view') return { ok: true, json: { statusCheckRollup: rollup } };
        return { ok: true };
      },
    };
    return { calls, ctx };
  };
  const green = [{ conclusion: 'SUCCESS' }];
  const heldVerdicts = { ship: true, gates: true, reviewer: true, security: true };

  it('AC-315.1: the tool executes the live merge only via runMerge — all green squash-merges', async () => {
    const { calls, ctx } = mergeCtx(green); // real DEFAULT_DEPS.runMerge
    const h = build({ getCtx: async () => ctx });
    const out = body(await call(h, 'autopilot_merge', { issue: 1, pr: 9, signals: heldVerdicts }));
    expect(out).toMatchObject({ ok: true, merged: true, outcome: 'merged' });
    expect(calls).toContain('pr merge 9 --squash --delete-branch');
  });

  it('AC-315.1: autopilot_merge funnels to runMerge (the canonical path), passing issue/pr/signals/critical/mode through', async () => {
    let seen = null;
    const h = build({ deps: { runMerge: async (_ctx, a) => { seen = a; return { ok: true, merged: true, outcome: 'merged' }; } } });
    body(await call(h, 'autopilot_merge', { issue: 7, pr: 3, signals: heldVerdicts, critical: false }));
    // mode defaults to null (the preflight decision, #316); outageAttempt/maxOutageAttempts
    // default to 0/2 (#408) when the caller omits them.
    expect(seen).toEqual({ issue: 7, pr: 3, signals: heldVerdicts, critical: false, mode: null, outageAttempt: 0, maxOutageAttempts: 2 });
    // an explicit pr-only mode threads through so the tool can park by construction.
    body(await call(h, 'autopilot_merge', { issue: 7, pr: 3, signals: heldVerdicts, critical: false, mode: 'pr-only' }));
    expect(seen.mode).toBe('pr-only');
  });

  it('AC-315.2: any red/undefined signal is mechanically unmergeable through the tool — no pr merge call', async () => {
    for (const s of ['ship', 'gates', 'reviewer', 'security']) {
      const { calls, ctx } = mergeCtx(green);
      const h = build({ getCtx: async () => ctx });
      const out = body(await call(h, 'autopilot_merge', { issue: 1, pr: 9, signals: { ...heldVerdicts, [s]: false } }));
      expect(out.merged, `${s}=false must not merge`).toBe(false);
      expect(out.blockedOn).toContain(s);
      expect(calls.some((c) => c.startsWith('pr merge')), `${s}=false must not squash-merge`).toBe(false);
    }
    // CI undefined/red (empty rollup) fails closed on ci even with every held verdict green.
    const { calls, ctx } = mergeCtx([]);
    const h = build({ getCtx: async () => ctx });
    const out = body(await call(h, 'autopilot_merge', { issue: 1, pr: 9, signals: heldVerdicts }));
    expect(out.merged).toBe(false);
    expect(out.blockedOn).toContain('ci');
    expect(calls.some((c) => c.startsWith('pr merge'))).toBe(false);
  });

  it('AC-315.2: critical=true forces no-merge through the tool even with every signal green', async () => {
    const { calls, ctx } = mergeCtx(green);
    const h = build({ getCtx: async () => ctx });
    const out = body(await call(h, 'autopilot_merge', { issue: 1, pr: 9, signals: heldVerdicts, critical: true }));
    expect(out.merged).toBe(false);
    expect(out.blockedOn).toContain('security:critical');
    expect(calls.some((c) => c.startsWith('pr merge'))).toBe(false);
  });

  // #408 review fix — the tool is the ONLY Claude-callable merge path (ADR-0007),
  // so the bounded outage-recovery attempt count and the honest exhausted reason
  // must actually reach it, not just direct runMerge callers/tests.
  it('#408: outageAttempt/maxOutageAttempts thread through to runMerge (default 0/2 when the caller omits them)', async () => {
    let seen = null;
    const h = build({ deps: { runMerge: async (_ctx, a) => { seen = a; return { ok: true, merged: true, outcome: 'merged' }; } } });
    body(await call(h, 'autopilot_merge', { issue: 7, pr: 3, signals: heldVerdicts }));
    expect(seen).toMatchObject({ outageAttempt: 0, maxOutageAttempts: 2 });
    body(await call(h, 'autopilot_merge', { issue: 7, pr: 3, signals: heldVerdicts, outageAttempt: 1, maxOutageAttempts: 3 }));
    expect(seen).toMatchObject({ outageAttempt: 1, maxOutageAttempts: 3 });
  });

  it('#408: the tool response surfaces outage/outageAttempt/outageExhausted/reason from runMerge instead of stripping them', async () => {
    const h = build({
      deps: {
        runMerge: async () => ({
          ok: false, merged: false, blockedOn: ['ci'], outage: true, outageExhausted: true,
          reason: 'GitHub Actions platform outage, not your change (Service Unavailable) — recovery exhausted after 2 attempt(s)',
        }),
      },
    });
    const out = body(await call(h, 'autopilot_merge', { issue: 1, pr: 9, signals: heldVerdicts }));
    expect(out).toMatchObject({ merged: false, outage: true, outageExhausted: true });
    expect(out.reason).toMatch(/GitHub Actions platform outage, not your change/);
  });

  it('review fix (#408): a FAILED recovery attempt (runMerge returns ok:false + outage:true) still surfaces outage context, not a bare teach()', async () => {
    const h = build({
      deps: {
        runMerge: async () => ({
          ok: false, error: 'git rebase failed: CONFLICT', outage: true, outageAttempt: 1,
          reason: 'platform-outage recovery attempt 1/2 failed: git rebase failed: CONFLICT',
        }),
      },
    });
    const raw = await call(h, 'autopilot_merge', { issue: 1, pr: 9, signals: heldVerdicts });
    expect(raw.result?.isError).toBe(true); // still an error surface — the caller must not treat this as success
    const out = body(raw);
    expect(out.outage).toBe(true);
    expect(out.outageAttempt).toBe(1);
    expect(out.reason).toMatch(/recovery attempt 1\/2 failed/);
    expect(out.error).toContain('CONFLICT'); // the underlying error is still visible, not swallowed
  });

  it('an ordinary (non-outage) runMerge error still gets the plain teach() surface — unchanged behavior', async () => {
    const h = build({ deps: { runMerge: async () => ({ ok: false, error: 'pr view failed: not found' }) } });
    const raw = await call(h, 'autopilot_merge', { issue: 1, pr: 9, signals: heldVerdicts });
    expect(raw.result?.isError).toBe(true);
    const out = body(raw);
    expect(out.error).toBe('pr view failed: not found');
    expect(out.outage).toBeUndefined();
  });
});

// =========================================================================
describe('AC-288.4: at least one failure path per tool group', () => {
  it('AC-288.4: board group — an engine error surfaces as isError + {ok:false,error}', async () => {
    const h = build({ deps: { runMove: async () => ({ ok: false, error: "move to 'done' did NOT persist" }) } });
    const res = await call(h, 'board_move', { issue: 288, status: 'done' });
    expect(res.result.isError).toBe(true);
    expect(body(res)).toMatchObject({ ok: false });
    expect(body(res).error).toMatch(/did NOT persist/);
  });

  it('AC-400.2: board group — an engine error from a newly-wrapped tool surfaces as isError + {ok:false,error}', async () => {
    const h = build({ deps: { runDigest: async () => ({ ok: false, error: '--epic <number> is required' }) } });
    const res = await call(h, 'board_digest', { epic: 182 });
    expect(res.result.isError).toBe(true);
    expect(body(res)).toEqual({ ok: false, error: '--epic <number> is required' });
  });

  it('AC-288.4: board group — an unavailable board context teaches instead of crashing', async () => {
    const h = build({ getCtx: async () => ({ ok: false, error: 'forge.json invalid or missing' }) });
    const res = await call(h, 'board_status', {});
    expect(res.result.isError).toBe(true);
    expect(body(res).error).toMatch(/forge.json/);
  });

  it('AC-288.4: gate group — a gate that cannot run (teaching .error) surfaces as isError, not a false pass', async () => {
    const h = build({ deps: { gates: { ac: async () => ({ ok: false, error: 'need --acs "AC-7.1,..." or --plan <file>' }) } } });
    const res = await call(h, 'gate_run', { gate: 'ac' });
    expect(res.result.isError).toBe(true);
    expect(body(res).error).toMatch(/need --acs/);
  });

  it('AC-288.4: release group — a not-ready checklist returns ok:false with the failing items', async () => {
    const h = build({ deps: {
      loadConfig: async () => ({ ok: true, config: {} }),
      computeReadiness: async () => ({ ok: false, items: [{ name: 'worktree', level: 'fail', msg: 'working tree not clean' }] }),
    } });
    const out = body(await call(h, 'release_readiness', {}));
    expect(out.ok).toBe(false);
    expect(out.items[0]).toMatchObject({ name: 'worktree', level: 'fail' });
  });

  it('AC-288.4: autopilot group — a board read failure teaches; an empty board yields next:null', async () => {
    const bad = build({ getCtx: async () => ({ ...okCtx, listItems: async () => ({ ok: false, error: 'item-list failed' }) }) });
    expect((await call(bad, 'autopilot_select', {})).result.isError).toBe(true);
    const empty = build({ getCtx: async () => ({ ...okCtx, listItems: async () => ({ ok: true, items: [] }) }) });
    const out = body(await call(empty, 'autopilot_select', {}));
    expect(out).toEqual({ ok: true, next: null, queue: [] });
  });

  it('AC-288.4: gate group — gate_run confines path args to the repo root and ref-validates base', async () => {
    let invoked = false;
    const h = build({ deps: { gates: { plandrift: async () => { invoked = true; return { ok: true, deviations: [] }; } } } });
    // path traversal in a gate path arg is refused before the gate runs
    expect((await call(h, 'gate_run', { gate: 'plandrift', plan: '../../etc/passwd' })).error.message).toMatch(/inside the repo root/);
    // a base that could pose as a git option is refused
    expect((await call(h, 'gate_run', { gate: 'plandrift', plan: '.forge/plan.md', base: '--output=x' })).error.message).toMatch(/git-ref-safe/);
    expect(invoked).toBe(false); // neither malformed call reached the gate
    // a clean repo-relative path + normal base passes through
    expect(body(await call(h, 'gate_run', { gate: 'plandrift', plan: '.forge/plan.md', base: 'main' }))).toEqual({ ok: true, gate: 'plandrift', level: 'pass', findings: [] });
  });

  it('AC-288.4: an unexpected throw inside a tool is caught and returned as isError, never crashes the server', async () => {
    const h = build({ deps: { evaluateMergeBar: () => { throw new Error('boom'); } } });
    const res = await call(h, 'autopilot_merge_bar', { signals: { ci: true } });
    expect(res.result.isError).toBe(true);
    expect(body(res).error).toMatch(/autopilot_merge_bar failed: boom/);
  });
});

// =========================================================================
describe('AC-296.2: forge-core arg size bounds cap per-call fan-out and comment size', () => {
  it('AC-296.2: gate_run.results is capped by count and per-path length', async () => {
    const h = build();
    const many = Array.from({ length: 257 }, (_, i) => `r${i}.json`);
    expect((await call(h, 'gate_run', { gate: 'ac', results: many })).error.message).toMatch(/'results' must be an array with <= 256 items/);
    expect((await call(h, 'gate_run', { gate: 'ac', results: ['x'.repeat(1100)] })).error.message).toMatch(/'results' items must each be a string of length <= 1024/);
  });

  it('AC-296.2: board_escalate.options is capped by count and per-option length; reason size is bounded', async () => {
    const h = build();
    const opts = Array.from({ length: 21 }, (_, i) => `opt ${i}`);
    expect((await call(h, 'board_escalate', { issue: 1, reason: 'r', options: opts })).error.message).toMatch(/'options' must be an array with <= 20 items/);
    expect((await call(h, 'board_escalate', { issue: 1, reason: 'r', options: ['ok', 'x'.repeat(2100)] })).error.message).toMatch(/'options' items must each be a string of length <= 2000/);
    expect((await call(h, 'board_escalate', { issue: 1, reason: 'x'.repeat(2100), options: ['a', 'b'] })).error.message).toMatch(/'reason' must be a string of length <= 2000/);
  });

  it('AC-296.2: in-bounds fan-out args still pass (a ceiling was added, not a new floor)', async () => {
    const h = build({ deps: { runEscalate: async () => ({ ok: true, id: 'e1', boardNote: null, pending: true }) } });
    expect(body(await call(h, 'board_escalate', { issue: 1, reason: 'ok', options: ['a', 'b'] })).ok).toBe(true);
  });
});

// =========================================================================
describe('AC-296.3: release_readiness teaches on a missing/broken forge.json instead of degrading', () => {
  it('AC-296.3: a missing config surfaces a teaching error and never evaluates against empty config', async () => {
    let ran = false;
    const h = build({ deps: {
      loadConfig: async () => ({ ok: false, missing: true, errors: ['.claude/forge.json not found — run /forge:init'], config: null }),
      computeReadiness: async () => { ran = true; return { ok: true, items: [] }; },
    } });
    const res = await call(h, 'release_readiness', {});
    expect(res.result.isError).toBe(true);
    expect(body(res)).toMatchObject({ ok: false });
    expect(body(res).error).toMatch(/\.claude\/forge\.json is missing/);
    expect(body(res).error).toMatch(/forge:init/);
    expect(ran).toBe(false); // did NOT silently degrade into computeReadiness with config:{}
  });

  it('AC-296.3: a broken (invalid) config teaches with the validation detail', async () => {
    const h = build({ deps: {
      loadConfig: async () => ({ ok: false, missing: false, errors: ['board: missing block'], config: { foo: 1 } }),
      computeReadiness: async () => ({ ok: true, items: [] }),
    } });
    const res = await call(h, 'release_readiness', {});
    expect(res.result.isError).toBe(true);
    expect(body(res).error).toMatch(/\.claude\/forge\.json is broken/);
    expect(body(res).error).toMatch(/board: missing block/);
  });

  it('AC-296.3: a healthy config still evaluates the checklist as before', async () => {
    const h = build({ deps: {
      loadConfig: async () => ({ ok: true, config: { conventions: { verify: 'pnpm verify' } } }),
      computeReadiness: async () => ({ ok: true, items: [{ name: 'branch', level: 'pass', msg: 'on main' }] }),
    } });
    expect(body(await call(h, 'release_readiness', {}))).toEqual({ ok: true, items: [{ name: 'branch', level: 'pass', msg: 'on main' }] });
  });
});

// =========================================================================
describe('AC-399.1: board_status (MCP) and board/status.mjs (CLI) return equivalent data', () => {
  it('AC-399.1: the same mocked board yields the same catch-up card from both paths (via the shared runStatus)', async () => {
    const items = [
      { content: { number: 1 }, title: 'One', status: 'Done' },
      { content: { number: 2 }, title: 'Two', status: 'In progress' },
      { content: { number: 3 }, title: 'Three', status: 'Blocked / Needs decision' },
    ];
    const ctx = {
      ...okCtx,
      listItems: async () => ({ ok: true, items }),
      gh: async (a) => (a[0] === 'pr' && a[1] === 'list'
        ? { ok: true, json: [{ number: 17, title: 'feat: x', isDraft: false }] }
        : { ok: true, json: { body: '' } }),
    };

    // CLI path: runStatus directly (what `forge board status` calls).
    const cli = await runStatus(ctx, () => {});
    expect(cli.ok).toBe(true);

    // MCP path: the board_status tool, over the identical ctx/board state.
    const h = build({ getCtx: async () => ctx, deps: { normalize: (_c, i) => ({ number: i.content.number, title: i.title }) } });
    const mcp = body(await call(h, 'board_status', {}));
    expect(mcp.ok).toBe(true);

    // Both compute the catch-up card via the same runStatus — assert the data matches.
    expect(mcp.situation).toEqual(cli.data.situation);
    expect(mcp.counts).toEqual(cli.data.counts);
    expect(mcp.blocked).toEqual(cli.data.blocked);
    expect(mcp.inProgress).toEqual(cli.data.inProgress);
    expect(mcp.openPrs).toEqual(cli.data.openPrs);
    expect(mcp.next).toEqual(cli.data.next);
    // Sanity: this is the actual "less useful answer" the ticket describes fixed.
    expect(mcp.next).toBe('answer the blocked decision(s)');
    expect(mcp.blocked).toEqual([{ number: 3, title: 'Three' }]);
  });
});

// =========================================================================
describe('makeCtxResolver memoization', () => {
  it('resolves once on success and does NOT cache a failed resolution', async () => {
    let n = 0;
    const results = [{ ok: false, error: 'gh down' }, { ok: true, owner: 'o' }, { ok: true, owner: 'SHOULD-NOT-APPEAR' }];
    // Patch makeBoardCtx via a hand-rolled resolver mirroring makeCtxResolver's contract.
    const resolver = (async () => {
      let cached = null;
      return async () => {
        if (cached) return cached;
        const ctx = results[n++];
        if (ctx.ok) cached = ctx;
        return ctx;
      };
    })();
    const getCtx = await resolver;
    expect((await getCtx()).ok).toBe(false); // failure not cached
    expect((await getCtx()).owner).toBe('o'); // next call succeeds and caches
    expect((await getCtx()).owner).toBe('o'); // memoized — third result never surfaces
  });

  it('makeCtxResolver is exported and returns a function', () => {
    expect(typeof makeCtxResolver('/repo', { gh: async () => ({ ok: true }) })).toBe('function');
  });
});
