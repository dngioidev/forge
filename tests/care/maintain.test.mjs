import { describe, it, expect } from 'vitest';
import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  parseSemver, classifyBump, scanOutdated, planBatch, renderPlan,
  triageAlerts, fetchAlerts, SLA_HOURS,
} from '../../plugin/scripts/care/maintain.mjs';
import { fakeGh } from '../helpers/fakegh.mjs';

const NOW = Date.parse('2026-07-17T12:00:00Z');

describe('outdated classification (AC-11.1)', () => {
  it('AC-11.1: patch/minor/major from semver distance; current and weird versions -> null', () => {
    expect(classifyBump('1.2.3', '1.2.4')).toBe('patch');
    expect(classifyBump('1.2.3', '1.3.0')).toBe('minor');
    expect(classifyBump('1.2.3', '2.0.0')).toBe('major');
    expect(classifyBump('1.2.3', '1.2.3')).toBe(null);
    expect(classifyBump('2.0.0', '1.9.9')).toBe(null); // downgrade is not a bump
    expect(classifyBump('workspace:*', '1.0.0')).toBe(null);
    expect(parseSemver('v3.2.4')).toEqual({ major: 3, minor: 2, patch: 4 });
  });

  it('AC-11.1: scan reads ranges, tolerates registry misses, refuses non-npm repos', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'forge-mnt-'));
    await writeFile(join(dir, 'package.json'), JSON.stringify({
      dependencies: { alpha: '^1.0.0' },
      devDependencies: { beta: '~2.1.0', ghost: '1.0.0' },
    }), 'utf8');
    const fetchFn = async (url) => {
      if (url.includes('ghost')) return { ok: false, status: 404 };
      if (url.includes('alpha')) return { ok: true, json: async () => ({ version: '1.4.0' }) };
      return { ok: true, json: async () => ({ version: '2.1.9' }) };
    };
    const res = await scanOutdated(dir, fetchFn);
    expect(res.ok).toBe(true);
    expect(res.results.find((r) => r.name === 'alpha')).toMatchObject({ current: '1.0.0', latest: '1.4.0', bump: 'minor' });
    expect(res.results.find((r) => r.name === 'beta').bump).toBe('patch');
    expect(res.results.find((r) => r.name === 'ghost')).toMatchObject({ bump: null, note: 'registry 404' });

    const empty = await scanOutdated(await mkdtemp(join(tmpdir(), 'forge-mnt2-')));
    expect(empty.ok).toBe(false);
    expect(empty.error).toMatch(/npm-family/);
  });
});

describe('batch plan (AC-11.2)', () => {
  const results = [
    { name: 'a', current: '1.0.0', latest: '1.0.9', bump: 'patch' },
    { name: 'b', current: '1.0.0', latest: '1.2.0', bump: 'minor' },
    { name: 'c', current: '1.0.0', latest: '3.0.0', bump: 'major' },
    { name: 'd', current: '2.0.0', latest: '2.0.0', bump: null },
    { name: 'e', current: '1.0.0', latest: null, bump: null, note: 'registry 404' },
  ];

  it('AC-11.2: patch+minor in one batch; majors only in the coordinated list — never both', () => {
    const plan = planBatch(results, '2026-07-17');
    expect(plan.batch.branch).toBe('chore/dep-batch-2026-07-17');
    expect(plan.batch.bumps.map((b) => b.name)).toEqual(['a', 'b']);
    expect(plan.majors.bumps.map((m) => m.name)).toEqual(['c']);
    expect(plan.majors.ritual).toMatch(/never merged individually/);
    expect(plan.current).toBe(1);
    expect(plan.unresolvable).toEqual([{ name: 'e', note: 'registry 404' }]);

    const out = renderPlan(plan);
    expect(out).toContain('Batch (2)');
    expect(out).toContain('Majors (1) — one coordinated ticket');
    expect(out).not.toMatch(/Batch.*\n.*- c /); // the major never leaks into the batch section
  });

  it('all-current renders the clean message', () => {
    expect(renderPlan(planBatch([{ name: 'd', current: '1.0.0', latest: '1.0.0', bump: null }], 'x'))).toContain('everything current');
  });
});

describe('CVE triage (AC-11.3)', () => {
  const alert = (n, severity, createdAt, state = 'open') => ({
    number: n, state, created_at: createdAt,
    dependency: { package: { name: `pkg${n}` } },
    security_advisory: { severity, summary: `advisory ${n}` },
  });

  it('AC-11.3: SLA deadlines from the alert createdAt; overdue first, then severity', () => {
    const triaged = triageAlerts([
      alert(1, 'low', '2026-07-17T00:00:00Z'),
      alert(2, 'critical', '2026-07-15T00:00:00Z'),   // 24h SLA -> overdue
      alert(3, 'high', '2026-07-17T00:00:00Z'),        // due 2026-07-20
      alert(4, 'critical', '2026-07-17T11:00:00Z'),    // due tomorrow, not overdue
      alert(5, 'high', '2026-07-01T00:00:00Z', 'fixed'), // closed — excluded
    ], NOW);
    expect(triaged.map((t) => t.number)).toEqual([2, 4, 3, 1]);
    expect(triaged[0]).toMatchObject({ overdue: true, deadline: '2026-07-16T00:00:00.000Z', sla: '24h' });
    expect(triaged.find((t) => t.number === 3).deadline).toBe('2026-07-20T00:00:00.000Z');
    expect(triaged.find((t) => t.number === 1)).toMatchObject({ deadline: null, sla: 'next maintain run' });
    expect(SLA_HOURS).toEqual({ critical: 24, high: 72, medium: 168, low: null });
  });

  it('AC-11.3: disabled alerts respond with the enable hint, not a crash', async () => {
    const { gh } = fakeGh([[(j) => j.includes('dependabot/alerts'), { ok: false, stderr: 'HTTP 403: Dependabot alerts are disabled for this repository' }]]);
    const res = await fetchAlerts(gh, 'o', 'r');
    expect(res.ok).toBe(false);
    expect(res.disabled).toBe(true);
    expect(res.error).toMatch(/Settings/);
  });
});

describe('skill carries the laws (AC-11.4)', () => {
  it('AC-11.4: batch+one-PR, majors never individual, SLA table', async () => {
    const skill = await readFile(new URL('../../plugin/skills/maintain/SKILL.md', import.meta.url), 'utf8');
    expect(skill).toMatch(/one PR/i);
    expect(skill).toMatch(/never merged individually/i);
    expect(skill).toMatch(/\| critical \| 24h/);
    expect(skill).toMatch(/batched routine work, not a PR queue/i);
  });
});
