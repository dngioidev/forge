import { describe, it, expect } from 'vitest';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { append } from '../../plugin/scripts/lib/journal.mjs';
import { deriveSituation, pendingDecisions } from '../../plugin/scripts/lib/situation.mjs';

async function tmp() {
  return mkdtemp(join(tmpdir(), 'forge-sit-'));
}

async function writeDecision(cwd, id, status) {
  await mkdir(join(cwd, '.forge', 'decisions'), { recursive: true });
  await writeFile(join(cwd, '.forge', 'decisions', `${id}.json`), JSON.stringify({ id, issue: 3, reason: 'r', status }), 'utf8');
}

describe('deriveSituation (AC-3.3)', () => {
  it('idle with nothing, building with in-progress work', async () => {
    const cwd = await tmp();
    expect((await deriveSituation(cwd)).key).toBe('idle');
    expect((await deriveSituation(cwd, { blocked: 0, inProgress: 2 })).key).toBe('building');
  });

  it('awaiting-decision from pending decision files or blocked board items', async () => {
    const cwd = await tmp();
    await writeDecision(cwd, 'esc-3-a', 'pending');
    const s = await deriveSituation(cwd, { blocked: 0, inProgress: 1 });
    expect(s.key).toBe('awaiting-decision');
    expect(s.pendingCount).toBe(1);
    const boardOnly = await deriveSituation(await tmp(), { blocked: 2, inProgress: 0 });
    expect(boardOnly.key).toBe('awaiting-decision');
  });

  it('resolved decisions clear awaiting-decision', async () => {
    const cwd = await tmp();
    await writeDecision(cwd, 'esc-3-a', 'resolved');
    expect((await deriveSituation(cwd, { blocked: 0, inProgress: 1 })).key).toBe('building');
    expect(await pendingDecisions(cwd)).toEqual([]);
  });

  it('spec §7 priority: security-response > incident > awaiting-decision', async () => {
    const cwd = await tmp();
    await writeDecision(cwd, 'esc-3-a', 'pending');
    await append(cwd, 'incident', { phase: 'open', ticket: '#9' });
    expect((await deriveSituation(cwd)).key).toBe('incident');
    await append(cwd, 'respond-open', { id: 'r1' });
    expect((await deriveSituation(cwd)).key).toBe('security-response');
    await append(cwd, 'respond-close', { id: 'r1' });
    expect((await deriveSituation(cwd)).key).toBe('incident');
    await append(cwd, 'incident', { phase: 'closed', ticket: '#9' });
    expect((await deriveSituation(cwd)).key).toBe('awaiting-decision');
  });
});
