import { describe, it, expect } from 'vitest';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { extractReport, validateReport, citeOrDrop } from '../../plugin/scripts/backends/report.mjs';

describe('report contract (AC-4.6)', () => {
  it('extracts the terminal JSON block after a markdown body', () => {
    const text = 'Review summary here.\n\n```json\n{"note":"not the last block"}\n```\n\nMore prose.\n\n```json\n{"verdict":"fail","findings":[{"severity":"major","file":"src/a.mjs","line":3,"summary":"off by one"}]}\n```\n';
    const r = extractReport(text);
    expect(r.ok).toBe(true);
    expect(r.report.verdict).toBe('fail');
    expect(r.body).toContain('Review summary');
  });

  it('flags missing block, broken JSON, bad shapes with distinct errors', () => {
    expect(extractReport('no json here').error).toContain('no terminal JSON block');
    expect(extractReport('```json\n{oops\n```').error).toContain('unparseable');
    expect(validateReport({ verdict: 'maybe', findings: [] }).error).toContain('verdict');
    expect(validateReport({ verdict: 'pass', findings: [{ severity: 'urgent', summary: 'x' }] }).error).toContain('severity');
    expect(validateReport({ verdict: 'pass', findings: [{ severity: 'minor' }] }).error).toContain('summary');
  });

  it('cite-or-drop keeps existing files and file-less findings, drops ghosts', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'forge-report-'));
    await writeFile(join(cwd, 'real.mjs'), 'x', 'utf8');
    const { kept, dropped } = await citeOrDrop(cwd, [
      { severity: 'major', file: 'real.mjs', line: 1, summary: 'real' },
      { severity: 'critical', file: 'hallucinated/ghost.mjs', line: 9, summary: 'ghost' },
      { severity: 'minor', summary: 'no file cited' },
    ]);
    expect(kept.map((f) => f.summary)).toEqual(['real', 'no file cited']);
    expect(dropped[0].summary).toBe('ghost');
  });
});
