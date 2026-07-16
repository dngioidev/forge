import { describe, it, expect } from 'vitest';
import { extractAcIds, flattenResults, checkAcCoverage } from '../../plugin/scripts/gates/acgate.mjs';

const RESULTS = {
  testResults: [
    { assertionResults: [
      { title: 'AC-7.1: ledger round-trips', fullName: 'ledger > AC-7.1: ledger round-trips', status: 'passed' },
      { title: 'AC-7.2: gate refuses missing acs', fullName: 'gate > AC-7.2: gate refuses missing acs', status: 'failed' },
      { title: 'unrelated test', fullName: 'misc > unrelated test', status: 'passed' },
    ] },
  ],
};

describe('ac gate (AC-5.2)', () => {
  it('extracts AC ids from plan text, optionally scoped to a ticket', () => {
    const plan = '- **AC-7.1** — a\n- **AC-7.2** — b\n**AC map:** AC-7.1, AC-7.2\nAlso mentions AC-3.4 from another epic.';
    expect(extractAcIds(plan, 7).sort()).toEqual(['AC-7.1', 'AC-7.2']);
    expect(extractAcIds(plan)).toContain('AC-3.4');
  });

  it('passes only when every AC id has a passing test; names missing and failing', () => {
    const tests = flattenResults(RESULTS);
    const all = checkAcCoverage(['AC-7.1', 'AC-7.2', 'AC-7.3'], tests);
    expect(all.ok).toBe(false);
    expect(all.failing).toEqual(['AC-7.2']);
    expect(all.missing).toEqual(['AC-7.3']);
    const good = checkAcCoverage(['AC-7.1'], tests);
    expect(good).toMatchObject({ ok: true, covered: 1 });
  });

  it('a failing test with the id does not count as coverage even when another test passes without it', () => {
    const tests = flattenResults(RESULTS);
    expect(checkAcCoverage(['AC-7.2'], tests).ok).toBe(false);
  });
});
