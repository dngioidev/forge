import { describe, it, expect } from 'vitest';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
});
