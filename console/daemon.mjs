#!/usr/bin/env node
/**
 * forge console daemon (spec §11; SP9a T4) — one per machine, outbound-only.
 *   register   create/extend ~/.forge/daemon.json (idempotent machineId)
 *   once       collect -> sanitize -> publish; consume inbox -> resolve decisions
 *   watch      `once` on an interval
 *   status     last-publish age per repo (file transport)
 *
 * 9a is read-only + decision replies. Command verbs are SP9b and will be an
 * allowlist enforced HERE, not in any UI (spec §11 guardrails).
 */
import { readFile, appendFile, mkdir } from 'node:fs/promises';
import { homedir, hostname } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomBytes } from 'node:crypto';
import { collectRepo } from './lib/collect.mjs';
import { sanitizeTelemetry, sanitizeEscalation } from './lib/sanitize.mjs';
import { makeTransport } from './lib/transport.mjs';
import { pendingDecisions } from '../plugin/scripts/lib/situation.mjs';
import { append as journalAppend } from '../plugin/scripts/lib/journal.mjs';
import { writeJson, readJson } from '../plugin/scripts/lib/jsonfile.mjs';

export const configPath = (home = homedir()) => join(home, '.forge', 'daemon.json');

export async function register(cwd, home = homedir()) {
  const path = configPath(home);
  const existing = await readJson(path).catch(() => null);
  const config = existing ?? {
    machineId: `${hostname().toLowerCase()}-${randomBytes(2).toString('hex')}`,
    repos: [],
    transport: { kind: 'file', dir: join(home, '.forge', 'console') },
    intervalSec: 60,
  };
  if (!config.repos.includes(cwd)) config.repos.push(cwd);
  await mkdir(join(home, '.forge'), { recursive: true });
  await writeJson(path, config);
  return { ok: true, config, created: existing === null };
}

/** Resolve one inbox reply into the owning repo's decision file (--check-compatible shape). */
export async function resolveReply(repos, reply, log = () => {}) {
  for (const cwd of repos) {
    const pending = await pendingDecisions(cwd);
    const d = pending.find((p) => p.id === reply.id);
    if (!d) continue;
    await writeJson(join(cwd, '.forge', 'decisions', `${d.id}.json`), {
      ...d, status: 'resolved', answer: reply.answer, resolvedBy: reply.by ?? 'console', resolvedAt: new Date().toISOString(),
    });
    await journalAppend(cwd, 'escalation-resolved', { issue: d.issue, id: d.id, answer: reply.answer, via: 'console' });
    log(`decision ${d.id} (#${d.issue}) resolved via console: ${reply.answer}`);
    return { ok: true, repo: cwd, issue: d.issue };
  }
  return { ok: false, error: `no pending decision '${reply.id}' in any watched repo` };
}

export async function runOnce(config, { transport = null, now = Date.now(), log = console.log } = {}) {
  const t = transport ?? makeTransport(config);
  const published = [];
  const refused = [];

  for (const cwd of config.repos) {
    const snapshot = { ...(await collectRepo(cwd, now)), machineId: config.machineId };
    const clean = sanitizeTelemetry(snapshot);
    if (!clean.ok) { refused.push({ repo: cwd, error: clean.error }); continue; }
    await t.publishTelemetry(clean.doc);
    published.push(clean.doc.repo);

    for (const d of snapshot.pendingDecisions) {
      const esc = sanitizeEscalation(d, config.machineId, clean.doc.repo);
      if (esc.ok) await t.publishEscalation(esc.doc);
    }
  }

  const replies = await t.listDecisionReplies();
  const resolved = [];
  for (const reply of replies) {
    const res = await resolveReply(config.repos, reply, log);
    if (res.ok) {
      await t.ackDecisionReply(reply.id);
      resolved.push(reply.id);
    }
  }

  log(`daemon: published ${published.length}/${config.repos.length} repo(s)${refused.length ? `, refused ${refused.length} (sanitizer)` : ''}${resolved.length ? `, resolved ${resolved.length} decision(s)` : ''}`);
  return { ok: true, published, refused, resolved };
}

export async function runStatus(config, log = console.log) {
  if (config.transport.kind !== 'file') {
    log('status reads the file transport outbox; firestore status arrives with the console app');
    return { ok: true, repos: [] };
  }
  const path = join(config.transport.dir, config.machineId, 'telemetry.jsonl');
  const raw = await readFile(path, 'utf8').catch(() => '');
  const last = new Map();
  for (const line of raw.split(/\r?\n/).filter(Boolean)) {
    try { const d = JSON.parse(line); last.set(d.repo, d.collectedAt); } catch { /* skip */ }
  }
  const repos = [...last].map(([repo, at]) => ({ repo, lastPublish: at, ageMin: Math.max(0, Math.round((Date.now() - Date.parse(at)) / 60_000)) }));
  for (const r of repos) log(`${r.repo.padEnd(24)} last publish ${r.ageMin} min ago`);
  if (repos.length === 0) log('no telemetry published yet — run: node console/daemon.mjs once');
  return { ok: true, repos };
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  const cmd = process.argv[2];
  const fail = (msg) => { console.error(msg); process.exit(1); };
  const loadCfg = async () => {
    const cfg = await readJson(configPath()).catch(() => null);
    if (!cfg) fail('no machine config — run: node console/daemon.mjs register');
    return cfg;
  };
  if (cmd === 'register') {
    register(process.cwd()).then((r) => console.log(`${r.created ? 'registered' : 'updated'} machine '${r.config.machineId}' — ${r.config.repos.length} repo(s), transport ${r.config.transport.kind}`));
  } else if (cmd === 'once') {
    loadCfg().then((cfg) => runOnce(cfg));
  } else if (cmd === 'watch') {
    loadCfg().then(async (cfg) => {
      console.log(`daemon watching ${cfg.repos.length} repo(s) every ${cfg.intervalSec}s — ctrl-c to stop`);
      // sequential interval: a slow cycle delays the next instead of overlapping it
      for (;;) {
        await runOnce(cfg).catch((e) => console.error(`cycle failed: ${e.message}`));
        await new Promise((r) => setTimeout(r, cfg.intervalSec * 1000));
      }
    });
  } else if (cmd === 'status') {
    loadCfg().then((cfg) => runStatus(cfg));
  } else if (cmd === 'serve') {
    const pi = process.argv.indexOf('--port');
    loadCfg().then(async (cfg) => {
      const { startServer, DEFAULT_PORT } = await import('./serve.mjs');
      const { port } = await startServer(cfg, { port: pi > -1 ? Number(process.argv[pi + 1]) : DEFAULT_PORT, log: console.log });
      console.log(`forge console → http://127.0.0.1:${port}  (${cfg.repos.length} repo(s), ctrl-c to stop)`);
    });
  } else {
    fail('usage: daemon.mjs <register|once|watch|status|serve [--port N]>');
  }
}
