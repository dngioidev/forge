import { describe, it, expect } from 'vitest';
import { mkdtemp, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as queue from '../../control/lib/queue.mjs';
import * as machine from '../../control/lib/machine.mjs';
import { runControl, parseArgs, ALLOWED_VERBS, defaultBase } from '../../control/control.mjs';

const base = () => mkdtemp(join(tmpdir(), 'forge-ctl-'));
const noop = () => {};

describe('queue (AC-C1.1)', () => {
  it('AC-C1.1: enqueue/next/hold/ack round-trip FIFO; held skipped; ack archives', async () => {
    const b = await base();
    const a = await queue.enqueue(b, { repo: 'forge', ticket: 60, brief: 'first' });
    const c = await queue.enqueue(b, { repo: 'cms', brief: 'second' });
    expect(a.entry.seq).toBe(1);
    expect(c.entry.seq).toBe(2);

    // next = lowest-seq pending
    expect((await queue.next(b)).entry.id).toBe(a.entry.id);
    // hold the first → next skips to the second
    await queue.hold(b, a.entry.id, 'waiting on decision');
    expect((await queue.next(b)).entry.id).toBe(c.entry.id);
    expect((await queue.list(b)).entries.find((e) => e.id === a.entry.id)).toMatchObject({ state: 'held', holdReason: 'waiting on decision' });
    // release restores order
    await queue.release(b, a.entry.id);
    expect((await queue.next(b)).entry.id).toBe(a.entry.id);
    // ack archives out of the live queue
    await queue.ack(b, a.entry.id);
    expect((await queue.list(b)).entries.map((e) => e.id)).toEqual([c.entry.id]);
    expect(await readdir(join(b, 'queue-done'))).toHaveLength(1);
    // new enqueue keeps increasing seq past archived
    expect((await queue.enqueue(b, { repo: 'x' })).entry.seq).toBe(3);
    expect((await queue.hold(b, 'nope')).ok).toBe(false);
  });

  it('enqueue requires a repo; empty queue next is null', async () => {
    const b = await base();
    expect((await queue.enqueue(b, {})).ok).toBe(false);
    expect((await queue.next(b)).entry).toBe(null);
  });
});

describe('machine paused + sessions (AC-C1.2, AC-C1.3)', () => {
  it('AC-C1.2: paused flag set/clear with who/when; missing = false', async () => {
    const b = await base();
    expect(await machine.isPaused(b)).toBe(false);
    await machine.setPaused(b, { by: 'dngioidev', reason: 'overnight' });
    expect(await machine.isPaused(b)).toBe(true);
    expect((await machine.pausedInfo(b)).info).toMatchObject({ by: 'dngioidev', reason: 'overnight' });
    await machine.clearPaused(b);
    expect(await machine.isPaused(b)).toBe(false);
    expect((await machine.pausedInfo(b)).info).toBe(null);
  });

  it('AC-C1.3: sessions register/update/list/mark', async () => {
    const b = await base();
    await machine.registerSession(b, { id: 's1', ticket: 60, repo: 'forge', pid: 1234 });
    expect((await machine.listSessions(b)).sessions[0]).toMatchObject({ id: 's1', state: 'alive', pid: 1234 });
    await machine.updateSession(b, 's1', { state: 'idle' });
    expect((await machine.listSessions(b)).sessions[0].state).toBe('idle');
    await machine.markSession(b, 's1', 'killed');
    expect((await machine.listSessions(b)).sessions[0].state).toBe('killed');
    expect((await machine.updateSession(b, 'ghost', {})).ok).toBe(false);
    expect((await machine.registerSession(b, { id: 'x' })).ok).toBe(false); // needs repo
  });
});

describe('control CLI allowlist + audit (AC-C1.4)', () => {
  it('AC-C1.4: unknown verb refused naming the allowed set', async () => {
    const b = await base();
    const res = await runControl(b, parseArgs(['deploy', '--repo', 'forge']), noop);
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/unknown verb 'deploy'/);
    expect(res.error).toContain('enqueue, dequeue, list, status, pause, resume, kill, kill-all');
    // the dangerous verbs simply do not exist in the vocabulary
    for (const forbidden of ['push', 'merge', 'edit', 'commit']) expect(ALLOWED_VERBS).not.toContain(forbidden);
  });

  it('AC-C1.4: every accepted verb writes a redacted audit record', async () => {
    const b = await base();
    await runControl(b, parseArgs(['enqueue', '--repo', 'forge', '--ticket', '60', '--brief', 'do the thing']), noop);
    await runControl(b, parseArgs(['pause', '--reason', 'GITHUB_TOKEN=ghp_secretsecretsecretsecret1234']), noop);
    const audit = (await readFile(join(b, 'audit.jsonl'), 'utf8')).trim().split('\n').map((l) => JSON.parse(l));
    expect(audit).toHaveLength(2);
    expect(audit[0]).toMatchObject({ verb: 'enqueue', repo: 'forge', ticket: 60 });
    expect(JSON.stringify(audit)).not.toContain('ghp_secretsecret'); // reason not audited, and redaction covers payloads
  });

  it('AC-C1.4: enqueue → status → dequeue drives the queue; pause/resume/kill-all', async () => {
    const b = await base();
    const e = await runControl(b, parseArgs(['enqueue', '--repo', 'forge', '--ticket', '60']), noop);
    expect(e.ok).toBe(true);
    expect((await runControl(b, parseArgs(['status']), noop))).toMatchObject({ pending: 1, alive: 0, paused: false });

    await machine.registerSession(b, { id: 's1', repo: 'forge' });
    const killAll = await runControl(b, parseArgs(['kill-all']), noop);
    expect(killAll).toMatchObject({ ok: true, killed: 1 });
    expect(await machine.isPaused(b)).toBe(true); // kill-all engages the switch
    expect((await machine.listSessions(b)).sessions[0].state).toBe('killed');
    await runControl(b, parseArgs(['resume']), noop);
    expect(await machine.isPaused(b)).toBe(false);

    await runControl(b, parseArgs(['dequeue', '--id', e.entry.id]), noop);
    expect((await queue.list(b)).entries).toHaveLength(0);
    expect((await runControl(b, parseArgs(['dequeue']), noop)).ok).toBe(false); // needs --id
  });

  it('defaultBase lives under ~/.forge/control, FORGE_CONTROL_BASE overrides (#93)', () => {
    const saved = process.env.FORGE_CONTROL_BASE;
    try {
      delete process.env.FORGE_CONTROL_BASE;
      expect(defaultBase('/home/u')).toBe(join('/home/u', '.forge', 'control'));
      process.env.FORGE_CONTROL_BASE = '/custom/control';
      expect(defaultBase('/home/u')).toBe('/custom/control');
    } finally { if (saved === undefined) delete process.env.FORGE_CONTROL_BASE; else process.env.FORGE_CONTROL_BASE = saved; }
  });
});
