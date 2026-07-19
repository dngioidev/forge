import { describe, it, expect } from 'vitest';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as queue from '../../control/lib/queue.mjs';
import * as machine from '../../control/lib/machine.mjs';
import { buildArgs, classify } from '../../control/lib/spawn.mjs';
import { runOnce, work } from '../../control/lib/runner.mjs';

const base = () => mkdtemp(join(tmpdir(), 'forge-run-'));

// A fake spawn: 'success' / 'api_error' resolve immediately; 'hang' resolves only
// when the supervisor calls kill() — that's how we exercise the timeout path.
function fakeSpawn(mode, sink = []) {
  return (opts) => {
    sink.push(opts);
    let resolveDone;
    const done = new Promise((res) => { resolveDone = res; });
    if (mode === 'success') resolveDone({ exitCode: 0, envelope: { subtype: 'success', is_error: false, session_id: opts.sessionId, result: 'ok', total_cost_usd: 0.017 } });
    else if (mode === 'api_error') resolveDone({ exitCode: 1, envelope: { subtype: 'success', is_error: true, api_error_status: 404, terminal_reason: 'api_error', session_id: opts.sessionId } });
    // 'hang' → never resolves until kill()
    return { sessionId: opts.sessionId, pid: 4242, kill: () => resolveDone({ exitCode: null, envelope: null }), done };
  };
}

let idSeq = 0;
const mintId = () => `sess-${++idSeq}`;

describe('repo path vs trail slug (AC-73.1, #73)', () => {
  it('AC-73.1: enqueue carries repoSlug; the spawner gets the path, the trail gets the slug', async () => {
    const b = await base();
    const e = await queue.enqueue(b, { repo: 'C:/mywp/forge', repoSlug: 'dngioidev/forge', ticket: 73, brief: 'x' });
    expect(e.entry).toMatchObject({ repo: 'C:/mywp/forge', repoSlug: 'dngioidev/forge' });

    const spawned = [];
    const trails = [];
    await runOnce(b, {
      spawn: fakeSpawn('success', spawned),
      trail: async (repo, ticket, body) => trails.push({ repo, ticket }),
      journal: async () => {}, mintId,
    });
    expect(spawned[0].repo).toBe('C:/mywp/forge');          // spawner uses the PATH
    expect(trails[0]).toMatchObject({ repo: 'dngioidev/forge', ticket: 73 }); // trail uses the SLUG
  });

  it('AC-73.1: no repoSlug → back-compat, the trail falls back to repo (path)', async () => {
    const b = await base();
    await queue.enqueue(b, { repo: 'C:/mywp/forge', ticket: 73, brief: 'x' });
    const trails = [];
    await runOnce(b, { spawn: fakeSpawn('success'), trail: async (repo) => trails.push(repo), journal: async () => {}, mintId });
    expect(trails[0]).toBe('C:/mywp/forge'); // unchanged behavior (defaultTrail would then skip a non-slug)
  });
});

describe('spawn shape + classify (AC-C2.3, AC-C2.4)', () => {
  it('buildArgs is the verified headless flag string; resume swaps the id flag', () => {
    expect(buildArgs({ brief: 'do X', sessionId: 'u1', repo: '/r', model: 'm', permissionMode: 'plan' }))
      .toEqual(['-p', 'do X', '--output-format', 'json', '--model', 'm', '--permission-mode', 'plan', '--session-id', 'u1', '--add-dir', '/r']);
    expect(buildArgs({ brief: 'again', sessionId: 'u1', resume: true })).toContain('-r');
    expect(buildArgs({ brief: 'again', sessionId: 'u1', resume: true })).not.toContain('--session-id');
  });

  it('classify: success / api_error / killed / error from exit + envelope', () => {
    expect(classify({ exitCode: 0, envelope: { subtype: 'success', is_error: false } })).toBe('success');
    expect(classify({ exitCode: 1, envelope: { is_error: true, terminal_reason: 'api_error' } })).toBe('api_error');
    expect(classify({ exitCode: null, envelope: null, killedReason: 'timeout' })).toBe('timeout'); // supervisor kill wins
    expect(classify({ exitCode: 1, envelope: null })).toBe('error');
  });
});

