import { describe, it, expect } from 'vitest';
import { mkdtemp, readFile, writeFile, mkdir, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { acquireLock, isStale, readLock, DEFAULT_STALE_MS } from '../../plugin/scripts/lib/lock.mjs';

async function tmp() {
  return mkdtemp(join(tmpdir(), 'forge-lock-'));
}

describe('lib/lock (#414, per #387 design) — shared exclusive-lockfile helper', () => {
  it('acquires a fresh lock, writes {pid,startedAt,hostname}, and release() removes it', async () => {
    const dir = await tmp();
    const path = join(dir, 'x.lock');
    const lock = await acquireLock(path, { pid: 4242, hostname: 'host-a', now: () => Date.parse('2026-08-08T00:00:00Z') });
    expect(lock.ok).toBe(true);
    const raw = JSON.parse(await readFile(path, 'utf8'));
    expect(raw).toMatchObject({ pid: 4242, hostname: 'host-a', startedAt: '2026-08-08T00:00:00.000Z' });
    await lock.release();
    await expect(readFile(path, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('release() is idempotent — calling it twice (or after the file is already gone) never throws', async () => {
    const dir = await tmp();
    const path = join(dir, 'x.lock');
    const lock = await acquireLock(path);
    expect(lock.ok).toBe(true);
    await lock.release();
    await expect(lock.release()).resolves.toBeUndefined();
  });

  it('a live, non-stale lock held by someone else is respected — acquire fails, file untouched', async () => {
    const dir = await tmp();
    const path = join(dir, 'x.lock');
    const now = Date.now();
    await writeFile(path, JSON.stringify({ pid: process.pid, startedAt: new Date(now).toISOString(), hostname: 'me' }), 'utf8');
    const attempt = await acquireLock(path, { now: () => now, isAlive: () => true });
    expect(attempt.ok).toBe(false);
    expect(attempt.error).toMatch(/held by pid/);
    expect(attempt.heldBy).toMatchObject({ pid: process.pid });
    // the existing lock file is untouched, not reclaimed
    const raw = JSON.parse(await readFile(path, 'utf8'));
    expect(raw.hostname).toBe('me');
  });

  it('a dead-pid lock (isAlive:false) is reclaimed and the new holder wins', async () => {
    const dir = await tmp();
    const path = join(dir, 'x.lock');
    const now = Date.now();
    await writeFile(path, JSON.stringify({ pid: 999999, startedAt: new Date(now).toISOString(), hostname: 'crashed-host' }), 'utf8');
    const attempt = await acquireLock(path, { pid: 1234, hostname: 'me', now: () => now, isAlive: (pid) => pid !== 999999 });
    expect(attempt.ok).toBe(true);
    const raw = JSON.parse(await readFile(path, 'utf8'));
    expect(raw).toMatchObject({ pid: 1234, hostname: 'me' });
    await attempt.release();
  });

  it('a lock past staleMs is reclaimed even if isAlive would say the pid is alive', async () => {
    const dir = await tmp();
    const path = join(dir, 'x.lock');
    const oldStart = Date.now() - DEFAULT_STALE_MS - 1000;
    await writeFile(path, JSON.stringify({ pid: process.pid, startedAt: new Date(oldStart).toISOString(), hostname: 'me' }), 'utf8');
    const attempt = await acquireLock(path, { now: () => Date.now(), isAlive: () => true });
    expect(attempt.ok).toBe(true);
    await attempt.release();
  });

  it('a lock with unparsable/corrupt contents is treated as reclaimable, not respected', async () => {
    const dir = await tmp();
    const path = join(dir, 'x.lock');
    await writeFile(path, 'not json', 'utf8');
    const attempt = await acquireLock(path);
    expect(attempt.ok).toBe(true);
    await attempt.release();
  });

  describe('isStale — pure boundary decision', () => {
    it('null/malformed lock is always stale', () => {
      expect(isStale(null)).toBe(true);
      expect(isStale('nope')).toBe(true);
      expect(isStale({})).toBe(true); // no startedAt
    });
    it('fresh + alive => not stale; fresh + dead pid => stale', () => {
      const now = Date.now();
      const lock = { pid: 1, startedAt: new Date(now).toISOString() };
      expect(isStale(lock, { now, isAlive: () => true })).toBe(false);
      expect(isStale(lock, { now, isAlive: () => false })).toBe(true);
    });
    it('age >= staleMs is stale regardless of isAlive', () => {
      const now = Date.now();
      const lock = { pid: 1, startedAt: new Date(now - 1000).toISOString() };
      expect(isStale(lock, { now, staleMs: 500, isAlive: () => true })).toBe(true);
    });
  });

  it('readLock tolerates a missing file (returns null, never throws)', async () => {
    const dir = await tmp();
    expect(await readLock(join(dir, 'missing.lock'))).toBeNull();
  });

  it('two sequential acquireLock calls on the SAME path from the SAME process do not deadlock — the second waits for an explicit release, not an implicit self-grant', async () => {
    const dir = await tmp();
    const path = join(dir, 'x.lock');
    const first = await acquireLock(path);
    expect(first.ok).toBe(true);
    const second = await acquireLock(path, { isAlive: () => true }); // not reentrant — my own live lock still blocks me
    expect(second.ok).toBe(false);
    await first.release();
    const third = await acquireLock(path);
    expect(third.ok).toBe(true);
    await third.release();
  });

  // Found in review (major, empirically reproduced): the original blind
  // unlink()+recreate reclaim let two concurrent callers BOTH judge the same
  // stale lock reclaimable and BOTH end up believing they hold it — the exact
  // #387 lost-update race this lockfile exists to prevent. The fix reclaims
  // via an atomic rename (only one racer's rename can ever succeed); this
  // pins that AT MOST ONE concurrent acquirer ever wins a race over one
  // stale lock, run repeatedly since a race is inherently non-deterministic.
  it('AC — concurrent acquireLock calls racing to reclaim the SAME stale lock: exactly one wins, never both', async () => {
    for (let iter = 0; iter < 25; iter++) {
      const dir = await tmp();
      const path = join(dir, 'x.lock');
      const now = Date.now();
      await writeFile(path, JSON.stringify({ pid: 999999, startedAt: new Date(now).toISOString(), hostname: 'crashed-host' }), 'utf8');
      const isAlive = (pid) => pid !== 999999; // the seeded holder is dead — reclaimable by everyone racing it
      const attempts = await Promise.all(
        Array.from({ length: 5 }, (_, i) => acquireLock(path, { pid: 1000 + i, now: () => now, isAlive })),
      );
      const winners = attempts.filter((a) => a.ok);
      expect(winners).toHaveLength(1); // never zero (a live dead-pid lock must be reclaimable), never more than one
      // the on-disk lock reflects exactly the winner's own pid — not a torn/mixed write
      const raw = JSON.parse(await readFile(path, 'utf8'));
      expect(winners[0].ok).toBe(true);
      await winners[0].release();
    }
  });

  // #414 review — symlink-safety on the READ side, mirroring
  // `monitors/ci-watch.mjs`'s `loadCiWatchState` guard: `acquireLock`'s
  // `open(path,'wx')`/`unlink(path)` can't be tricked by a symlink (O_EXCL
  // create fails EEXIST on an existing link; unlink removes the link itself),
  // but a plain `readFile` in `readLock` WOULD follow one — a local attacker
  // with pre-existing write access to the lock's directory could plant a
  // symlink to make the staleness verdict reflect an arbitrary file.
  it('readLock never follows a symlink planted at the lock path', async () => {
    const dir = await tmp();
    const targetDir = await mkdtemp(join(tmpdir(), 'forge-lock-target-'));
    const target = join(targetDir, 'forged.json');
    await writeFile(target, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), hostname: 'forged' }));
    const linkPath = join(dir, 'x.lock');
    await mkdir(dirname(linkPath), { recursive: true });
    try {
      await symlink(target, linkPath, 'file');
    } catch (err) {
      if (err?.code === 'EPERM' || err?.code === 'EACCES') return; // needs elevated privilege on some platforms
      throw err;
    }
    await expect(readLock(linkPath)).resolves.toBeNull(); // never dereferenced — treated as absent/unreadable
  });
});
