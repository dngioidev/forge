import { open, unlink, readFile, mkdir, lstat, stat } from 'node:fs/promises';
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

/**
 * Tolerant read of a lock's contents. Absent/corrupt both read as `null` —
 * callers treat an unreadable lock as reclaimable (see `isStale`). Symlink-safe
 * (found in review, mirrors `monitors/ci-watch.mjs`'s `loadCiWatchState`): a
 * plain `readFile` follows symlinks, so a local attacker with pre-existing
 * write access to the lock's directory could otherwise plant a symlink at
 * `path` to make this read (and thus the staleness verdict) reflect an
 * arbitrary file elsewhere. `lstat` (which does NOT follow links) gates the
 * read so a symlinked path reads as absent/unreadable, same as a missing or
 * corrupt lock — `acquireLock`'s `open(path,'wx')` already can't be tricked
 * into following a symlink either (O_EXCL create fails EEXIST on an existing
 * symlink), so this closes the read side to match.
 */
export async function readLock(path) {
  try {
    const st = await lstat(path);
    if (st.isSymbolicLink()) return null;
  } catch {
    return null;
  }
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

/** JSON contents every successful lock (fresh or reclaimed) carries. */
function lockContents(pid, hostname, now) {
  return JSON.stringify({ pid, startedAt: new Date(now).toISOString(), hostname });
}

/** The `release()` object every successful `acquireLock` returns. Idempotent
 * and safe from a `finally` even if `path` is already gone. */
function releasable(path) {
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

/**
 * A leaked reclaim marker (see `reclaimStaleLock` below) can only happen from
 * a crash inside the tiny create-marker → overwrite-stale-lock → delete-marker
 * window — a handful of fs syscalls, normally sub-millisecond. Anything older
 * than this is certainly abandoned, never a marker still legitimately in use.
 */
const RECLAIM_MARKER_STALE_MS = 30_000;

/**
 * Reclaim a confirmed-stale lock at `path`, exclusively, and leave `path`
 * holding the NEW winning content — never absent, not even momentarily.
 *
 * Two bugs were found and fixed here in review, in sequence:
 *
 * 1. (major, empirically reproduced) An unconditional `unlink(path)` here
 *    lets every concurrent caller that independently judged the same stale
 *    lock reclaimable succeed in turn — all of them believe they hold the
 *    lock afterward, exactly the #387 lost-update race this module exists to
 *    prevent. A `rename`-based "only one mover wins" attempt was tried next
 *    and ALSO empirically failed under concurrent load on this platform's
 *    filesystem (Node's `fs.rename` did not reliably error out losing racers
 *    here, unlike POSIX rename's textbook atomicity guarantee) — so the
 *    exclusivity gate instead reuses the ONE primitive this module already
 *    trusts and has verified reliable under concurrency: `open(path,'wx')`
 *    (O_CREAT|O_EXCL), the same call `acquireLock` itself uses for the lock
 *    file. Only the process that wins this `${path}.reclaiming` marker may
 *    touch the stale lock; everyone else backs off.
 * 2. (found hardening fix 1) The marker alone is not sufficient if the winner
 *    then does `unlink(path)` followed by a SEPARATE `open(path,'wx')` to
 *    recreate it — the gap between those two calls leaves `path` genuinely
 *    absent for a moment, during which an UNRELATED, ordinary `acquireLock`
 *    call (one that never needed to go through this reclaim path at all,
 *    just an ordinary fresh accquire racing to grab a path it thinks is
 *    simply free) can slip in and succeed via its own `open(path,'wx')` —
 *    yielding two live "winners" again, just via a different interleaving.
 *    Fixed by never letting `path` go missing: once holding the marker
 *    exclusively, this writes the new lock content directly into `path` with
 *    `open(path,'w')` (create-or-truncate, non-exclusive — safe here
 *    specifically because the marker already proved sole reclaimer status),
 *    with no unlink/recreate gap in between.
 */
async function reclaimStaleLock(path, { pid, hostname, now }) {
  const marker = `${path}.reclaiming`;
  let markerHandle;
  try {
    markerHandle = await open(marker, 'wx');
  } catch (err) {
    if (err?.code !== 'EEXIST') return { ok: false, error: String(err?.message || err) };
    // Someone else is (or very recently was) reclaiming this exact stale
    // lock. Only steal the marker itself if IT looks abandoned (a crash in
    // the narrow window between creating and deleting it) — an ordinary
    // in-flight reclaim just means this caller lost the race this time.
    let st;
    try {
      st = await stat(marker);
    } catch {
      return { ok: false, error: `lock ${path} — a concurrent reclaim is already in progress` };
    }
    if (now() - st.mtimeMs < RECLAIM_MARKER_STALE_MS) {
      return { ok: false, error: `lock ${path} — a concurrent reclaim is already in progress` };
    }
    await unlink(marker).catch(() => {});
    return reclaimStaleLock(path, { pid, hostname, now });
  }
  try {
    await markerHandle.close();
    const handle = await open(path, 'w'); // exclusively-marked reclaimer — safe to overwrite, `path` never goes missing
    try {
      await handle.writeFile(lockContents(pid, hostname, now()), 'utf8');
    } finally {
      await handle.close();
    }
    return { ok: true };
  } finally {
    await unlink(marker).catch(() => {});
  }
}

/**
 * Acquire the exclusive lock at `path`. On a live lock held by someone else,
 * returns `{ok:false, error, heldBy}` — the caller decides what "can't get the
 * lock right now" means for it (skip this attempt, in the outbox's case). On a
 * stale/dead lock, reclaims it (via `reclaimStaleLock`, exclusively) rather
 * than wedging forever on a crashed holder. `release()` on the success result
 * is idempotent and safe to call from a `finally` even if the file is already
 * gone.
 */
export async function acquireLock(path, { pid = process.pid, hostname = osHostname(), now = Date.now, staleMs = DEFAULT_STALE_MS, isAlive = isProcessAlive } = {}) {
  await mkdir(dirname(path), { recursive: true });
  let handle;
  try {
    handle = await open(path, 'wx');
  } catch (err) {
    if (err?.code !== 'EEXIST') return { ok: false, error: String(err?.message || err) };
    const existing = await readLock(path);
    if (!isStale(existing, { now: now(), staleMs, isAlive })) {
      return { ok: false, error: `lock ${path} held by pid ${existing?.pid ?? '?'} (${existing?.hostname ?? 'unknown host'})`, heldBy: existing };
    }
    const reclaimed = await reclaimStaleLock(path, { pid, hostname, now });
    if (!reclaimed.ok) return reclaimed;
    return releasable(path);
  }
  try {
    await handle.writeFile(lockContents(pid, hostname, now()), 'utf8');
  } finally {
    await handle.close();
  }
  return releasable(path);
}
