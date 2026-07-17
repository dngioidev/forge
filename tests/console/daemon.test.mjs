import { describe, it, expect } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { collectRepo, ledgerCounts } from '../../console/lib/collect.mjs';
import { sanitizeTelemetry, sanitizeEscalation } from '../../console/lib/sanitize.mjs';
import { makeTransport } from '../../console/lib/transport.mjs';
import { makeFileTransport } from '../../console/transports/file.mjs';
import { makeFirestoreTransport, fromFields } from '../../console/transports/firestore.mjs';
import { register, runOnce, runStatus, resolveReply, configPath } from '../../console/daemon.mjs';

const noop = () => {};
const NOW = Date.parse('2026-07-17T12:00:00Z');

async function repoDir({ branch = 'feat/11-console-daemon', decisions = [], journal = [], ledger = null } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'forge-con-'));
  await mkdir(join(dir, '.git'), { recursive: true });
  await writeFile(join(dir, '.git', 'HEAD'), `ref: refs/heads/${branch}\n`, 'utf8');
  await mkdir(join(dir, '.forge', 'decisions'), { recursive: true });
  for (const d of decisions) await writeFile(join(dir, '.forge', 'decisions', `${d.id}.json`), JSON.stringify(d), 'utf8');
  if (journal.length) await writeFile(join(dir, '.forge', 'journal.jsonl'), journal.map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf8');
  if (ledger) await writeFile(join(dir, '.forge', 'progress.md'), ledger, 'utf8');
  return dir;
}

const DECISION = {
  id: 'esc-11-live', issue: 11, reason: 'infra decision', status: 'pending',
  options: ['provision now', 'abstract first'], createdAt: '2026-07-17T10:00:00Z',
};

describe('collectors (AC-9.1)', () => {
  it('AC-9.1: snapshot carries situation, ticket, branch, ledger counts, decision ages, journal tail', async () => {
    const dir = await repoDir({
      decisions: [DECISION],
      journal: [{ ts: '2026-07-17T09:00:00Z', kind: 'gate-fail', gate: 'plandrift', ticket: '#11' }],
      ledger: '# SP9a — #11\n\n- [x] T1 — collectors\n- [~] T2 — sanitizer\n- [ ] T3 — transports\n',
    });
    const snap = await collectRepo(dir, NOW);
    expect(snap).toMatchObject({
      situation: 'awaiting-decision',
      branch: 'feat/11-console-daemon',
      ticket: '#11',
      branchKind: 'work',
      ledger: { total: 3, done: 1, inProgress: 1, pending: 1 },
    });
    expect(snap.pendingDecisions[0]).toMatchObject({ id: 'esc-11-live', issue: 11, ageHours: 2 });
    expect(snap.journalTail[0]).toEqual({ ts: '2026-07-17T09:00:00Z', kind: 'gate-fail', ticket: '#11', gate: 'plandrift', rule: null });
    expect(await ledgerCounts(await repoDir())).toBe(null);
  });
});

describe('sanitizer (AC-9.2)', () => {
  const base = { repo: 'forge', situation: 'building', collectedAt: '2026-07-17T12:00:00Z', machineId: 'm-1' };

  it('AC-9.2: unknown fields dropped, strings capped, code/diff/prompt never pass', () => {
    const res = sanitizeTelemetry({
      ...base,
      diff: 'patch content', prompt: 'secret prompt', code: 'const x = 1', stdout: 'log dump',
      branch: 'b'.repeat(500),
      journalTail: [{ ts: 't', kind: 'cmd-fail', err_line: 'raw stderr!', cmd: 'the command', ticket: '#1' }],
    });
    expect(res.ok).toBe(true);
    const s = JSON.stringify(res.doc);
    expect(s).not.toContain('patch content');
    expect(s).not.toContain('secret prompt');
    expect(s).not.toContain('raw stderr');
    expect(s).not.toContain('the command');
    expect(res.doc.branch.length).toBe(80);
    expect(res.doc.journalTail[0]).toEqual({ ts: 't', kind: 'cmd-fail', ticket: '#1', gate: null, rule: null });
  });

  it('AC-9.2: a doc missing required metadata refuses to publish', () => {
    const res = sanitizeTelemetry({ repo: 'forge', situation: 'idle' });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/refused to publish/);
    expect(sanitizeTelemetry(null).ok).toBe(false);
  });

  it('escalation docs need id, reason, and option labels', () => {
    expect(sanitizeEscalation(DECISION, 'm-1', 'forge').ok).toBe(true);
    expect(sanitizeEscalation({ id: 'x', reason: 'r', options: ['only-one'] }, 'm-1', 'forge').ok).toBe(false);
  });
});

