import { describe, it, expect, afterAll } from 'vitest';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from 'node:http';
import { startServer } from '../../console/serve.mjs';
import { deriveAlerts, ALERT_KINDS } from '../../console/lib/alerts.mjs';
import { notify, balloonScript } from '../../console/lib/toast.mjs';
import { controlPanel } from '../../console/web/app.js';
import * as machine from '../../control/lib/machine.mjs';

const NOW = Date.parse('2026-07-19T12:00:00Z');
const ago = (ms) => new Date(NOW - ms).toISOString();
const servers = [];
afterAll(() => servers.forEach(({ server }) => server.close()));

describe('deriveAlerts (AC-C7.1)', () => {
  it('AC-C7.1: failure-kind journal events become alerts; non-failures do not; stable ids', () => {
    const repos = [{ repo: 'forge', journalTail: [
      { ts: ago(60_000), kind: 'gate-fail', gate: 'plandrift', ticket: '#5' },
      { ts: ago(120_000), kind: 'auto-approve' },       // not a failure kind → ignored
      { ts: ago(180_000), kind: 'incident', ticket: '#9' },
    ] }];
    const a = deriveAlerts({ repos, sessions: [], now: NOW });
    expect(a).toHaveLength(2);
    expect(a.map((x) => x.kind)).toEqual(['gate-fail', 'incident']); // newest-first
    expect(a[0].id).toBe(`forge:gate-fail:${ago(60_000)}`);          // stable id
    expect(a.find((x) => x.kind === 'incident').severity).toBe('high');
    expect(ALERT_KINDS).toContain('backend-fallback');
  });

  it('AC-C7.1: stale alive session alerts; fresh / dead sessions do not; window drops old events', () => {
    const sessions = [
      { id: 's-stale', state: 'alive', repo: 'forge', ticket: 66, lastHeartbeat: ago(10 * 60_000) },
      { id: 's-fresh', state: 'alive', repo: 'forge', lastHeartbeat: ago(30_000) },
      { id: 's-dead', state: 'dead', repo: 'forge', lastHeartbeat: ago(60 * 60_000) },
    ];
    const a = deriveAlerts({ repos: [], sessions, now: NOW, staleMs: 5 * 60_000 });
    expect(a.map((x) => x.id)).toEqual(['session:s-stale:stale']);
    // an event older than the window is dropped
    const old = deriveAlerts({ repos: [{ repo: 'r', journalTail: [{ ts: ago(48 * 3_600_000), kind: 'cmd-fail' }] }], now: NOW, windowMs: 24 * 3_600_000 });
    expect(old).toHaveLength(0);
  });

  it('AC-C7.1: partial / empty input never throws', () => {
    expect(deriveAlerts()).toEqual([]);
    expect(() => deriveAlerts({ repos: [{}], sessions: [null] })).not.toThrow();
  });
});

describe('toast (AC-C7.3)', () => {
  it('AC-C7.3: disabled → no-op; wrong platform → no-op; enabled+win32 → exactly one spawn; errors swallowed', () => {
    const calls = [];
    const spawnFn = (...args) => { calls.push(args); return { unref() {} }; };
    expect(notify('t', 'b', { enabled: false, spawnFn }).fired).toBe(false);
    expect(notify('t', 'b', { enabled: true, spawnFn, platform: 'linux' }).fired).toBe(false);
    expect(calls).toHaveLength(0);
    const r = notify('t', 'b', { enabled: true, spawnFn, platform: 'win32' });
    expect(r.fired).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0][0]).toBe('powershell');
    // a throwing spawn is swallowed, never propagates
    const bad = notify('t', 'b', { enabled: true, platform: 'win32', spawnFn: () => { throw new Error('no ps'); } });
    expect(bad.fired).toBe(false);
    expect(bad.reason).toMatch(/no ps/);
  });

  it('balloonScript escapes single quotes (no injection through title/body)', () => {
    expect(balloonScript("it's", "a'b")).toContain("''");
    expect(balloonScript('x', 'y')).toContain('ShowBalloonTip');
  });
});

describe('/api/control/state alerts + toast dedup (AC-C7.2, AC-C7.3)', () => {
  async function seeded() {
    const base = await mkdtemp(join(tmpdir(), 'forge-alert-'));
    // a stale alive session → one alert. Heartbeat is relative to the REAL clock
    // because the server derives alerts with Date.now() (not the test's fixed NOW).
    await machine.registerSession(base, { id: 's-hung', repo: 'forge', ticket: 66 });
    await machine.updateSession(base, 's-hung', { lastHeartbeat: new Date(Date.now() - 30 * 60_000).toISOString() });
    // a repo with a failure journal event
    const repo = await mkdtemp(join(tmpdir(), 'forge-alertrepo-'));
    await mkdir(join(repo, '.forge'), { recursive: true });
    await writeFile(join(repo, '.forge', 'journal.jsonl'), JSON.stringify({ ts: new Date().toISOString(), kind: 'gate-fail', gate: 'acgate', ticket: '#5' }) + '\n', 'utf8');
    return { base, repo };
  }

  it('AC-C7.2: alerts feed present; Host guard applies; AC-C7.3: one toast per new id', async () => {
    const { base, repo } = await seeded();
    const toasts = [];
    const config = { machineId: 'm', repos: [repo], controlBase: base, toastEnabled: true, toastPlatform: 'win32', toastSpawn: (...a) => { toasts.push(a); return { unref() {} }; } };
    const started = await startServer(config, { port: 0 });
    servers.push(started);
    const url = `http://127.0.0.1:${started.port}`;

    const s = await (await fetch(`${url}/api/control/state`)).json();
    expect(Array.isArray(s.alerts)).toBe(true);
    expect(s.alerts.some((a) => a.kind === 'stale-session')).toBe(true);
    expect(s.alerts.some((a) => a.kind === 'gate-fail')).toBe(true);
    const firstCount = toasts.length;
    expect(firstCount).toBeGreaterThanOrEqual(1);
    // a second poll must NOT re-toast the same alert ids
    await (await fetch(`${url}/api/control/state`)).json();
    expect(toasts.length).toBe(firstCount);

    // Host guard still applies to the control state
    const status = await new Promise((res, rej) => {
      const r = request(`${url}/api/control/state`, { headers: { Host: 'evil.example' } }, (rs) => { rs.resume(); res(rs.statusCode); });
      r.on('error', rej); r.end();
    });
    expect(status).toBe(403);
  });
});

describe('control tab alert banner (AC-C7.4)', () => {
  it('AC-C7.4: banner + feed when alerts present; none → no banner', () => {
    const withAlerts = controlPanel({ paused: false, queue: [], sessions: [], audit: [], alerts: [
      { id: 'a1', kind: 'gate-fail', repo: 'forge', ticket: '#5', severity: 'warn', message: 'gate-fail (acgate) in forge #5' },
    ] });
    expect(withAlerts).toContain('cbanner alert');
    expect(withAlerts).toContain('🔴');
    expect(withAlerts).toMatch(/ccol alerts/);
    expect(withAlerts).toContain('gate-fail');

    const none = controlPanel({ paused: false, queue: [], sessions: [], audit: [], alerts: [] });
    expect(none).not.toContain('cbanner alert');
    expect(none).not.toContain('🔴');
  });
});
