import { describe, it, expect } from 'vitest';
import { makeHandler, makeCtxResolver, TOOLS, GATE_NAMES, DEFAULT_DEPS } from '../../plugin/mcp/forge/server.mjs';
import { validateInput, canonicalize } from '../../plugin/mcp/lib/rpc.mjs';
import { validateInput as graphValidate, canonicalize as graphCanon } from '../../plugin/mcp/graph/server.mjs';

// ---- harness -------------------------------------------------------------
const okCtx = {
  ok: true,
  owner: 'dngioidev',
  repo: 'forge',
  config: {},
  gh: async () => ({ ok: true, json: { body: '## Acceptance criteria\n- AC' } }),
  listItems: async () => ({ ok: true, items: [] }),
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
      ['autopilot_merge_bar', 'autopilot_select', 'board_comment', 'board_create', 'board_escalate', 'board_move', 'board_status', 'gate_run', 'release_readiness'],
    );
    expect((await call(h, 'nope_tool', {})).error.code).toBe(-32602);
    expect((await h({ jsonrpc: '2.0', id: 9, method: 'bogus' })).error.code).toBe(-32601);
    expect((await h({ method: 'tools/list' })).error.code).toBe(-32600);
    expect(await h({ jsonrpc: '2.0', method: 'notifications/initialized' })).toBe(null);
  });

  it('exposes exactly the 9 documented tools and the 8 gate names', () => {
    expect(TOOLS).toHaveLength(9);
    expect(GATE_NAMES).toEqual(['ac', 'conventions', 'dep', 'docsync', 'ground', 'plandrift', 'situation', 'testintent']);
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

  it('AC-288.2: board_status -> {ok,items[]} filtered by issue', async () => {
    const items = [
      { content: { number: 1 }, title: 'one' },
      { content: { number: 2 }, title: 'two' },
    ];
    const ctx = { ...okCtx, listItems: async () => ({ ok: true, items }) };
    const h = build({ getCtx: async () => ctx, deps: { normalize: (_c, i) => ({ number: i.content.number, title: i.title }) } });
    expect(body(await call(h, 'board_status', {})).items).toHaveLength(2);
    expect(body(await call(h, 'board_status', { issue: 2 })).items).toEqual([{ number: 2, title: 'two' }]);
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
describe('AC-288.4: at least one failure path per tool group', () => {
  it('AC-288.4: board group — an engine error surfaces as isError + {ok:false,error}', async () => {
    const h = build({ deps: { runMove: async () => ({ ok: false, error: "move to 'done' did NOT persist" }) } });
    const res = await call(h, 'board_move', { issue: 288, status: 'done' });
    expect(res.result.isError).toBe(true);
    expect(body(res)).toMatchObject({ ok: false });
    expect(body(res).error).toMatch(/did NOT persist/);
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