describe('file transport (AC-9.3)', () => {
  it('AC-9.3: machine-scoped outbox; escalations idempotent; inbox consumed exactly once', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'forge-ft-'));
    const t = makeFileTransport({ machineId: 'm-1', transport: { kind: 'file', dir } });

    await t.publishTelemetry({ repo: 'forge', machineId: 'm-1', collectedAt: 'now' });
    expect(await readFile(join(dir, 'm-1', 'telemetry.jsonl'), 'utf8')).toContain('"repo":"forge"');

    await t.publishEscalation({ id: 'esc-1', reason: 'r' });
    const dup = await t.publishEscalation({ id: 'esc-1', reason: 'r' });
    expect(dup.duplicate).toBe(true);
    expect((await readFile(join(dir, 'm-1', 'escalations.jsonl'), 'utf8')).match(/esc-1/g)).toHaveLength(1);

    await writeFile(join(dir, 'm-1', 'decisions', 'esc-1.json'), JSON.stringify({ id: 'esc-1', answer: 'option 2', by: 'owner' }), 'utf8');
    const replies = await t.listDecisionReplies();
    expect(replies).toEqual([{ id: 'esc-1', answer: 'option 2', by: 'owner', repliedAt: null }]);
    await t.ackDecisionReply('esc-1');
    expect(await t.listDecisionReplies()).toEqual([]);
    expect(await readdir(join(dir, 'm-1', 'decisions'))).toEqual(['esc-1.json.done']);
  });

  it('unknown transport kind throws a teaching error', () => {
    expect(() => makeTransport({ transport: { kind: 'carrier-pigeon' } })).toThrow(/valid: file, firestore/);
  });
});

describe('daemon once + write-back (AC-9.4)', () => {
  it('AC-9.4: inbox reply resolves the repo decision file in --check-compatible shape', async () => {
    const repo = await repoDir({ decisions: [DECISION], journal: [{ ts: 't', kind: 'escalation', ticket: '#11' }] });
    const out = await mkdtemp(join(tmpdir(), 'forge-out-'));
    const config = { machineId: 'm-1', repos: [repo], transport: { kind: 'file', dir: out }, intervalSec: 60 };

    const first = await runOnce(config, { now: NOW, log: noop });
    expect(first.published).toHaveLength(1);
    expect((await readFile(join(out, 'm-1', 'escalations.jsonl'), 'utf8'))).toContain('esc-11-live');

    await writeFile(join(out, 'm-1', 'decisions', 'esc-11-live.json'), JSON.stringify({ id: 'esc-11-live', answer: 'option 2 — abstract first', by: 'dngioidev' }), 'utf8');
    const second = await runOnce(config, { now: NOW, log: noop });
    expect(second.resolved).toEqual(['esc-11-live']);

    const file = JSON.parse(await readFile(join(repo, '.forge', 'decisions', 'esc-11-live.json'), 'utf8'));
    expect(file).toMatchObject({ status: 'resolved', answer: 'option 2 — abstract first', resolvedBy: 'dngioidev' });
    expect(file.resolvedAt).toBeTruthy();

    // pendingDecisions now empty => escalate --check has nothing pending
    const snap = await collectRepo(repo, NOW);
    expect(snap.pendingDecisions).toEqual([]);
    expect(snap.situation).not.toBe('awaiting-decision');

    const journal = (await readFile(join(repo, '.forge', 'journal.jsonl'), 'utf8'));
    expect(journal).toContain('"escalation-resolved"');
    expect(journal).toContain('"via":"console"');
  });

  it('a reply for an unknown decision resolves nothing and is not acked', async () => {
    const repo = await repoDir();
    const res = await resolveReply([repo], { id: 'esc-ghost', answer: 'x' }, noop);
    expect(res.ok).toBe(false);
  });
});

