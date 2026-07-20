import { describe, it, expect } from 'vitest';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  parseRouteLinks, routeIndexGaps, addedSkills, skillHandbookGaps, runDocSync,
} from '../../plugin/scripts/gates/docsync.mjs';

describe('doc-sync gate (#136)', () => {
  it('parseRouteLinks extracts relative .md links, skipping http + anchors', () => {
    const idx = '- [A](specs/a.md) x [B](./guides/b.md#top) y [ext](https://x.com/z.md) z [C](decisions/c.md)';
    const links = parseRouteLinks(idx);
    expect([...links].sort()).toEqual(['decisions/c.md', 'guides/b.md', 'specs/a.md']);
    expect(links.has('z.md')).toBe(false); // the http link is not indexed
  });

  it('routeIndexGaps flags unindexed docs and never flags README.md itself', () => {
    const docs = ['README.md', 'specs/a.md', 'specs/b.md', 'guides/h.md'];
    const linked = new Set(['specs/a.md', 'guides/h.md']);
    expect(routeIndexGaps(docs, linked)).toEqual(['specs/b.md']);
  });

  it('addedSkills pulls skill names from added SKILL.md paths only', () => {
    const added = [
      'plugin/skills/autopilot/SKILL.md',
      'plugin/skills/deliver/SKILL.md',
      'plugin/scripts/gates/docsync.mjs', // not a skill
      'plugin/skills/autopilot/notes.md',  // not a SKILL.md
    ];
    expect(addedSkills(added)).toEqual(['autopilot', 'deliver']);
  });

  it('skillHandbookGaps flags added skills the handbook never mentions', () => {
    const handbook = 'The forge:deliver skill runs plan→ship...';
    expect(skillHandbookGaps(['deliver', 'autopilot'], handbook)).toEqual(['autopilot']);
    expect(skillHandbookGaps(['deliver'], handbook)).toEqual([]);
  });

  it('runDocSync is RED on an unindexed doc + an undocumented new skill, GREEN once fixed', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'forge-docsync-'));
    await mkdir(join(cwd, 'docs', 'specs'), { recursive: true });
    await mkdir(join(cwd, 'docs', 'guides'), { recursive: true });
    await writeFile(join(cwd, 'docs', 'specs', 'a.md'), '# A');
    await writeFile(join(cwd, 'docs', 'specs', 'b.md'), '# B'); // will be unindexed at first
    await writeFile(join(cwd, 'docs', 'guides', 'handbook.md'), 'forge:deliver exists.');

    // git diff --diff-filter=A returns a newly-added skill
    const execFn = async () => ({ ok: true, stdout: 'plugin/skills/newskill/SKILL.md\n', stderr: '' });

    // route index links only a.md; handbook lacks 'newskill' → two gaps
    await writeFile(join(cwd, 'docs', 'README.md'), '# index\n- [A](specs/a.md)\n- [H](guides/handbook.md)\n');
    const red = await runDocSync({ cwd, execFn, log: () => {} });
    expect(red.ok).toBe(false);
    expect(red.routeGaps).toContain('specs/b.md');
    expect(red.skillGaps).toContain('newskill');

    // fix both: index b.md, mention the skill in the handbook
    await writeFile(join(cwd, 'docs', 'README.md'), '# index\n- [A](specs/a.md)\n- [B](specs/b.md)\n- [H](guides/handbook.md)\n');
    await writeFile(join(cwd, 'docs', 'guides', 'handbook.md'), 'forge:deliver and forge:newskill exist.');
    const green = await runDocSync({ cwd, execFn, log: () => {} });
    expect(green.ok).toBe(true);
    expect(green.routeGaps).toEqual([]);
    expect(green.skillGaps).toEqual([]);
  });

  it('runDocSync skips cleanly when there is no route index (nothing to enforce)', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'forge-docsync-none-'));
    const execFn = async () => ({ ok: true, stdout: '', stderr: '' });
    const res = await runDocSync({ cwd, execFn, log: () => {} });
    expect(res).toMatchObject({ ok: true, skipped: true });
  });
});
