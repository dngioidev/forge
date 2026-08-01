import { describe, it, expect } from 'vitest';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  parseRouteLinks, routeIndexGaps, addedSkills, skillHandbookGaps, runDocSync,
  parseBadgeVersion, badgeVersionDrift,
} from '../../plugin/scripts/gates/docsync.mjs';

const badgeLine = (v) => `[![version](https://img.shields.io/badge/version-${v}-blue.svg)](CHANGELOG.md)`;

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

describe('doc-sync gate: README version badge vs package.json (#309)', () => {
  it('parseBadgeVersion / badgeVersionDrift compare the badge to the source-of-truth version', () => {
    expect(parseBadgeVersion(badgeLine('0.18.0'))).toBe('0.18.0');
    expect(parseBadgeVersion('# no badge here')).toBeNull();
    // in sync → no drift
    expect(badgeVersionDrift(badgeLine('0.18.0'), '0.18.0')).toBeNull();
    // drifted → the mismatch is reported (package.json is the source of truth)
    expect(badgeVersionDrift(badgeLine('0.16.0'), '0.18.0')).toEqual({ badge: '0.16.0', pkg: '0.18.0' });
    // no badge to guard → never a false positive
    expect(badgeVersionDrift('# no badge here', '0.18.0')).toBeNull();
  });

  // Build a minimal repo tree so runDocSync exercises the real gate end-to-end:
  // root README.md + package.json + a clean docs/README.md route index.
  async function scaffold({ badgeVersion, pkgVersion }) {
    const cwd = await mkdtemp(join(tmpdir(), 'forge-docsync-badge-'));
    await mkdir(join(cwd, 'docs'), { recursive: true });
    await writeFile(join(cwd, 'README.md'), `# forge\n${badgeLine(badgeVersion)}\n`);
    await writeFile(join(cwd, 'package.json'), JSON.stringify({ version: pkgVersion }));
    await writeFile(join(cwd, 'docs', 'README.md'), '# index\n'); // no docs → no route gaps
    return cwd;
  }
  const noAdds = async () => ({ ok: true, stdout: '', stderr: '' });

  it('AC-309.1: runDocSync FAILS when the README badge version drifts from package.json', async () => {
    const cwd = await scaffold({ badgeVersion: '0.16.0', pkgVersion: '0.18.0' });
    const res = await runDocSync({ cwd, execFn: noAdds, log: () => {} });
    expect(res.ok).toBe(false);
    expect(res.badgeDrift).toEqual({ badge: '0.16.0', pkg: '0.18.0' });
    // isolate the badge check: routes/skills are clean, so this failure is the drift
    expect(res.routeGaps).toEqual([]);
    expect(res.skillGaps).toEqual([]);
  });

  it('AC-309.2: runDocSync PASSES when the README badge matches package.json', async () => {
    const cwd = await scaffold({ badgeVersion: '0.18.0', pkgVersion: '0.18.0' });
    const res = await runDocSync({ cwd, execFn: noAdds, log: () => {} });
    expect(res.ok).toBe(true);
    expect(res.badgeDrift).toBeNull();
  });
});