describe('firestore adapter, structural (AC-9.5)', () => {
  const calls = [];
  const fetchFn = async (url, init = {}) => {
    calls.push({ url, method: init.method ?? 'GET', body: init.body ? JSON.parse(init.body) : null, headers: init.headers });
    if (!init.method) {
      return { ok: true, json: async () => ({ documents: [
        { name: 'doc1', fields: { id: { stringValue: 'esc-1' }, answer: { stringValue: 'option 1' }, acked: { booleanValue: false } } },
        { name: 'doc2', fields: { id: { stringValue: 'esc-2' }, answer: { stringValue: 'x' }, acked: { booleanValue: true } } },
      ] }) };
    }
    return { ok: true };
  };
  const t = makeFirestoreTransport({ machineId: 'm-1', transport: { kind: 'firestore', projectId: 'proj', authToken: 'tok' } }, fetchFn);

  it('AC-9.5: PATCH urls, bearer auth, field mapping round-trip', async () => {
    await t.publishTelemetry({ repo: 'forge', ledger: { total: 3 }, tags: ['a'] });
    const call = calls.at(-1);
    expect(call.url).toContain('/projects/proj/databases/(default)/documents/machines/m-1/telemetry/forge');
    expect(call.method).toBe('PATCH');
    expect(call.headers.Authorization).toBe('Bearer tok');
    expect(call.body.fields.repo).toEqual({ stringValue: 'forge' });
    expect(call.body.fields.ledger.mapValue.fields.total).toEqual({ integerValue: '3' });
    expect(fromFields(call.body.fields)).toMatchObject({ repo: 'forge', ledger: { total: 3 }, tags: ['a'] });

    await t.publishEscalation({ id: 'esc-9', reason: 'r' });
    expect(calls.at(-1).url).toContain('/escalations/esc-9');
  });

  it('AC-9.5: inbox lists only unacked replies; ack PATCHes the mask', async () => {
    const replies = await t.listDecisionReplies();
    expect(replies).toEqual([{ id: 'esc-1', answer: 'option 1', by: null, repliedAt: null }]);
    await t.ackDecisionReply('esc-1');
    expect(calls.at(-1).url).toContain('replies/esc-1?updateMask.fieldPaths=acked');
    expect(calls.at(-1).body.fields.acked).toEqual({ booleanValue: true });
  });

  it('missing projectId throws a teaching error', () => {
    expect(() => makeFirestoreTransport({ machineId: 'm', transport: { kind: 'firestore' } })).toThrow(/projectId/);
  });
});

describe('register + status (AC-9.6, AC-9.7)', () => {
  it('AC-9.6: register creates a stable machineId; re-run keeps it and appends repos', async () => {
    const home = await mkdtemp(join(tmpdir(), 'forge-home-'));
    const r1 = await register('/repo/one', home);
    expect(r1.created).toBe(true);
    expect(r1.config.machineId).toMatch(/^[a-z0-9-]+-[0-9a-f]{4}$/);
    const r2 = await register('/repo/two', home);
    expect(r2.created).toBe(false);
    expect(r2.config.machineId).toBe(r1.config.machineId);
    expect(r2.config.repos).toEqual(['/repo/one', '/repo/two']);
    const r3 = await register('/repo/one', home);
    expect(r3.config.repos).toHaveLength(2); // no duplicates
    expect(configPath(home)).toContain('.forge');
  });

  it('AC-9.7: every publish carries machineId + collectedAt; status reports last-publish age', async () => {
    const repo = await repoDir();
    const out = await mkdtemp(join(tmpdir(), 'forge-out2-'));
    const config = { machineId: 'm-hb', repos: [repo], transport: { kind: 'file', dir: out }, intervalSec: 60 };
    await runOnce(config, { now: NOW, log: noop });
    const line = JSON.parse((await readFile(join(out, 'm-hb', 'telemetry.jsonl'), 'utf8')).trim());
    expect(line.machineId).toBe('m-hb');
    expect(line.collectedAt).toBe('2026-07-17T12:00:00.000Z');

    const logs = [];
    const res = await runStatus(config, (m) => logs.push(m));
    expect(res.repos).toHaveLength(1);
    expect(logs[0]).toMatch(/last publish \d+ min ago/);
  });
});