describe('runOnce (AC-C2.1)', () => {
  it('paused → no spawn (respects the C1 kill switch)', async () => {
    const b = await base();
    await queue.enqueue(b, { repo: 'dngioidev/forge', ticket: 62, brief: 'x' });
    await machine.setPaused(b, { by: 'owner', reason: 'test' });
    const spawned = [];
    const r = await runOnce(b, { spawn: fakeSpawn('success', spawned), trail: async () => {}, journal: async () => {}, mintId });
    expect(r.skipped).toBe('paused');
    expect(spawned).toHaveLength(0);
    expect((await queue.list(b)).entries).toHaveLength(1); // entry untouched
  });

  it('empty queue → skipped empty', async () => {
    const b = await base();
    const r = await runOnce(b, { spawn: fakeSpawn('success'), trail: async () => {}, journal: async () => {}, mintId });
    expect(r.skipped).toBe('empty');
  });

  it('success: registers a session, acks the entry, session ends dead, outcome trailed', async () => {
    const b = await base();
    await queue.enqueue(b, { repo: 'dngioidev/forge', ticket: 62, brief: 'ship it' });
    const trails = [];
    const r = await runOnce(b, { spawn: fakeSpawn('success'), trail: async (repo, ticket, body) => trails.push({ repo, ticket, body }), journal: async () => {}, mintId });
    expect(r.outcome).toBe('success');
    expect((await queue.list(b)).entries).toHaveLength(0); // acked
    const sessions = (await machine.listSessions(b)).sessions;
    expect(sessions[0]).toMatchObject({ state: 'dead', ticket: 62, pid: 4242 });
    expect(trails[0]).toMatchObject({ repo: 'dngioidev/forge', ticket: 62 });
    expect(trails[0].body).toContain('success');
  });

  it('api_error: entry still acked, session dead, outcome classified', async () => {
    const b = await base();
    await queue.enqueue(b, { repo: 'dngioidev/forge', ticket: 62, brief: 'boom' });
    const r = await runOnce(b, { spawn: fakeSpawn('api_error'), trail: async () => {}, journal: async () => {}, mintId });
    expect(r.outcome).toBe('api_error');
    expect((await machine.listSessions(b)).sessions[0].state).toBe('dead');
  });
});

describe('supervisor timeout (AC-C2.2)', () => {
  it('a hung session is killed by timeout, marked killed, journaled AND trailed', async () => {
    const b = await base();
    await queue.enqueue(b, { repo: 'dngioidev/forge', ticket: 62, brief: 'hang forever' });
    const journal = [];
    const trails = [];
    const r = await runOnce(b, {
      spawn: fakeSpawn('hang'),
      timeoutMs: 20,
      heartbeatMs: 5,
      trail: async (repo, ticket, body) => trails.push(body),
      journal: async (_b, rec) => journal.push(rec),
      mintId,
    });
    expect(r.outcome).toBe('timeout');
    expect(r.killedReason).toBe('timeout');
    expect((await machine.listSessions(b)).sessions[0].state).toBe('killed');
    // journaled: nothing dies silently
    expect(journal.find((e) => e.event === 'session-end' && e.killedReason === 'timeout')).toBeTruthy();
    // trailed the kill
    expect(trails.some((t) => /killed/i.test(t) && /timeout/i.test(t))).toBe(true);
  });
});

describe('work loop', () => {
  it('drains all pending entries then stops on empty; paused stops immediately', async () => {
    const b = await base();
    await queue.enqueue(b, { repo: 'dngioidev/forge', ticket: 1, brief: 'a' });
    await queue.enqueue(b, { repo: 'dngioidev/forge', ticket: 2, brief: 'b' });
    const results = await work(b, { spawn: fakeSpawn('success'), trail: async () => {}, journal: async () => {}, mintId });
    // two runs + a final 'empty'
    expect(results.filter((r) => r.outcome === 'success')).toHaveLength(2);
    expect(results[results.length - 1].skipped).toBe('empty');
    expect((await queue.list(b)).entries).toHaveLength(0);
  });

  it('control runner journal defaults land in <base>/runner.jsonl', async () => {
    const b = await base();
    await queue.enqueue(b, { repo: 'dngioidev/forge', ticket: 62, brief: 'x' });
    await runOnce(b, { spawn: fakeSpawn('success'), trail: async () => {}, mintId }); // default journal
    const log = (await readFile(join(b, 'runner.jsonl'), 'utf8')).trim().split('\n').map((l) => JSON.parse(l));
    expect(log.map((e) => e.event)).toContain('session-start');
    expect(log.map((e) => e.event)).toContain('session-end');
  });
});
