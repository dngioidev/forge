import { describe, it, expect, afterAll } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from 'node:http';
import { startServer, controlStateOf, controlArgsFromBody } from '../../console/serve.mjs';
import { readAudit, runControl, parseArgs } from '../../control/control.mjs';
import * as queue from '../../control/lib/queue.mjs';
import * as machine from '../../control/lib/machine.mjs';
import { controlPanel, CONTROL_DESTRUCTIVE, CONTROL_VERBS } from '../../console/web/app.js';

const noop = () => {};
const servers = [];
afterAll(() => servers.forEach(({ server }) => server.close()));

// A control base seeded with one queued entry, one alive session, and one audit record.
async function seededBase() {
  const base = await mkdtemp(join(tmpdir(), 'forge-ctltab-'));
  await queue.enqueue(base, { repo: 'dngioidev/forge', ticket: 66, brief: 'do the thing' });
  await machine.registerSession(base, { id: 's-alpha', ticket: 66, repo: 'dngioidev/forge', pid: 999 });
  await runControl(base, parseArgs(['enqueue', '--repo', 'dngioidev/forge', '--ticket', '66']), noop); // writes an audit record
  return base;
}

async function liveServer(controlBase) {
  const config = { machineId: 'm-ctl', repos: [], controlBase };
  const started = await startServer(config, { port: 0 });
  servers.push(started);
  return `http://127.0.0.1:${started.port}`;
}

describe('control tab endpoints (AC-C3.1, AC-C3.2)', () => {
  it('AC-C3.1: GET /api/control/state returns queue + sessions + paused + audit; Host guard 403', async () => {
    const base = await seededBase();
    const url = await liveServer(base);
    const s = await (await fetch(`${url}/api/control/state`)).json();
    expect(s.paused).toBe(false);
    expect(s.queue.length).toBeGreaterThanOrEqual(1);
    expect(s.sessions[0]).toMatchObject({ id: 's-alpha', state: 'alive', pid: 999 });
    expect(s.audit[0]).toMatchObject({ verb: 'enqueue', repo: 'dngioidev/forge', ticket: 66 });

    // foreign Host header → 403 (same rebinding guard as the rest of the console)
    const status = await new Promise((resolve, reject) => {
      const req = request(`${url}/api/control/state`, { headers: { Host: 'evil.example' } }, (res) => { res.resume(); resolve(res.statusCode); });
      req.on('error', reject); req.end();
    });
    expect(status).toBe(403);
  });

  it('AC-C3.2: POST /api/control runs an allowlisted verb; unknown verb 400 naming the set; never 500', async () => {
    const base = await seededBase();
    const url = await liveServer(base);
    // pause engages the kill switch and the next state reflects it
    const pause = await fetch(`${url}/api/control`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ verb: 'pause', reason: 'from console' }) });
    expect(pause.status).toBe(200);
    expect((await (await fetch(`${url}/api/control/state`)).json()).paused).toBe(true);
    // resume clears it
    await fetch(`${url}/api/control`, { method: 'POST', body: JSON.stringify({ verb: 'resume' }) });
    expect((await (await fetch(`${url}/api/control/state`)).json()).paused).toBe(false);
    // an unknown/forbidden verb is a 400 naming the allowed set — NOT a 500
    const bad = await fetch(`${url}/api/control`, { method: 'POST', body: JSON.stringify({ verb: 'push' }) });
    expect(bad.status).toBe(400);
    const body = await bad.json();
    expect(body.error).toMatch(/unknown verb 'push'/);
    expect(body.error).toContain('enqueue, dequeue, list, status, pause, resume, kill, kill-all');
    // malformed json → 400
    expect((await fetch(`${url}/api/control`, { method: 'POST', body: 'not json' })).status).toBe(400);
  });

  it('controlArgsFromBody defaults the actor to local-console and coerces ticket', () => {
    expect(controlArgsFromBody({ verb: 'enqueue', repo: 'r', ticket: '66' })).toMatchObject({ verb: 'enqueue', repo: 'r', ticket: 66, by: 'local-console' });
  });
});

describe('readAudit (AC-C3.3)', () => {
  it('AC-C3.3: newest-first, tolerates missing + partial files, no thrown error', async () => {
    // missing file → empty, ok
    const empty = await mkdtemp(join(tmpdir(), 'forge-aud-'));
    expect(await readAudit(empty)).toEqual({ ok: true, audit: [] });

    const base = await mkdtemp(join(tmpdir(), 'forge-aud-'));
    const lines = [
      JSON.stringify({ ts: 't1', verb: 'enqueue' }),
      JSON.stringify({ ts: 't2', verb: 'pause' }),
      '{ this is a half-written tail line', // must be skipped, not throw
    ].join('\n') + '\n';
    await writeFile(join(base, 'audit.jsonl'), lines, 'utf8');
    const r = await readAudit(base, { limit: 10 });
    expect(r.ok).toBe(true);
    expect(r.audit.map((a) => a.verb)).toEqual(['pause', 'enqueue']); // newest-first, bad line dropped
    // limit keeps only the newest N
    expect((await readAudit(base, { limit: 1 })).audit).toHaveLength(1);
    await rm(base, { recursive: true, force: true });
  });
});

describe('controlPanel render (AC-C3.4)', () => {
  it('AC-C3.4: renders queue/sessions/audit and marks kill-all destructive for the two-step confirm', () => {
    const html = controlPanel({
      paused: false,
      queue: [{ seq: 1, id: 'q-1', state: 'pending', repo: 'dngioidev/forge', ticket: 66 }],
      sessions: [{ id: 's-alpha', state: 'alive', repo: 'dngioidev/forge', ticket: 66, pid: 999, lastHeartbeat: new Date().toISOString() }],
      audit: [{ ts: new Date().toISOString(), verb: 'enqueue', repo: 'dngioidev/forge', ticket: 66, by: 'local-console' }],
    });
    expect(html).toContain('queue');
    expect(html).toContain('sessions');
    expect(html).toContain('audit');
    expect(html).toContain('s-alpha');
    // kill-all is the destructive verb → carries the marker the wiring uses to require confirm
    expect(CONTROL_DESTRUCTIVE).toContain('kill-all');
    expect(CONTROL_VERBS).toEqual(expect.arrayContaining(['pause', 'resume', 'kill-all']));
    expect(html).toMatch(/data-verb="kill-all" data-destructive="1"/);
    expect(html).toMatch(/data-verb="pause"(?! data-destructive)/); // pause is not destructive

    // paused state shows the banner
    expect(controlPanel({ paused: true, queue: [], sessions: [], audit: [] })).toContain('PAUSED');
  });
});
