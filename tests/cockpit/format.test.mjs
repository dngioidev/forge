/**
 * Cockpit browser UI (#354) — unit tests for the pure presentation helpers.
 *
 * The browser behaviour (layout, xterm.js, live wiring) is validated by the
 * design-reviewer against the visual spec; what is unit-testable is the
 * DOM-free transform layer in `forge_cockpit/web/format.mjs` — token/cost
 * formatting, the heat-metaphor status mapping, control enable/disable rules,
 * the log-level heuristic (non-colour-only status), and the chart geometry.
 */
import { describe, it, expect } from 'vitest';
import {
  formatTokens, formatCost, classifyRunner, statusLabel, controlsFor,
  logLevelOf, dayKey, sparkPath, actionGerund, clockStamp,
} from '../../tools/runner-ui/forge_cockpit/web/format.mjs';

describe('formatTokens', () => {
  it('compacts millions and thousands', () => {
    expect(formatTokens(3_240_000)).toBe('3.24M');
    expect(formatTokens(5100)).toBe('5.1K');
    expect(formatTokens(2_100_000_000)).toBe('2.10B');
  });
  it('renders small counts and junk as a plain integer / zero', () => {
    expect(formatTokens(42)).toBe('42');
    expect(formatTokens(undefined)).toBe('0');
    expect(formatTokens('nope')).toBe('0');
  });
});

describe('formatCost', () => {
  it('always shows two decimals with a leading $', () => {
    expect(formatCost(14.82)).toBe('$14.82');
    expect(formatCost(0)).toBe('$0.00');
    expect(formatCost(null)).toBe('$0.00');
  });
});

describe('classifyRunner (heat-metaphor mapping)', () => {
  const onlineEntry = { service_state: 'running', target: { known: true }, online: { known: true, online: 2, total: 2 } };
  it('maps a running runner with online GH runners to online', () => {
    expect(classifyRunner(onlineEntry)).toBe('online');
  });
  it('maps a stopped known runner to offline (cold iron)', () => {
    expect(classifyRunner({ service_state: 'stopped', target: { known: true }, online: { known: true, online: 0 } })).toBe('offline');
  });
  it('maps a running orphan (known repo, 0 online) to mis-target — the backend definition', () => {
    expect(classifyRunner({ service_state: 'running', target: { known: true }, online: { known: true, online: 0 } })).toBe('mistarget');
  });
  it('does not mis-target when the online count is unknown (gh error)', () => {
    expect(classifyRunner({ service_state: 'running', target: { known: true }, online: { known: false, online: null } })).toBe('online');
  });
  it('defaults to offline for missing input', () => {
    expect(classifyRunner(null)).toBe('offline');
  });
});

describe('statusLabel — non-colour-only text', () => {
  it('gives a text label for every status', () => {
    expect(statusLabel('online')).toBe('online');
    expect(statusLabel('offline')).toBe('offline');
    expect(statusLabel('mistarget')).toBe('mis-target');
  });
});

describe('controlsFor — states-matrix enable/disable', () => {
  it('disables start when online and stop when offline', () => {
    const online = Object.fromEntries(controlsFor('online').map((c) => [c.action, c.disabled]));
    expect(online.start).toBe(true);
    expect(online.stop).toBe(false);
    expect(online.restart).toBe(false);
    const offline = Object.fromEntries(controlsFor('offline').map((c) => [c.action, c.disabled]));
    expect(offline.start).toBe(false);
    expect(offline.stop).toBe(true);
  });
  it('offers a re-provision control (with a lock glyph) for a mis-target card', () => {
    const actions = controlsFor('mistarget');
    const rep = actions.find((c) => c.action === 'reprovision');
    expect(rep).toBeTruthy();
    expect(rep.glyph).toBeTruthy();
    expect(actions.some((c) => c.action === 'stop')).toBe(true);
  });
});

describe('actionGerund — grammar-correct loading label', () => {
  it('renders the present participle, not naive action+ing', () => {
    expect(actionGerund('stop')).toBe('stopping…');
    expect(actionGerund('restart')).toBe('restarting…');
    expect(actionGerund('reprovision')).toBe('re-provisioning…');
  });
});

describe('clockStamp — zero-padded 24h', () => {
  it('formats HH:MM:SS with leading zeros', () => {
    expect(clockStamp(new Date(2026, 7, 3, 9, 5, 7))).toBe('09:05:07');
    expect(clockStamp(new Date(2026, 7, 3, 23, 41, 0))).toBe('23:41:00');
  });
});

describe('logLevelOf — level is text, not colour-only', () => {
  it('detects error and warn, defaulting to info', () => {
    expect(logLevelOf('provision: target mismatch — ERROR')).toBe('error');
    expect(logLevelOf('gh api rate limit warning')).toBe('warn');
    expect(logLevelOf('fleet scan complete')).toBe('info');
  });
});

describe('dayKey', () => {
  it('formats a Date as YYYY-MM-DD (zero-padded)', () => {
    expect(dayKey(new Date(2026, 7, 3))).toBe('2026-08-03');
  });
});

describe('sparkPath — chart geometry', () => {
  it('returns empty geometry for no data', () => {
    expect(sparkPath([])).toEqual({ line: '', area: '', last: null });
  });
  it('spans the box width and closes the area path', () => {
    const { line, area, last } = sparkPath([1, 2, 3], 700, 170);
    expect(line.startsWith('M0.0,')).toBe(true);
    expect(last.x).toBeCloseTo(700, 0);
    expect(area.trim().endsWith('Z')).toBe(true);
  });
  it('places the peak value at the top of the box', () => {
    const { line } = sparkPath([0, 10], 100, 100, 8);
    // the max sits at y = pad (8); the min near the bottom (height - pad = 92)
    expect(line).toContain('92.0');
    expect(line).toContain('8.0');
  });
});
