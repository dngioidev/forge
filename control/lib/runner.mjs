/**
 * forge-control runner (C2/#62; spec §2). The daemon `work` loop: take the next
 * runnable queue entry, spawn a headless `claude -p` session, supervise it
 * (heartbeat / timeout / kill), record the outcome to the control journal + the
 * driving ticket's trail, and ack the entry. One session at a time per machine
 * (spec §2). The control plane never merges — the spawned session runs the normal
 * pipeline and the owner merges the PR.
 *
 * Everything external is injectable (spawn / trail / journal / clock) so the loop
 * is fully testable without the real binary, real gh, or real time.
 */
import { appendFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { redact } from '../../plugin/scripts/lib/journal.mjs';
import * as queue from './queue.mjs';
import * as machine from './machine.mjs';
import { spawnSession, classify } from './spawn.mjs';

const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000; // 30 min — a stuck session is killed, not left orphaned
const DEFAULT_HEARTBEAT_MS = 15 * 1000;

/** Control-plane session log — separate from the repo journal (whose KINDS are fixed). Redacted. */
async function defaultJournal(base, rec) {
  await mkdir(base, { recursive: true });
  await appendFile(join(base, 'runner.jsonl'), JSON.stringify(redact({ ts: new Date().toISOString(), ...rec })) + '\n', 'utf8');
}

/** Best-effort ticket trail via gh. repo must be an owner/name slug; a path is skipped (journaled). */
function defaultTrail(repo, ticket, body) {
  return new Promise((resolve) => {
    if (!repo || !/^[\w.-]+\/[\w.-]+$/.test(repo)) return resolve({ ok: false, error: `no slug for trail (repo='${repo}')` });
    execFile('gh', ['issue', 'comment', String(ticket), '--repo', repo, '--body', body], (err) => resolve({ ok: !err, error: err ? String(err) : null }));
  });
}

function outcomeLine(outcome, sessionId, extra = {}) {
  const cost = extra.cost != null ? ` · $${extra.cost}` : '';
  if (outcome === 'timeout') return `🛑 forge-control killed session \`${sessionId}\` — exceeded timeout (${extra.timeoutMs}ms). Branch/PR (if any) left for review; nothing died silently.`;
  if (outcome === 'killed') return `🛑 forge-control killed session \`${sessionId}\`.`;
  if (outcome === 'success') return `✅ forge-control session \`${sessionId}\` finished (success)${cost}. The PR follows the normal pipeline — owner merges.`;
  return `⚠️ forge-control session \`${sessionId}\` ended: ${outcome}${cost}.`;
}

/**
 * Drive one queue entry through a supervised session.
 * Returns { ok, skipped? , sessionId?, outcome?, entry? }.
 *   skipped: 'paused' (C1 kill switch engaged) | 'empty' (nothing runnable).
 */
export async function runOnce(base, opts = {}) {
  const {
    spawn = (o) => spawnSession(o),
    timeoutMs = DEFAULT_TIMEOUT_MS,
    heartbeatMs = DEFAULT_HEARTBEAT_MS,
    trail = defaultTrail,
    journal = defaultJournal,
    model,
    permissionMode,
    mintId = randomUUID,
  } = opts;

  if (await machine.isPaused(base)) return { ok: true, skipped: 'paused' };
  const { entry } = await queue.next(base);
  if (!entry) return { ok: true, skipped: 'empty' };

  const sessionId = mintId();
  await machine.registerSession(base, { id: sessionId, ticket: entry.ticket, repo: entry.repo, pid: null });
  await journal(base, { event: 'session-start', sessionId, ticket: entry.ticket, repo: entry.repo, brief: entry.brief });

  const handle = spawn({ brief: entry.brief, sessionId, repo: entry.repo, model, permissionMode });
  await machine.updateSession(base, sessionId, { pid: handle.pid ?? null });

  // Supervise: a heartbeat while alive, and a timeout that kills by handle (PID under the hood).
  // The heartbeat is a self-chaining timeout (not setInterval) so it can be stopped cleanly and
  // its last in-flight write awaited — otherwise a fire-and-forget beat's read-modify-write can
  // land AFTER the final markSession and clobber the authoritative state back to 'alive'.
  let killedReason = null;
  let stopped = false;
  let hbInflight = Promise.resolve();
  const timer = setTimeout(() => { killedReason = 'timeout'; try { handle.kill(); } catch { /* already gone */ } }, timeoutMs);
  const beat = () => {
    if (stopped) return;
    hbInflight = machine.updateSession(base, sessionId, {}).catch(() => {});
    hbTimer = setTimeout(beat, heartbeatMs);
  };
  let hbTimer = setTimeout(beat, heartbeatMs);

  let result;
  try {
    result = await handle.done; // resolves on natural close AND after a kill
  } finally {
    clearTimeout(timer);
    stopped = true;
    clearTimeout(hbTimer);
    await hbInflight; // let the last heartbeat write settle before the authoritative mark below
  }

  const outcome = classify({ exitCode: result?.exitCode, envelope: result?.envelope, killedReason });
  const cost = result?.envelope?.total_cost_usd;
  await machine.markSession(base, sessionId, killedReason ? 'killed' : 'dead');
  await journal(base, { event: 'session-end', sessionId, ticket: entry.ticket, repo: entry.repo, outcome, cost, killedReason });
  // Trail to the GitHub slug when the entry carries one; the spawn path can't be a slug (#73).
  if (entry.ticket) await trail(entry.repoSlug ?? entry.repo, entry.ticket, outcomeLine(outcome, sessionId, { cost, timeoutMs }));
  await queue.ack(base, entry.id);

  return { ok: true, sessionId, outcome, killedReason, entry };
}

/**
 * The daemon loop: run entries one at a time until paused or the queue drains.
 * `once: true` runs a single entry (used by tests / a one-shot invocation).
 */
export async function work(base, opts = {}) {
  const results = [];
  for (;;) {
    const r = await runOnce(base, opts);
    results.push(r);
    if (r.skipped || opts.once) break;
  }
  return results;
}
