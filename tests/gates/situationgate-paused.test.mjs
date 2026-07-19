import { describe, it, expect } from 'vitest';
import { mkdtemp, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { machinePaused, deriveSituation } from '../../plugin/scripts/lib/situation.mjs';
import { evaluate, runGate } from '../../plugin/scripts/gates/situationgate.mjs';

const noop = () => {};
const tmp = () => mkdtemp(join(tmpdir(), 'forge-c4-'));
async function pausedBase() {
  const b = await tmp();
  await writeFile(join(b, 'paused'), JSON.stringify({ by: 'owner', reason: 'test' }), 'utf8');
  return b;
}
async function incidentCwd() {
  const cwd = await tmp();
  await mkdir(join(cwd, '.forge'), { recursive: true });
  await writeFile(join(cwd, '.forge', 'journal.jsonl'), JSON.stringify({ ts: 't1', kind: 'incident', phase: 'open', ticket: '#1' }) + '\n', 'utf8');
  return cwd;
}

describe('machinePaused (AC-C4.1)', () => {
  it('AC-C4.1: true when <base>/paused exists, false when absent — reads the file directly', async () => {
    expect(await machinePaused(await tmp())).toBe(false);
    expect(await machinePaused(await pausedBase())).toBe(true);
    expect(await machinePaused('Z:/definitely/missing')).toBe(false);
  });
});

describe('deriveSituation + paused (AC-C4.2)', () => {
  it('AC-C4.2: paused becomes the key when nothing higher is active', async () => {
    const s = await deriveSituation(await tmp(), { blocked: 0, inProgress: 1 }, { paused: true });
    expect(s.key).toBe('paused');
    expect(s.glyph).toBe('⏸');
    expect(s.paused).toBe(true);
  });

  it('AC-C4.2: a higher care-situation wins key, but paused is still reported', async () => {
    const cwd = await incidentCwd();
    const s = await deriveSituation(cwd, { blocked: 0, inProgress: 0 }, { paused: true });
    expect(s.key).toBe('incident'); // incident outranks paused for the display
    expect(s.paused).toBe(true);    // ...but the gate still learns the machine is held
  });

  it('AC-C4.2: not paused → prior behavior unchanged (building/idle)', async () => {
    expect((await deriveSituation(await tmp(), { blocked: 0, inProgress: 2 }, { paused: false })).key).toBe('building');
    expect((await deriveSituation(await tmp(), { blocked: 0, inProgress: 0 }, { paused: false })).key).toBe('idle');
  });
});

describe('evaluate under paused (AC-C4.3)', () => {
  it('AC-C4.3: refuses ship AND release for any situation key, naming the resume unlock', () => {
    for (const key of ['idle', 'building', 'incident', 'awaiting-decision']) {
      for (const action of ['ship', 'release']) {
        const v = evaluate(key, action, { paused: true, branch: 'hotfix/1-x' });
        expect(v.allowed).toBe(false);
        expect(v.why).toMatch(/paused/);
        expect(v.why).toMatch(/resume/);
      }
    }
    // even a hotfix branch (the incident lane) does not ship while paused
    expect(evaluate('incident', 'ship', { paused: true, branch: 'hotfix/1-x' }).allowed).toBe(false);
  });

  it('AC-C4.3: paused does NOT freeze backend/skill; respond during security-response still proceeds', () => {
    expect(evaluate('idle', 'backend', { paused: true }).allowed).toBe(true);
    expect(evaluate('security-response', 'skill', { paused: true, skill: 'respond' }).allowed).toBe(true);
    expect(evaluate('security-response', 'skill', { paused: true, skill: 'investigate' }).allowed).toBe(true);
  });

  it('not paused → the existing situation rules are untouched', () => {
    expect(evaluate('idle', 'ship', { paused: false, branch: 'feat/1-x' }).allowed).toBe(true);
    expect(evaluate('incident', 'ship', { paused: false, branch: 'hotfix/1-x' }).allowed).toBe(true); // hotfix lane still open
    expect(evaluate('incident', 'release', { paused: false }).allowed).toBe(false); // incident still pauses releases
  });
});

describe('runGate wires the real flag (AC-C4.4)', () => {
  it('AC-C4.4: ship/release refused under a paused machine; clearing lets it proceed', async () => {
    const cwd = await tmp();
    const base = await pausedBase();
    const refused = await runGate(cwd, { action: 'ship', branch: 'feat/1-x' }, noop, { controlBase: base });
    expect(refused.allowed).toBe(false);
    expect(refused.paused).toBe(true);
    const rel = await runGate(cwd, { action: 'release' }, noop, { controlBase: base });
    expect(rel.allowed).toBe(false);
    // an unpaused base → the same ship proceeds
    const clear = await runGate(cwd, { action: 'ship', branch: 'feat/1-x' }, noop, { controlBase: await tmp() });
    expect(clear.allowed).toBe(true);
    expect(clear.paused).toBe(false);
  });
});
