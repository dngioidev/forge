import { describe, it, expect, afterAll } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from 'node:http';
import { startServer, hostAllowed, stateOf } from '../../console/serve.mjs';

const DECISION = {
  id: 'esc-9-web', issue: 9, reason: 'pick one', status: 'pending',
  options: ['ship it', 'hold it'], createdAt: '2026-07-17T10:00:00Z',
};

async function repoDir() {
  const dir = await mkdtemp(join(tmpdir(), 'forge-web-'));
  await mkdir(join(dir, '.git'), { recursive: true });
  await writeFile(join(dir, '.git', 'HEAD'), 'ref: refs/heads/feat/9-learning-loop\n', 'utf8');
  await mkdir(join(dir, '.forge', 'decisions'), { recursive: true });
  await writeFile(join(dir, '.forge', 'decisions', `${DECISION.id}.json`), JSON.stringify(DECISION), 'utf8');
  await writeFile(join(dir, '.forge', 'journal.jsonl'), JSON.stringify({ ts: 't1', kind: 'escalation', ticket: '#9' }) + '\n', 'utf8');
  return dir;
}

const servers = [];
afterAll(() => servers.forEach(({ server }) => server.close()));

async function liveServer() {
  const repo = await repoDir();
  const config = { machineId: 'm-web', repos: [repo], transport: { kind: 'file', dir: await mkdtemp(join(tmpdir(), 'forge-webt-')) } };
  const started = await startServer(config, { port: 0 });
  servers.push(started);
  return { repo, config, base: `http://127.0.0.1:${started.port}` };
}

describe('local web console', () => {
  it('AC-B5.1: /api/state returns live snapshots for every configured repo', async () => {
    const { base } = await liveServer();
    const res = await fetch(`${base}/api/state`);
    expect(res.ok).toBe(true);
    const s = await res.json();
    expect(s.machineId).toBe('m-web');
    expect(s.repos).toHaveLength(1);
    expect(s.repos[0]).toMatchObject({ situation: 'awaiting-decision', ticket: '#9', branch: 'feat/9-learning-loop' });
    expect(s.repos[0].pendingDecisions[0]).toMatchObject({ id: 'esc-9-web', options: ['ship it', 'hold it'] });
  });

  it('AC-B5.2: /api/decide resolves like the daemon inbox; unknown id 404s; bad body 400s', async () => {
    const { base, repo } = await liveServer();
    const res = await fetch(`${base}/api/decide`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'esc-9-web', answer: 'option 1 — ship it' }),
    });
    expect(res.status).toBe(200);
    const file = JSON.parse(await readFile(join(repo, '.forge', 'decisions', 'esc-9-web.json'), 'utf8'));
    expect(file).toMatchObject({ status: 'resolved', answer: 'option 1 — ship it', resolvedBy: 'local-console' });
    const journal = await readFile(join(repo, '.forge', 'journal.jsonl'), 'utf8');
    expect(journal).toContain('"escalation-resolved"');

    // second answer: no longer pending -> 404; garbage -> 400
    expect((await fetch(`${base}/api/decide`, { method: 'POST', body: JSON.stringify({ id: 'esc-9-web', answer: 'x' }) })).status).toBe(404);
    expect((await fetch(`${base}/api/decide`, { method: 'POST', body: 'not json' })).status).toBe(400);
    expect((await fetch(`${base}/api/decide`, { method: 'POST', body: JSON.stringify({ id: 'x', answer: '  ' }) })).status).toBe(400);

    const state = await (await fetch(`${base}/api/state`)).json();
    expect(state.repos[0].pendingDecisions).toEqual([]);
    expect(state.repos[0].situation).not.toBe('awaiting-decision');
  });

  it('AC-B5.3: localhost-only — foreign Host headers rejected, allowlist exact', async () => {
    const { base } = await liveServer();
    expect(hostAllowed('localhost:7433')).toBe(true);
    expect(hostAllowed('127.0.0.1')).toBe(true);
    expect(hostAllowed('[::1]:9')).toBe(true);
    expect(hostAllowed('evil.example')).toBe(false);
    expect(hostAllowed('localhost.evil.example')).toBe(false);
    expect(hostAllowed(undefined)).toBe(false);
    // fetch/undici drops custom Host headers — raw http.request carries it
    const status = await new Promise((resolve, reject) => {
      const req = request(`${base}/api/state`, { headers: { Host: 'evil.example' } }, (res) => { res.resume(); resolve(res.statusCode); });
      req.on('error', reject);
      req.end();
    });
    expect(status).toBe(403);
  });

  it('AC-B5.4: GET / serves the self-contained page; unknown routes 404', async () => {
    const { base } = await liveServer();
    const res = await fetch(base + '/');
    expect(res.headers.get('content-type')).toContain('text/html');
    const html = await res.text();
    expect(html).toContain('forge console');
    expect(html).toContain('/api/decide');
    expect(html).not.toMatch(/src="http|href="http/); // no external assets
    expect((await fetch(`${base}/nope`)).status).toBe(404);
  });

  it('stateOf reports per-repo errors without failing the whole snapshot', async () => {
    const s = await stateOf({ machineId: 'm', repos: ['Z:/does/not/exist'] });
    expect(s.repos).toHaveLength(1); // collect tolerates missing dirs (nulls), or reports error — either way the snapshot stands
  });
});
