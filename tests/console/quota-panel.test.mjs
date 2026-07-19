import { describe, it, expect, afterAll } from 'vitest';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer } from '../../console/serve.mjs';
import { controlPanel } from '../../console/web/app.js';
import { QUOTA_RELPATH } from '../../plugin/scripts/lib/quota.mjs';

const servers = [];
afterAll(() => servers.forEach(({ server }) => server.close()));

async function repoWithQuota(rows) {
  const cwd = await mkdtemp(join(tmpdir(), 'forge-qrepo-'));
  await mkdir(join(cwd, '.forge'), { recursive: true });
  await writeFile(join(cwd, QUOTA_RELPATH), rows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
  return cwd;
}

describe('/api/control/state quota (AC-C8.3)', () => {
  it('AC-C8.3: aggregates quota across repos; sums cost/day; skips repos without data', async () => {
    const base = await mkdtemp(join(tmpdir(), 'forge-qbase-'));
    const r1 = await repoWithQuota([
      { ts: '2026-07-19T08:00:00Z', fiveHour: 20, sevenDay: 30, cost: 0.40 },
      { ts: '2026-07-19T10:00:00Z', fiveHour: 55, sevenDay: 33, cost: 0.90 }, // newest overall
    ]);
    const r2 = await repoWithQuota([{ ts: '2026-07-19T09:00:00Z', fiveHour: 50, sevenDay: 32, cost: 0.25 }]);
    const noData = await mkdtemp(join(tmpdir(), 'forge-qnone-'));

    const started = await startServer({ machineId: 'm', repos: [r1, r2, noData], controlBase: base }, { port: 0 });
    servers.push(started);
    const s = await (await fetch(`http://127.0.0.1:${started.port}/api/control/state`)).json();

    expect(s.quota.count).toBe(3);
    expect(s.quota.latest).toMatchObject({ fiveHour: 55, sevenDay: 33 }); // newest sample overall
    // cost/day = sum of each repo's per-day peak: r1 0.90 + r2 0.25 = 1.15
    const day = s.quota.costByDay.find((d) => d.day === '2026-07-19');
    expect(day.cost).toBeCloseTo(1.15, 5);
  });

  it('AC-C8.3: no captured quota anywhere → count 0, not fatal', async () => {
    const base = await mkdtemp(join(tmpdir(), 'forge-qbase-'));
    const started = await startServer({ machineId: 'm', repos: [await mkdtemp(join(tmpdir(), 'forge-empty-'))], controlBase: base }, { port: 0 });
    servers.push(started);
    const s = await (await fetch(`http://127.0.0.1:${started.port}/api/control/state`)).json();
    expect(s.quota).toMatchObject({ count: 0, latest: null });
  });
});

describe('quota panel render (AC-C8.4)', () => {
  it('AC-C8.4: renders 5h/7d bars + trend + cost/day', () => {
    const html = controlPanel({
      paused: false, queue: [], sessions: [], audit: [], alerts: [],
      quota: { count: 5, latest: { fiveHour: 55, sevenDay: 33, cost: 0.9 }, trend: { fiveHour: 'up', sevenDay: 'flat' }, costByDay: [{ day: '2026-07-19', cost: 1.15 }] },
    });
    expect(html).toMatch(/ccol quota/);
    expect(html).toContain('5h');
    expect(html).toContain('55%');
    expect(html).toContain('↑');           // up trend arrow
    expect(html).toContain('$1.15');
  });

  it('AC-C8.4: no data → the opt-in hint', () => {
    const html = controlPanel({ paused: false, queue: [], sessions: [], audit: [], alerts: [], quota: { count: 0, latest: null, trend: null, costByDay: [] } });
    expect(html).toContain('opt in');
    expect(html).toContain('.forge/quota.capture');
  });
});
