import { describe, it, expect } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, readdir, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { signature, clusterEvents, renderReport, archive, ARCHIVE_DIR } from '../../plugin/scripts/learn/distill.mjs';
import { JOURNAL_RELPATH } from '../../plugin/scripts/lib/journal.mjs';

const ev = (kind, extra = {}) => ({ ts: '2026-07-17T00:00:00Z', kind, ...extra });

async function cwdWithJournal(lines) {
  const dir = await mkdtemp(join(tmpdir(), 'forge-distill-'));
  await mkdir(join(dir, '.forge'), { recursive: true });
  await writeFile(join(dir, JOURNAL_RELPATH), lines.map((l) => JSON.stringify(l)).join('\n') + '\n', 'utf8');
  return dir;
}

describe('distill clustering (AC-7.4)', () => {
  it('AC-7.4: repeats cluster by kind+signature and each cluster gets one proposal', () => {
    const events = [
      ev('gate-fail', { gate: 'plandrift', err_line: 'off-plan: src/x.mjs' }),
      ev('gate-fail', { gate: 'plandrift', err_line: 'off-plan: src/y.mjs' }),
      ev('gate-fail', { gate: 'acgate' }),
      ev('cmd-fail', { cmd: 'pnpm verify --run' }),
      ev('cmd-fail', { cmd: 'pnpm verify' }),
      ev('blocked-edit', { rule: 'hard-reset' }),
    ];
    const clusters = clusterEvents(events);
    const plandrift = clusters.find((c) => c.signature === 'plandrift');
    expect(plandrift.count).toBe(2);
    expect(clusters.find((c) => c.signature === 'pnpm verify').count).toBe(2);

    const report = renderReport(clusters);
    expect(report).toContain('gate-fail: plandrift (2×)');
    expect(report).toContain('**Proposal:**');
    expect(report).toContain('off-plan: src/x.mjs');
    // one-offs are listed without a proposal
    expect(report).toContain('One-offs');
    expect(report).toContain('blocked-edit: hard-reset');
  });

  it('AC-7.4: empty journal reports nothing to distill', () => {
    expect(renderReport(clusterEvents([]))).toContain('nothing to distill');
  });

  it('signatures normalize commands to their meaningful head', () => {
    expect(signature(ev('cmd-fail', { cmd: 'PATH=/x git push origin main' }))).toBe('git push');
    expect(signature(ev('cmd-fail', { cmd: 'vitest run --coverage' }))).toBe('vitest');
    expect(signature(ev('escalation', { reason: 'design pick: card' }))).toBe('design pick: card');
  });
});

describe('distill archive (AC-7.5)', () => {
  it('AC-7.5: archive moves the journal and leaves the live journal empty', async () => {
    const dir = await cwdWithJournal([ev('gate-fail', { gate: 'acgate' }), ev('cmd-fail', { cmd: 'x' })]);
    const res = await archive(dir, '2026-07-17');
    expect(res).toMatchObject({ ok: true, count: 2 });
    const archived = await readFile(join(dir, ARCHIVE_DIR, '2026-07-17.jsonl'), 'utf8');
    expect(archived).toContain('acgate');
    await expect(access(join(dir, JOURNAL_RELPATH))).rejects.toThrow();
  });

  it('AC-7.5: same-day re-archive appends instead of clobbering; no journal is a no-op', async () => {
    const dir = await cwdWithJournal([ev('gate-fail', { gate: 'first' })]);
    await archive(dir, '2026-07-17');
    await writeFile(join(dir, JOURNAL_RELPATH), JSON.stringify(ev('gate-fail', { gate: 'second' })) + '\n', 'utf8');
    await archive(dir, '2026-07-17');
    const archived = await readFile(join(dir, ARCHIVE_DIR, '2026-07-17.jsonl'), 'utf8');
    expect(archived).toContain('first');
    expect(archived).toContain('second');
    expect((await readdir(join(dir, ARCHIVE_DIR))).length).toBe(1);

    const noop = await archive(dir, '2026-07-18');
    expect(noop).toMatchObject({ ok: true, archived: null, count: 0 });
  });
});

describe('/distill human-approval law (AC-7.7)', () => {
  it('AC-7.7: skill and command state the law — per-proposal approval, lessons as PR, never auto-run', async () => {
    const skill = await readFile(new URL('../../plugin/skills/distill/SKILL.md', import.meta.url), 'utf8');
    const command = await readFile(new URL('../../plugin/commands/distill.md', import.meta.url), 'utf8');
    expect(skill).toMatch(/maintainer approves each proposal individually/i);
    expect(skill).toMatch(/land as a PR/i);
    expect(skill).toMatch(/permanently human/i);
    expect(command).toMatch(/never auto-run/i);
    expect(command).toMatch(/each one needs an explicit yes/i);
  });
});
