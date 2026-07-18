/**
 * forge-control machine state (C1/#60; spec §2). Two file-backed registries
 * under the machine base dir:
 *   <base>/paused                 present = global kill switch engaged
 *   <base>/sessions/<id>.json     one per spawned/tracked session
 * Clearing paused is always a human file delete — never automated (spec §2).
 */
import { readFile, writeFile, readdir, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';

const PAUSED = 'paused';
const SESSIONS = 'sessions';

export async function isPaused(base) {
  try { await readFile(join(base, PAUSED), 'utf8'); return true; } catch { return false; }
}

export async function setPaused(base, { by = 'owner', reason = '' } = {}) {
  await mkdir(base, { recursive: true });
  await writeFile(join(base, PAUSED), JSON.stringify({ by, reason, at: new Date().toISOString() }), 'utf8');
  return { ok: true };
}

export async function clearPaused(base) {
  await rm(join(base, PAUSED), { force: true });
  return { ok: true };
}

export async function pausedInfo(base) {
  try { return { ok: true, info: JSON.parse(await readFile(join(base, PAUSED), 'utf8')) }; }
  catch { return { ok: true, info: null }; }
}

const sessFile = (base, id) => join(base, SESSIONS, `${id}.json`);

export async function registerSession(base, { id, ticket = null, repo, pid = null } = {}) {
  if (!id || !repo) return { ok: false, error: 'registerSession needs id and repo' };
  await mkdir(join(base, SESSIONS), { recursive: true });
  const now = new Date().toISOString();
  const rec = { id, ticket, repo, pid, state: 'alive', startedAt: now, lastHeartbeat: now };
  await writeFile(sessFile(base, id), JSON.stringify(rec), 'utf8');
  return { ok: true, session: rec };
}

export async function updateSession(base, id, patch = {}) {
  let rec;
  try { rec = JSON.parse(await readFile(sessFile(base, id), 'utf8')); }
  catch { return { ok: false, error: `no session '${id}'` }; }
  const next = { ...rec, ...patch, lastHeartbeat: patch.lastHeartbeat ?? new Date().toISOString() };
  await writeFile(sessFile(base, id), JSON.stringify(next), 'utf8');
  return { ok: true, session: next };
}

export function markSession(base, id, state) {
  return updateSession(base, id, { state });
}

export async function listSessions(base) {
  let files;
  try { files = await readdir(join(base, SESSIONS)); } catch { return { ok: true, sessions: [] }; }
  const out = [];
  for (const f of files.filter((f) => f.endsWith('.json'))) {
    try { out.push(JSON.parse(await readFile(join(base, SESSIONS, f), 'utf8'))); } catch { /* skip */ }
  }
  return { ok: true, sessions: out.sort((a, b) => (a.startedAt < b.startedAt ? -1 : 1)) };
}
