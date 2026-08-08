import { open, unlink, readFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { hostname as osHostname } from 'node:os';

/**
 * Shared exclusive-lockfile helper (#414, per #387's design — spike
 * `docs/spikes/2026-08-06-autopilot-concurrency-safety.md` — never implemented
 * anywhere until this ticket). Exclusive-create (`fs.open(path, 'wx')`, NOT
 * `jsonfile.mjs`'s clobbering temp+rename — a lock must fail to create when one
 * already exists, not silently overwrite it), `{pid, startedAt, hostname}`
 * contents, PID-liveness + age-staleness reclaim, release in try/finally at
 * every call site. Any consumer needing its own exclusive lockfile (the outbox
 * today; #387's eventual `run.lock` later) should reuse this instead of
 * hand-rolling a second copy of the same idiom.
 */

/** Default staleness window before a lock with a dead-looking clock is
 * reclaimed even if PID-liveness can't be checked (e.g. a lock written by a
 * process on a different host). 15 minutes mirrors `exec.mjs`'s own
 * `resetCapMs` — the longest a GitHub rate-limit reset window is expected to
 * force a wait, a comparable order of magnitude to "how long is too long to
 * hold this kind of lock." */
export const DEFAULT_STALE_MS = 15 * 60 * 1000;

/** Is `pid` a live process? `process.kill(pid, 0)` sends no signal, it only
 * probes existence — throws ESRCH when the pid is gone, EPERM when it exists
 * but is owned by someone else (still alive, just not ours to signal). Any
 * other throw (a malformed pid) is treated as "not alive" — fails safe toward
 * reclaiming rather than toward respecting a lock we can't even evaluate. */
function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code === 'EPERM';
  }
}

/** Tolerant read of a lock's contents. Absent/corrupt both read as `null` —
 * callers treat an unreadable lock as reclaimable (see `isStale`). */
export async function readLock(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Pure staleness test (no IO): a lock is reclaimable when its contents are
 * unreadable/malformed, its recorded age exceeds `staleMs`, or its owning pid
 * is no longer alive. `isAlive`/`now` are injectable so this is testable
 * without a real process or clock.
 */
export function isStale(lock, { now = Date.now(), staleMs = DEFAULT_STALE_MS, isAlive = isProcessAlive } = {}) {
  if (!lock || typeof lock !== 'object') return true;
  const age = now - Date.parse(lock.startedAt ?? '');
  if (Number.isNaN(age)) return true;
  if (age >= staleMs) return true;
  return !isAlive(lock.pid);
}

/**
 * Acquire the exclusive lock at `path`. On a live lock held by someone else,
 * returns `{ok:false, error, heldBy}` — the caller decides what "can't get the
 * lock right now" means for it (skip this attempt, in the outbox's case). On a
 * stale/dead lock, reclaims it (unlink + one retry) rather than wedging
 * forever on a crashed holder. `release()` on the success result is idempotent
 * and safe to call from a `finally` even if the file is already gone.
 */
export async function acquireLock(path, { pid = process.pid, hostname = osHostname(), now = Date.now, staleMs = DEFAULT_STALE_MS, isAlive = isProcessAlive, _reclaimed = false } = {}) {
  if (!_reclaimed) await mkdir(dirname(path), { recursive: true }); // only needed once — the retry-after-reclaim path already has it
  let handle;
  try {
    handle = await open(path, 'wx');
  } catch (err) {
    if (err?.code !== 'EEXIST') return { ok: false, error: String(err?.message || err) };
    if (_reclaimed) return { ok: false, error: `lock ${path} still held after a reclaim attempt` };
    const existing = await readLock(path);
    if (!isStale(existing, { now: now(), staleMs, isAlive })) {
      return { ok: false, error: `lock ${path} held by pid ${existing?.pid ?? '?'} (${existing?.hostname ?? 'unknown host'})`, heldBy: existing };
    }
    await unlink(path).catch(() => {}); // dead/stale holder — safe to reclaim
    return acquireLock(path, { pid, hostname, now, staleMs, isAlive, _reclaimed: true });
  }
  try {
    await handle.writeFile(JSON.stringify({ pid, startedAt: new Date(now()).toISOString(), hostname }), 'utf8');
  } finally {
    await handle.close();
  }
  let released = false;
  return {
    ok: true,
    async release() {
      if (released) return;
      released = true;
      await unlink(path).catch(() => {});
    },
  };
}
