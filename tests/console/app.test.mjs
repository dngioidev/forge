import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import { worstGlyph, relativeTime, makeConfirm, typingInProgress, repoCard } from '../../console/web/app.js';

const NOW = Date.parse('2026-07-17T12:00:00Z');

describe('confirm state machine (AC-B6.2)', () => {
  it('AC-B6.2: first arm returns false, second click on the same id confirms, different id re-arms', () => {
    const timers = { set: (fn) => ({ fn }), clear: () => {} };
    const c = makeConfirm(6000, timers);
    expect(c.arm('esc-1')).toBe(false);
    expect(c.armedId()).toBe('esc-1');
    expect(c.arm('esc-1')).toBe(true);   // confirmed
    expect(c.armedId()).toBe(null);      // spent
    expect(c.arm('esc-1')).toBe(false);  // needs re-arming
    expect(c.arm('esc-2')).toBe(false);  // switching targets never confirms
    expect(c.armedId()).toBe('esc-2');
  });

  it('AC-B6.2: auto-disarm fires after the window', () => {
    let tick;
    const c = makeConfirm(6000, { set: (fn) => { tick = fn; return 1; }, clear: () => {} });
    c.arm('esc-1');
    tick();
    expect(c.armedId()).toBe(null);
  });
});

describe('poll pause (AC-B6.1)', () => {
  const doc = (active, inputs) => ({ activeElement: active, querySelectorAll: () => inputs });
  const idle = makeConfirm(6000, { set: () => 1, clear: () => {} });

  it('AC-B6.1: focused input, dirty input, or an armed confirm all pause the refresh', () => {
    expect(typingInProgress(doc({ tagName: 'INPUT' }, []), idle)).toBe(true);
    expect(typingInProgress(doc(null, [{ value: 'half an answ' }]), idle)).toBe(true);
    const armed = makeConfirm(6000, { set: () => 1, clear: () => {} });
    armed.arm('esc-1');
    expect(typingInProgress(doc(null, []), armed)).toBe(true);
    expect(typingInProgress(doc({ tagName: 'BODY' }, [{ value: '  ' }]), idle)).toBe(false);
  });
});

describe('rendering helpers', () => {
  it('worstGlyph follows the situation priority order (AC-B6.6)', () => {
    expect(worstGlyph([{ situation: 'idle' }, { situation: 'building' }])).toBe('▶');
    expect(worstGlyph([{ situation: 'incident' }, { situation: 'awaiting-decision' }])).toBe('🔥');
    expect(worstGlyph([{ situation: 'security-response' }, { situation: 'incident' }])).toBe('🔒');
    expect(worstGlyph([])).toBe('·');
  });

  it('relativeTime humanizes and never goes negative', () => {
    expect(relativeTime('2026-07-17T11:59:30Z', NOW)).toBe('30s ago');
    expect(relativeTime('2026-07-17T11:15:00Z', NOW)).toBe('45m ago');
    expect(relativeTime('2026-07-17T02:00:00Z', NOW)).toBe('10h ago');
    expect(relativeTime('2026-07-18T00:00:00Z', NOW)).toBe('0s ago');
    expect(relativeTime('garbage', NOW)).toBe('');
  });

  it('repoCard: decision card carries data attrs, errline, escaped content, ledger text equivalent', () => {
    const html = repoCard({
      repo: 'forge', situation: 'awaiting-decision', glyph: '🚩', branch: 'feat/39-x', ticket: '#39',
      ledger: { total: 4, done: 2, inProgress: 1, pending: 1 },
      pendingDecisions: [{ id: 'esc-39', issue: 39, reason: '<b>pick</b>', options: ['a'], ageHours: 0.3 }],
      journalTail: [{ ts: '2026-07-17T11:00:00Z', kind: 'escalation', ticket: '#39' }],
    }, NOW);
    expect(html).toContain('data-decision="esc-39"');
    expect(html).toContain('class="errline" role="alert"');
    expect(html).toContain('&lt;b&gt;pick&lt;/b&gt;');            // reason escaped
    expect(html).toContain('aria-label="tasks: 2 done, 1 in progress of 4"');
    expect(html).toContain('1h ago');
    expect(html).toContain('title="2026-07-17T11:00:00Z"');
    expect(html).not.toContain('<b>pick</b>');
  });
});

describe('page laws in source (AC-B6.3, AC-B6.4)', () => {
  it('AC-B6.3: no alert() anywhere; inline errline is the error surface', async () => {
    const app = await readFile(new URL('../../console/web/app.js', import.meta.url), 'utf8');
    expect(app).not.toMatch(/\balert\s*\(/);
    expect(app).toContain('errlineFor');
    expect(app).toContain('typingInProgress(document, confirm)');
  });

  it('AC-B6.4: focus-visible styles, aria-live stamp, raised dim contrast', async () => {
    const page = await readFile(new URL('../../console/web/index.html', import.meta.url), 'utf8');
    expect(page).toMatch(/:focus-visible\s*\{\s*outline/);
    expect(page).toContain('aria-live="polite"');
    expect(page).not.toContain('#8b949e'); // the borderline dim is gone
    expect(page).toContain('src="/app.js"');
    expect(page).not.toMatch(/src="http|href="http/);
  });
});
