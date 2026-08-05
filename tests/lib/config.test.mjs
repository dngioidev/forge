import { describe, it, expect } from 'vitest';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateConfig, loadConfig, normalizeRunner, RUNNER_DEFAULTS } from '../../plugin/scripts/lib/config.mjs';

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

  it('AC-114.4: an optional phase field is allowed when absent, validated when present (#114)', () => {
    expect(validateConfig(validCfg()).ok).toBe(true); // absent → fine

    const ok = validCfg();
    ok.board.fields.phase = { id: 'PVTSSF_ph', options: { alpha: 'p1' } };
    expect(validateConfig(ok)).toEqual({ ok: true, errors: [] }); // present + valid → fine

    const bad = validCfg();
    bad.board.fields.phase = { id: 'wrong', options: {} };
    const r = validateConfig(bad);
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.includes('board.fields.phase.id'))).toBe(true);
    expect(r.errors.some((e) => e.includes('board.fields.phase.options'))).toBe(true);
  });

  it('#176: readiness.acHeadings is optional, validated as a string array when present', () => {
    expect(validateConfig(validCfg()).ok).toBe(true); // absent → fine

    const ok = validCfg();
    ok.readiness = { acHeadings: ['Tiêu chí nghiệm thu', 'Definition of Done'] };
    expect(validateConfig(ok)).toEqual({ ok: true, errors: [] });

    const badType = validCfg();
    badType.readiness = { acHeadings: 'Acceptance' };
    expect(validateConfig(badType).errors.some((e) => e.includes('readiness.acHeadings'))).toBe(true);

    const badEntry = validCfg();
    badEntry.readiness = { acHeadings: ['ok', ''] };
    expect(validateConfig(badEntry).errors.some((e) => e.includes('readiness.acHeadings[1]'))).toBe(true);

    const badBlock = validCfg();
    badBlock.readiness = [];
    expect(validateConfig(badBlock).errors.some((e) => e.includes('readiness: must be an object'))).toBe(true);
  });

  it('requires at least one maintainer when team.members present', () => {
    const cfg = validCfg();
    cfg.team.members = [{ github: 'alice', roles: ['developer'] }];
    const r = validateConfig(cfg);
    expect(r.errors.some((e) => e.includes('maintainer'))).toBe(true);
  });

  // ADR-0005 #226/AC5 — the optional `runner` block.
  it('AC5: accepts an absent runner block (runner off is the default)', () => {
    expect(validateConfig(validCfg()).ok).toBe(true);
  });

  it('AC5: accepts a well-formed runner block', () => {
    const cfg = validCfg();
    cfg.runner = {
      enabled: true,
      labels: ['self-hosted', 'linux', 'forge-local'],
      sharing: 'repo',
      windows: 'native',
      advancedCi: { linuxMatrix: true, deploySmoke: false, nightly: true },
    };
    expect(validateConfig(cfg)).toEqual({ ok: true, errors: [] });
  });

  it('AC5: rejects malformed runner values (enabled, sharing, windows, labels)', () => {
    const cfg = validCfg();
    cfg.runner = { enabled: 'yes', sharing: 'enterprise', windows: 'linux', labels: ['ok', ''] };
    const r = validateConfig(cfg);
    expect(r.ok).toBe(false);
    expect(r.errors).toContain('runner.enabled: must be a boolean');
    expect(r.errors).toContain('runner.sharing: must be "repo" or "org"');
    expect(r.errors).toContain('runner.windows: must be "native" or "hosted"');
    expect(r.errors.some((e) => e.includes('runner.labels[1]'))).toBe(true);
  });

  it('AC5: rejects a non-object runner block and an empty labels array', () => {
    const asArray = validCfg(); asArray.runner = [];
    expect(validateConfig(asArray).errors).toContain('runner: must be an object');

    const emptyLabels = validCfg(); emptyLabels.runner = { labels: [] };
    expect(validateConfig(emptyLabels).errors).toContain('runner.labels: must be a non-empty array of label strings');
  });

  it('AC5: rejects unknown / non-boolean advancedCi toggles', () => {
    const unknown = validCfg(); unknown.runner = { advancedCi: { linuxMatrix: true, bogus: true } };
    expect(validateConfig(unknown).errors.some((e) => e.includes('runner.advancedCi.bogus'))).toBe(true);

    const nonBool = validCfg(); nonBool.runner = { advancedCi: { nightly: 'on' } };
    expect(validateConfig(nonBool).errors).toContain('runner.advancedCi.nightly: must be a boolean');

    const notObj = validCfg(); notObj.runner = { advancedCi: [] };
    expect(validateConfig(notObj).errors).toContain('runner.advancedCi: must be an object');
  });

  // #378 — the optional `autopilot.sessionPauseThresholdPct` field (self-pause
  // near the 5h session usage window). Absent means opt-in not taken (AC.4).
  it('#378 AC.4: accepts an absent autopilot block (opt-in not taken, unchanged behavior)', () => {
    expect(validateConfig(validCfg()).ok).toBe(true);
  });

  it('#378 AC.2: accepts a well-formed autopilot.sessionPauseThresholdPct', () => {
    const cfg = validCfg();
    cfg.autopilot = { sessionPauseThresholdPct: 90 };
    expect(validateConfig(cfg)).toEqual({ ok: true, errors: [] });
  });

  it('#378: rejects a non-object autopilot block', () => {
    const cfg = validCfg(); cfg.autopilot = [];
    expect(validateConfig(cfg).errors).toContain('autopilot: must be an object');
  });

  it('#378: rejects a non-numeric or out-of-range sessionPauseThresholdPct', () => {
    for (const bad of ['90', 0, -1, 101, NaN, null]) {
      const cfg = validCfg(); cfg.autopilot = { sessionPauseThresholdPct: bad };
      expect(validateConfig(cfg).errors).toContain('autopilot.sessionPauseThresholdPct: must be a number between 0 and 100');
    }
  });
});

