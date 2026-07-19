/**
 * forge-control work queue (C1/#60; spec §2). File-backed, ordered by an
 * increasing sequence so FIFO survives restarts and needs no daemon memory.
 * Layout under the machine base dir:
 *   <base>/queue/<seq>-<id>.json        pending or held entries
 *   <base>/queue-done/<seq>-<id>.json   acked (kept as history)
 * No spawning here — this is the ledger the runner (C2) reads.
 */
import { readFile, writeFile, readdir, mkdir, rename } from 'node:fs/promises';
import { join } from 'node:path';

const Q = 'queue';
const DONE = 'queue-done';
const pad = (n) => String(n).padStart(6, '0');

async function entries(base) {
  const dir = join(base, Q);
  let files;
  try { files = await readdir(dir); } catch { return []; }
  const out = [];
  for (const f of files.filter((f) => f.endsWith('.json'))) {
    try { out.push(JSON.parse(await readFile(join(dir, f), 'utf8'))); } catch { /* skip half-write */ }
  }
  return out.sort((a, b) => a.seq - b.seq);
}

async function nextSeq(base) {
  const es = await entries(base);
  const done = await (async () => { try { return (await readdir(join(base, DONE))).length; } catch { return 0; } })();
  const maxLive = es.reduce((m, e) => Math.max(m, e.seq), 0);
  return Math.max(maxLive, done) + 1;
}

function fileFor(seq, id) { return `${pad(seq)}-${id}.json`; }

export async function enqueue(base, { id, ticket = null, repo, repoSlug = null, brief = '', at } = {}) {
  if (!repo) return { ok: false, error: 'enqueue needs a repo' };
  const dir = join(base, Q);
  await mkdir(dir, { recursive: true });
  const seq = await nextSeq(base);
  // `repo` is the filesystem path the runner spawns in (--add-dir); `repoSlug` is the
  // owner/name used to trail the ticket on GitHub (#73). They differ — a path can't be
  // a slug — so the trail no-ops on a path-only entry. repoSlug is optional/back-compat.
  const rec = { id: id ?? `q-${seq}`, seq, ticket, repo, repoSlug, brief, state: 'pending', enqueuedAt: at ?? new Date().toISOString() };
  await writeFile(join(dir, fileFor(seq, rec.id)), JSON.stringify(rec), 'utf8');
  return { ok: true, entry: rec };
}

export async function list(base) {
  return { ok: true, entries: await entries(base) };
}

/** The next runnable entry: lowest-seq pending (held entries are skipped). */
export async function next(base) {
  const e = (await entries(base)).find((x) => x.state === 'pending');
  return { ok: true, entry: e ?? null };
}

async function mutate(base, id, fn) {
  const es = await entries(base);
  const e = es.find((x) => x.id === id);
  if (!e) return { ok: false, error: `no queue entry '${id}'` };
  fn(e);
  await writeFile(join(base, Q, fileFor(e.seq, e.id)), JSON.stringify(e), 'utf8');
  return { ok: true, entry: e };
}

export function hold(base, id, reason) {
  return mutate(base, id, (e) => { e.state = 'held'; e.holdReason = reason ?? 'held'; });
}

export function release(base, id) {
  return mutate(base, id, (e) => { e.state = 'pending'; delete e.holdReason; });
}

/** ack = the entry is done; move it to history so the queue only holds live work. */
export async function ack(base, id) {
  const es = await entries(base);
  const e = es.find((x) => x.id === id);
  if (!e) return { ok: false, error: `no queue entry '${id}'` };
  await mkdir(join(base, DONE), { recursive: true });
  await rename(join(base, Q, fileFor(e.seq, e.id)), join(base, DONE, fileFor(e.seq, e.id)));
  return { ok: true, entry: { ...e, state: 'done' } };
}
