import { describe, it, expect } from 'vitest';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateConfig, loadConfig } from '../../plugin/scripts/lib/config.mjs';

function validCfg() {
  return {
    board: {
      projectNumber: 8,
      projectId: 'PVT_kwHOCkJQ784BdZrh',
      fields: {
        status: { id: 'PVTSSF_a', options: { backlog: '1', inProgress: '2', done: '3' } },
        priority: { id: 'PVTSSF_b', options: { p0: '1', p1: '2', p2: '3' } },
        size: { id: 'PVTSSF_c', options: { s: '1', m: '2' } },
        type: { id: 'PVTSSF_d', options: { epic: '1', item: '2' } },
      },
    },
    conventions: { verify: 'pnpm verify' },
    features: { graph: true },
    team: { members: [{ github: 'dngioidev', roles: ['maintainer'] }] },
  };
}

describe('validateConfig', () => {
  it('accepts a complete valid config', () => {
    expect(validateConfig(validCfg())).toEqual({ ok: true, errors: [] });
  });

  it('AC-1.4: rejects a non-object root', () => {
    expect(validateConfig([]).ok).toBe(false);
    expect(validateConfig(null).ok).toBe(false);
  });

  it('AC-1.4: flags missing board block and bad ids', () => {
    const noBoard = validateConfig({});
    expect(noBoard.errors).toContain('board: missing block');

    const cfg = validCfg();
    cfg.board.projectId = 'nope';
    cfg.board.fields.status.id = 'wrong';
    const r = validateConfig(cfg);
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.includes('board.projectId'))).toBe(true);
    expect(r.errors.some((e) => e.includes('board.fields.status.id'))).toBe(true);
  });

  it('AC-1.4: flags every missing field key, not just the first', () => {
    const cfg = validCfg();
    delete cfg.board.fields.priority;
    delete cfg.board.fields.type;
    const r = validateConfig(cfg);
    expect(r.errors).toContain('board.fields.priority: missing');
    expect(r.errors).toContain('board.fields.type: missing');
  });

  it('flags empty options and non-boolean features', () => {
    const cfg = validCfg();
    cfg.board.fields.size.options = {};
    cfg.features.graph = 'yes';
    const r = validateConfig(cfg);
    expect(r.errors.some((e) => e.includes('size.options'))).toBe(true);
    expect(r.errors.some((e) => e.includes('features.graph'))).toBe(true);
  });

  it('requires at least one maintainer when team.members present', () => {
    const cfg = validCfg();
    cfg.team.members = [{ github: 'alice', roles: ['developer'] }];
    const r = validateConfig(cfg);
    expect(r.errors.some((e) => e.includes('maintainer'))).toBe(true);
  });
});

describe('loadConfig', () => {
  it('AC-1.4: distinct errors for missing file vs broken JSON', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'forge-cfg-'));
    const missing = await loadConfig(dir);
    expect(missing.missing).toBe(true);
    expect(missing.errors[0]).toContain('/forge:init');

    await mkdir(join(dir, '.claude'), { recursive: true });
    await writeFile(join(dir, '.claude', 'forge.json'), '{ not json', 'utf8');
    const broken = await loadConfig(dir);
    expect(broken.missing).toBe(false);
    expect(broken.ok).toBe(false);
    expect(broken.errors[0]).toContain('not valid JSON');
  });

  it('loads and validates the real committed forge.json shape', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'forge-cfg-'));
    await mkdir(join(dir, '.claude'), { recursive: true });
    await writeFile(join(dir, '.claude', 'forge.json'), JSON.stringify(validCfg()), 'utf8');
    const r = await loadConfig(dir);
    expect(r.ok).toBe(true);
    expect(r.config.board.projectNumber).toBe(8);
  });
});
