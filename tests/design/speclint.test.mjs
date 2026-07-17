import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { lintSpec, MANDATORY_SECTIONS } from '../../plugin/scripts/design/speclint.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

function completeSpec() {
  return [
    '# Visual spec — Button (#15)',
    '## Summary', 'A button.',
    '## States matrix',
    '| state | normal content | long content | extreme content |',
    '| --- | --- | --- | --- |',
    ...['default', 'hover', 'focus', 'active', 'disabled', 'loading', 'empty', 'error'].map((s) => `| ${s} | ok | ok | ok |`),
    '## Breakpoints', '375 / 768 / 1280.',
    '## Themes', 'light + dark via tokens.',
    '## A11y contract', '- Focus order: natural',
    '## Motion', '| el | prop | duration | easing | reduced |',
    '## Token delta', '- Tokens used: color.accent (#aabbcc is fine here)',
  ].join('\n');
}

describe('speclint (AC-6.5)', () => {
  it('the shipped template itself passes the lint', async () => {
    const tpl = await readFile(join(root, 'plugin', 'templates', 'visual-spec.md'), 'utf8');
    const res = lintSpec(tpl);
    expect(res.problems).toEqual([]);
  });

  it('a complete spec passes', () => {
    expect(lintSpec(completeSpec())).toMatchObject({ ok: true, problems: [] });
  });

  it('names each missing section', () => {
    const res = lintSpec('# Visual spec\n## Summary\nwords\n## Themes\nok');
    expect(res.ok).toBe(false);
    for (const s of MANDATORY_SECTIONS.filter((s) => s !== 'Themes')) {
      expect(res.problems.some((p) => p.includes(s)), s).toBe(true);
    }
  });

  it('names missing states-matrix rows', () => {
    const spec = completeSpec().replace('| loading | ok | ok | ok |\n', '');
    const res = lintSpec(spec);
    expect(res.problems).toContain('states matrix missing row: loading');
  });

  it('token governance: raw hex outside Token delta is a one-off finding; inside is fine', () => {
    const bad = completeSpec().replace('375 / 768 / 1280.', 'border color #ff0000 at 375.');
    const res = lintSpec(bad);
    expect(res.problems.some((p) => p.includes('#ff0000'))).toBe(true);
    expect(lintSpec(completeSpec()).ok).toBe(true); // hex inside Token delta allowed
  });
});
