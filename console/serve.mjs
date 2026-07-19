/**
 * Local web console (#37) — the rung between terminal views and SP9b:
 * monitor every configured repo and answer escalations from a browser,
 * zero cloud, zero dependencies. State is collected LIVE per request
 * (fresher than the outbox files); a decision answered here resolves the
 * same file the daemon inbox writes, so the halted pipeline can't tell
 * the difference.
 *
 * Hardening: binds 127.0.0.1 only; the Host-header allowlist is the
 * DNS-rebinding guard (a malicious site can make the browser send the
 * request, but not with a localhost Host header).
 */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectRepo } from './lib/collect.mjs';
import { resolveReply } from './daemon.mjs';
import { runControl, readAudit, parseArgs as parseControlArgs, defaultBase as controlDefaultBase } from '../control/control.mjs';
import * as controlQueue from '../control/lib/queue.mjs';
import * as controlMachine from '../control/lib/machine.mjs';
import { read as readRepoJournal } from '../plugin/scripts/lib/journal.mjs';
import { deriveAlerts } from './lib/alerts.mjs';
import { notify } from './lib/toast.mjs';

/** Light per-repo journal tails for the alert watcher — tolerant of unreadable repos. */
async function repoJournals(repos = []) {
  const out = [];
  for (const cwd of repos) {
    try {
      const j = await readRepoJournal(cwd);
      out.push({ repo: cwd.split(/[\\/]/).filter(Boolean).pop() ?? cwd, journalTail: (j.events ?? []).slice(-25) });
    } catch { out.push({ repo: cwd, journalTail: [] }); }
  }
  return out;
}

const WEB_ROOT = join(dirname(fileURLToPath(import.meta.url)), 'web');
export const DEFAULT_PORT = 7433;

export function hostAllowed(host) {
  return /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(host ?? '');
}

export async function stateOf(config) {
  const repos = [];
  for (const cwd of config.repos) {
    try {
      repos.push(await collectRepo(cwd));
    } catch (e) {
      repos.push({ repo: cwd, error: e.message });
    }
  }
  return { machineId: config.machineId, generatedAt: new Date().toISOString(), repos };
}

/** Read-only forge-control snapshot for the console control tab (C3). */
export async function controlStateOf(base) {
  const [q, s, paused, a] = await Promise.all([
    controlQueue.list(base),
    controlMachine.listSessions(base),
    controlMachine.isPaused(base),
    readAudit(base, { limit: 50 }),
  ]);
  return { base, paused, queue: q.entries, sessions: s.sessions, audit: a.audit };
}

/** Shape a JSON control request into the args object runControl expects. */
export function controlArgsFromBody(body) {
  return {
    verb: body?.verb ?? null,
    repo: body?.repo ?? null,
    ticket: body?.ticket != null ? Number(body.ticket) : null,
    brief: body?.brief ?? '',
    id: body?.id ?? null,
    reason: body?.reason ?? '',
    by: body?.by ?? 'local-console',
  };
}

export function makeApp(config, log = () => {}) {
  const controlBase = config.controlBase ?? controlDefaultBase();
  // Toast dedup: fire an OS toast at most once per alert id (in-memory across polls).
  const toastedIds = new Set();
  const fireNewToasts = (alerts) => {
    if (!config.toastEnabled) return;
    for (const a of alerts) {
      if (toastedIds.has(a.id)) continue;
      toastedIds.add(a.id);
      notify('forge alert', a.message, { enabled: true, spawnFn: config.toastSpawn, platform: config.toastPlatform });
    }
  };
  return async function handle(req, res) {
    const send = (code, body, type = 'application/json') => {
      res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' });
      res.end(type === 'application/json' ? JSON.stringify(body) : body);
    };
    try {
      if (!hostAllowed(req.headers.host)) return send(403, { error: 'localhost only' });
      const path = new URL(req.url, 'http://localhost').pathname;

      if (req.method === 'GET' && path === '/') {
        return send(200, await readFile(join(WEB_ROOT, 'index.html'), 'utf8'), 'text/html; charset=utf-8');
      }
      if (req.method === 'GET' && path === '/app.js') {
        return send(200, await readFile(join(WEB_ROOT, 'app.js'), 'utf8'), 'text/javascript; charset=utf-8');
      }
      if (req.method === 'GET' && path === '/api/state') {
        return send(200, await stateOf(config));
      }
      if (req.method === 'GET' && path === '/api/control/state') {
        const cs = await controlStateOf(controlBase);
        const alerts = deriveAlerts({ repos: await repoJournals(config.repos ?? []), sessions: cs.sessions, now: Date.now() });
        fireNewToasts(alerts);
        return send(200, { ...cs, alerts });
      }
      if (req.method === 'POST' && path === '/api/control') {
        let raw = '';
        for await (const chunk of req) raw += chunk;
        let body;
        try { body = JSON.parse(raw); } catch { return send(400, { error: 'invalid json' }); }
        const args = controlArgsFromBody(body);
        const r = await runControl(controlBase, args, log);
        // an unknown/forbidden verb is a client error (400), not a server fault (500)
        if (!r.ok && /unknown verb/.test(r.error ?? '')) return send(400, r);
        return send(r.ok ? 200 : 400, r);
      }
      if (req.method === 'POST' && path === '/api/decide') {
        let raw = '';
        for await (const chunk of req) raw += chunk;
        let body;
        try { body = JSON.parse(raw); } catch { return send(400, { error: 'invalid json' }); }
        if (typeof body?.id !== 'string' || typeof body?.answer !== 'string' || !body.answer.trim()) {
          return send(400, { error: 'need { id, answer }' });
        }
        const r = await resolveReply(config.repos, { id: body.id, answer: body.answer.trim(), by: body.by ?? 'local-console' }, log);
        return send(r.ok ? 200 : 404, r);
      }
      return send(404, { error: 'not found' });
    } catch (e) {
      return send(500, { error: e.message });
    }
  };
}

export function startServer(config, { port = DEFAULT_PORT, log = () => {} } = {}) {
  const server = createServer(makeApp(config, log));
  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(port, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}
