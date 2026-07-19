import { describe, it, expect } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { captureEnabled, appendQuotaSample, readSamples, summarizeQuota, QUOTA_RELPATH, QUOTA_MARKER } from '../../plugin/scripts/lib/quota.mjs';

const tmp = () => mkdtemp(join(tmpdir(), 'forge-quota-'));
async function enable(cwd) { await mkdir(join(cwd, '.forge'), { recursive: true }); await writeFile(join(cwd, QUOTA_MARKER), '', 'utf8'); }

describe('capture (AC-C8.1)', () => {
  it('AC-C8.1: opt-in — writes only with the marker; numeric-only; no throw on bad dir', async () => {
    const off = await tmp();
    expect((await appendQuotaSample(off, { fiveHour: 10, sevenDay: 20, cost: 0.5 })).wrote).toBe(false); // no marker
    expect(await captureEnabled(off)).toBe(false);
    expect(await readSamples(off)).toEqual([]);

    const on = await tmp();
    await enable(on);
    // pass extra junk fields — only the four numbers may survive
    const r = await appendQuotaSample(on, { fiveHour: 12, sevenDay: 34, cost: 1.25, prompt: 'SECRET TEXT', foo: 'bar' });
    expect(r.wrote).toBe(true);
    const raw = await readFile(join(on, QUOTA_RELPATH), 'utf8');
    expect(raw).not.toContain('SECRET TEXT');
    expect(raw).not.toContain('foo');
    const rec = JSON.parse(raw.trim());
    expect(Object.keys(rec).sort()).toEqual(['cost', 'fiveHour', 'sevenDay', 'ts']);
    expect(rec).toMatchObject({ fiveHour: 12, sevenDay: 34, cost: 1.25 });

    // non-numeric values are stored as null, never text
    await appendQuotaSample(on, { fiveHour: 'lots', sevenDay: undefined, cost: NaN });
    const last = (await readSamples(on)).at(-1);
    expect(last).toMatchObject({ fiveHour: null, sevenDay: null, cost: null });

    // a failing write is silent (returns ok:false, does not throw)
    expect((await appendQuotaSample('Z:/nope/nope', { fiveHour: 1 })).wrote).toBe(false);
  });
});

describe('summarizeQuota (AC-C8.2)', () => {
  it('AC-C8.2: latest + trend vs window start + per-day peak cost', () => {
    const s = [
      { ts: '2026-07-18T09:00:00Z', fiveHour: 10, sevenDay: 30, cost: 0.20 },
      { ts: '2026-07-18T18:00:00Z', fiveHour: 25, sevenDay: 33, cost: 0.55 }, // day peak 0.55
      { ts: '2026-07-19T08:00:00Z', fiveHour: 40, sevenDay: 34, cost: 0.10 },
    ];
    const q = summarizeQuota(s);
    expect(q.count).toBe(3);
    expect(q.latest).toMatchObject({ fiveHour: 40, sevenDay: 34, cost: 0.10 });
    expect(q.trend.fiveHour).toBe('up');   // 40 vs 10
    expect(q.trend.sevenDay).toBe('up');   // 34 vs 30
    expect(q.costByDay).toEqual([{ day: '2026-07-18', cost: 0.55 }, { day: '2026-07-19', cost: 0.10 }]);
  });

  it('AC-C8.2: flat/down trends; empty/partial → count 0, never throws', () => {
    expect(summarizeQuota([{ ts: 't', fiveHour: 50 }, { ts: 't2', fiveHour: 20 }]).trend.fiveHour).toBe('down');
    expect(summarizeQuota([{ ts: 't', fiveHour: 50 }, { ts: 't2', fiveHour: 50 }]).trend.fiveHour).toBe('flat');
    expect(summarizeQuota([])).toEqual({ count: 0, latest: null, trend: null, costByDay: [] });
    expect(() => summarizeQuota(null)).not.toThrow();
    expect(() => summarizeQuota([null, {}])).not.toThrow();
  });
});
