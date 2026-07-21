import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { rollupState, transition, poll as ciPoll } from '../../plugin/scripts/monitors/ci-watch.mjs';
import { newlyResolved } from '../../plugin/scripts/monitors/decisions-watch.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

describe('CI monitor (#151)', () => {
  it('reduces a checks rollup to pass | fail | pending (fail-closed)', () => {
    expect(rollupState([])).toBe('pending');
    expect(rollupState([{ conclusion: 'SUCCESS' }, { conclusion: 'SKIPPED' }])).toBe('pass');
    expect(rollupState([{ conclusion: 'SUCCESS' }, { conclusion: 'FAILURE' }])).toBe('fail');
    expect(rollupState([{ conclusion: 'SUCCESS' }, { status: 'IN_PROGRESS', conclusion: null }])).toBe('pending');
    expect(rollupState([{ state: 'ERROR' }])).toBe('fail');
  });

  it('emits only on a state change', () => {
    expect(transition('pending', 'pending')).toBe(null);
    expect(transition('pending', 'pass')).toBe('pass');
    expect(transition(null, 'fail')).toBe('fail');
  });

  it('poll stays quiet with no PR, and reports the transition when checks land', async () => {
    const quiet = await ciPoll(async () => ({ ok: false }), null);
    expect(quiet.line).toBe(null);
    const gh = async () => ({ ok: true, json: { number: 42, headRefName: 'feat/x', statusCheckRollup: [{ conclusion: 'SUCCESS' }] } });
    const first = await ciPoll(gh, null);
    expect(first.line).toMatch(/CI pass on PR #42 \(feat\/x\)/);
    const second = await ciPoll(gh, first.prev); // unchanged → silent
    expect(second.line).toBe(null);
  });
});

describe('decisions monitor (#151)', () => {
  it('emits a resolved decision once, never a pending one', () => {
    const seen = new Set();
    const decisions = [
      { id: 'a', issue: 1, status: 'pending' },
      { id: 'b', issue: 2, status: 'resolved', answer: 'option 2\nmore' },
    ];
    const fresh = newlyResolved(seen, decisions);
    expect(fresh.map((d) => d.id)).toEqual(['b']);
    fresh.forEach((d) => seen.add(d.id));
    expect(newlyResolved(seen, decisions)).toEqual([]); // already surfaced
  });
});

describe('monitors manifest', () => {
  it('declares the two autopilot watchers with when: on-skill-invoke:autopilot', async () => {
    const arr = JSON.parse(await readFile(join(root, 'plugin', 'monitors', 'monitors.json'), 'utf8'));
    expect(arr).toHaveLength(2);
    for (const m of arr) {
      expect(m.name && m.command && m.description).toBeTruthy();
      expect(m.command).toContain('${CLAUDE_PLUGIN_ROOT}');
      expect(m.when).toBe('on-skill-invoke:autopilot');
    }
    expect(arr.map((m) => m.name).sort()).toEqual(['forge-ci', 'forge-decisions']);
  });
});
