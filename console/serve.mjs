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

export function makeApp(config, log = () => {}) {
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
      if (req.method === 'GET' && path === '/api/state') {
        return send(200, await stateOf(config));
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
