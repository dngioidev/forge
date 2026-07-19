#!/usr/bin/env node
/**
 * forge-control CLI (C1/#60; spec §11 guardrail). The command surface is an
 * ALLOWLIST enforced HERE, in code — an unknown verb is refused at parse, not
 * hidden in a UI. The console control tab (C3) POSTs these same verbs. Every
 * accepted command is appended to an audit log, redacted. The control plane
 * never pushes, merges, or edits files — its whole vocabulary is below.
 *
 *   control.mjs enqueue --repo <path> [--ticket N] [--brief "..."]
 *   control.mjs list | status
 *   control.mjs dequeue --id <id>
 *   control.mjs pause [--reason "..."] | resume
 *   control.mjs kill --id <session> | kill-all
 */
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { redact } from '../plugin/scripts/lib/journal.mjs';
import * as queue from './lib/queue.mjs';
import * as machine from './lib/machine.mjs';

export const ALLOWED_VERBS = ['enqueue', 'dequeue', 'list', 'status', 'pause', 'resume', 'kill', 'kill-all'];

// FORGE_CONTROL_BASE overrides the base (relocate it; tests point it at a clean dir — #93).
// Kept independent of situation.mjs's controlBase() by design (no plugin↔control import).
export const defaultBase = (home = homedir()) => process.env.FORGE_CONTROL_BASE || join(home, '.forge', 'control');

export function parseArgs(argv) {
  const a = { verb: argv[0] ?? null, repo: null, ticket: null, brief: '', id: null, reason: '', by: 'owner' };
  for (let i = 1; i < argv.length; i++) {
    if (argv[i] === '--repo') a.repo = argv[++i];
    else if (argv[i] === '--ticket') a.ticket = Number(argv[++i]);
    else if (argv[i] === '--brief') a.brief = argv[++i];
    else if (argv[i] === '--id') a.id = argv[++i];
    else if (argv[i] === '--reason') a.reason = argv[++i];
    else if (argv[i] === '--by') a.by = argv[++i];
  }
  return a;
}

async function audit(base, verb, args) {
  await mkdir(base, { recursive: true });
  const rec = redact({ ts: new Date().toISOString(), verb, by: args.by, repo: args.repo, ticket: args.ticket, id: args.id });
  await appendFile(join(base, 'audit.jsonl'), JSON.stringify(rec) + '\n', 'utf8');
}

/**
 * The last `limit` audit records, newest-first (C3/#66). Records were already
 * redacted at write time, so this never re-exposes a secret. A missing or
 * partially-written file yields as many valid records as parse — never throws.
 */
export async function readAudit(base, { limit = 50 } = {}) {
  let raw;
  try { raw = await readFile(join(base, 'audit.jsonl'), 'utf8'); } catch { return { ok: true, audit: [] }; }
  const recs = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try { recs.push(JSON.parse(line)); } catch { /* skip half-written tail line */ }
  }
  return { ok: true, audit: recs.slice(-limit).reverse() };
}

/** Dispatch one verb. Returns {ok, ...}; unknown verbs are refused here. */
export async function runControl(base, args, log = console.log) {
  const { verb } = args;
  if (!ALLOWED_VERBS.includes(verb)) {
    return { ok: false, error: `unknown verb '${verb ?? ''}' — allowed: ${ALLOWED_VERBS.join(', ')}` };
  }
  await audit(base, verb, args);

  switch (verb) {
    case 'enqueue': {
      const r = await queue.enqueue(base, { repo: args.repo, ticket: args.ticket, brief: args.brief });
      if (r.ok) log(`enqueued ${r.entry.id} (${args.repo}${args.ticket ? ` #${args.ticket}` : ''})`);
      return r;
    }
    case 'dequeue': {
      if (!args.id) return { ok: false, error: 'dequeue needs --id' };
      const r = await queue.ack(base, args.id);
      if (r.ok) log(`dequeued ${args.id}`);
      return r;
    }
    case 'list': {
      const q = await queue.list(base);
      const s = await machine.listSessions(base);
      const paused = await machine.isPaused(base);
      for (const e of q.entries) log(`queue ${e.seq} ${e.id} ${e.state} ${e.repo}${e.ticket ? ` #${e.ticket}` : ''}`);
      for (const ss of s.sessions) log(`session ${ss.id} ${ss.state} ${ss.repo}${ss.ticket ? ` #${ss.ticket}` : ''}`);
      log(paused ? 'PAUSED (global kill switch engaged)' : 'running');
      return { ok: true, queue: q.entries, sessions: s.sessions, paused };
    }
    case 'status': {
      const q = await queue.list(base);
      const s = await machine.listSessions(base);
      const paused = await machine.isPaused(base);
      const pending = q.entries.filter((e) => e.state === 'pending').length;
      const alive = s.sessions.filter((x) => x.state === 'alive').length;
      log(`${paused ? '⏸ paused · ' : ''}${pending} queued · ${alive} session(s) alive`);
      return { ok: true, pending, alive, paused };
    }
    case 'pause': {
      await machine.setPaused(base, { by: args.by, reason: args.reason });
      log('⏸ PAUSED — the runner spawns nothing until resumed (human-only clear)');
      return { ok: true };
    }
    case 'resume': {
      await machine.clearPaused(base);
      log('▶ resumed');
      return { ok: true };
    }
    case 'kill': {
      if (!args.id) return { ok: false, error: 'kill needs --id <session>' };
      const r = await machine.markSession(base, args.id, 'killed');
      if (r.ok) log(`killed session ${args.id} (marked; PID termination lands with the C2 runner)`);
      return r;
    }
    case 'kill-all': {
      const s = await machine.listSessions(base);
      for (const ss of s.sessions.filter((x) => x.state === 'alive')) await machine.markSession(base, ss.id, 'killed');
      await machine.setPaused(base, { by: args.by, reason: 'kill-all' });
      log('🛑 kill-all — all sessions marked killed + paused engaged');
      return { ok: true, killed: s.sessions.filter((x) => x.state === 'alive').length };
    }
  }
  return { ok: false, error: 'unreachable' };
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  runControl(defaultBase(), parseArgs(process.argv.slice(2))).then((res) => {
    if (!res.ok) { console.error(`control: ${res.error}`); process.exit(1); }
  });
}