describe('normalizeRunner (#226/AC5 defaults)', () => {
  it('applies the documented defaults for an absent block', () => {
    expect(normalizeRunner(undefined)).toEqual({
      enabled: false,
      labels: ['self-hosted', 'linux', 'forge-local'],
      sharing: 'repo',
      windows: 'native',
      advancedCi: { linuxMatrix: false, deploySmoke: false, nightly: false },
    });
    expect(RUNNER_DEFAULTS.sharing).toBe('repo');
    expect(RUNNER_DEFAULTS.windows).toBe('native');
  });

  it('fills only the omitted fields, preserving provided valid ones', () => {
    const out = normalizeRunner({ enabled: true, sharing: 'org' });
    expect(out.enabled).toBe(true);
    expect(out.sharing).toBe('org');
    expect(out.windows).toBe('native'); // default: native, hosted-fallback
    expect(out.labels).toEqual(['self-hosted', 'linux', 'forge-local']);
  });

  it('normalizes malformed values back to defaults defensively', () => {
    const out = normalizeRunner({ enabled: 'yes', sharing: 'nope', windows: 42, labels: 'not-array' });
    expect(out).toEqual({
      enabled: false,
      labels: ['self-hosted', 'linux', 'forge-local'],
      sharing: 'repo',
      windows: 'native',
      advancedCi: { linuxMatrix: false, deploySmoke: false, nightly: false },
    });
  });

  it('does not alias the default labels array (no shared mutable state)', () => {
    const a = normalizeRunner(undefined);
    a.labels.push('mutated');
    expect(normalizeRunner(undefined).labels).toEqual(['self-hosted', 'linux', 'forge-local']);
    expect(RUNNER_DEFAULTS.labels).toEqual(['self-hosted', 'linux', 'forge-local']);
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

  it('AC5: exposes a normalized runner block with defaults when absent', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'forge-cfg-'));
    await mkdir(join(dir, '.claude'), { recursive: true });
    await writeFile(join(dir, '.claude', 'forge.json'), JSON.stringify(validCfg()), 'utf8');
    const r = await loadConfig(dir);
    expect(r.ok).toBe(true);
    expect(r.runner).toEqual({
      enabled: false,
      labels: ['self-hosted', 'linux', 'forge-local'],
      sharing: 'repo',
      windows: 'native',
      advancedCi: { linuxMatrix: false, deploySmoke: false, nightly: false },
    });
  });

  it('AC5: applies documented defaults over a partial runner block on load', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'forge-cfg-'));
    await mkdir(join(dir, '.claude'), { recursive: true });
    const cfg = validCfg();
    cfg.runner = { enabled: true, sharing: 'org' };
    await writeFile(join(dir, '.claude', 'forge.json'), JSON.stringify(cfg), 'utf8');
    const r = await loadConfig(dir);
    expect(r.ok).toBe(true);
    expect(r.runner).toMatchObject({ enabled: true, sharing: 'org', windows: 'native', labels: ['self-hosted', 'linux', 'forge-local'] });
  });
});
