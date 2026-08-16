import { describe, it, expect } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, readdir, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { signature, clusterEvents, renderReport, archive, ARCHIVE_DIR, classifyBlockedEdit } from '../../plugin/scripts/learn/distill.mjs';
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

// Fixtures below mirror the real shapes from the 2026-08-13 round that
// produced 119 blocked-edit events and 8 rejected proposals (#465). Each cmd
// is a paraphrase of a real event's cmd field, kept representative of the
// actual pattern rather than reproducing it verbatim.
const HARNESS_CMD = 'cd C:/mywp/forge && node -e "\nconst { check } = await import(\'./plugin/hooks/denylist.mjs\');\nconsole.log(check(\'git push --force origin main\'));\n"';
const SCRATCH_CMD = 'SCRATCH="C:/Users/x/AppData/Local/Temp/claude/scratchpad/wt-429"\ncd "$SCRATCH" && rm -rf ./gittest && mkdir -p ./gittest';
const DOC_WRITE_CMD = 'cd C:/mywp/forge && node "scripts/board/comment.mjs" --issue 398 --phase note --body "$(cat <<\'EOF\'\nFindings doc landed. AC.1 verified.\nEOF\n)"';
const PROBE_ECHO_TAIL_CMD = `git push --force origin main ; echo ${'y'.repeat(200)}`;
const PROBE_BRACE_CMD = 'git push --force x{a..a}{a..a}{a..a}{a..a}{a..a}{a..a}{a..a}{a..a}{a..a}{a..a}';
const GENUINE_BARE_CMD = 'git push --force origin main';

describe('blocked-edit guard-testing classification (AC-465.1, AC-465.4)', () => {
  it('AC-465.4: a check()/denylist.mjs harness invocation classifies as guard-testing', () => {
    const { guardTesting, reasons } = classifyBlockedEdit(HARNESS_CMD);
    expect(guardTesting).toBe(true);
    expect(reasons).toContain('denylist-harness');
  });

  it('AC-465.4: a scratch/temp-path command classifies as guard-testing', () => {
    expect(classifyBlockedEdit(SCRATCH_CMD).guardTesting).toBe(true);
  });

  it('AC-465.4: a --body-file / heredoc doc-write classifies as guard-testing', () => {
    expect(classifyBlockedEdit(DOC_WRITE_CMD).guardTesting).toBe(true);
  });

  it('AC-465.4: an adversarial probe with a long echo tail classifies as guard-testing', () => {
    expect(classifyBlockedEdit(PROBE_ECHO_TAIL_CMD).guardTesting).toBe(true);
  });

  it('AC-465.4: a brace-expansion probe classifies as guard-testing', () => {
    expect(classifyBlockedEdit(PROBE_BRACE_CMD).guardTesting).toBe(true);
  });

  it('AC-465.4: a genuine bare destructive command does NOT classify as guard-testing — do not fix the false positives by suppressing the true ones', () => {
    const { guardTesting } = classifyBlockedEdit(GENUINE_BARE_CMD);
    expect(guardTesting).toBe(false);
  });

  it('AC-465.1: same rule, different classification -> two distinct clusters, not one', () => {
    const events = [
      ev('blocked-edit', { rule: 'force-push', cmd: HARNESS_CMD }),
      ev('blocked-edit', { rule: 'force-push', cmd: SCRATCH_CMD }),
      ev('blocked-edit', { rule: 'force-push', cmd: GENUINE_BARE_CMD }),
    ];
    const clusters = clusterEvents(events);
    const guardCluster = clusters.find((c) => c.signature.includes('guard-testing'));
    const unclassifiedCluster = clusters.find((c) => c.signature.includes('unclassified'));
    expect(guardCluster.count).toBe(2);
    expect(unclassifiedCluster.count).toBe(1);
  });

  it('AC-465.1/AC-465.2: report never proposes a role-card edit for a guard-testing cluster; an unclassified cluster is phrased as a question', () => {
    const events = [
      ev('blocked-edit', { rule: 'recursive-delete', cmd: HARNESS_CMD }),
      ev('blocked-edit', { rule: 'recursive-delete', cmd: SCRATCH_CMD }),
      ev('blocked-edit', { rule: 'force-push', cmd: GENUINE_BARE_CMD }),
      ev('blocked-edit', { rule: 'force-push', cmd: 'git push --force origin main' }),
    ];
    const report = renderReport(clusterEvents(events));
    expect(report).toContain('no role-card change proposed');
    expect(report).not.toMatch(/reaching for a denylisted action/);
    expect(report).toContain('question, not a diagnosis');
    expect(report).toMatch(/genuine destructive attempt.*\?/);
  });

  it('AC-465.3: the report surfaces a truncated cmd excerpt inline, not just bare timestamps', () => {
    const events = [
      ev('blocked-edit', { rule: 'force-push', cmd: PROBE_ECHO_TAIL_CMD }),
      ev('blocked-edit', { rule: 'force-push', cmd: PROBE_ECHO_TAIL_CMD }),
    ];
    const report = renderReport(clusterEvents(events));
    expect(report).toMatch(/Sample: `git push --force origin main/);
    // truncated, not the full ~90-char echo tail
    expect(report).toContain('…');
  });
});

describe('escalation-resolved clustering (AC-465.5)', () => {
  it('AC-465.5: resolved escalations from different tickets never merge under "unspecified"', () => {
    // Real shape: escalation-resolved carries `answer`, not `reason` — the
    // pre-fix signature() read `event.reason` here, which does not exist on
    // this event kind, so every resolution fell through to 'unspecified'.
    const events = [
      ev('escalation-resolved', { issue: 407, id: 'esc-407-msjuouh6', answer: 'approve' }),
      ev('escalation-resolved', { issue: 446, id: 'esc-446-msqfnq7f', answer: 'ship the 5 closed classes as-is' }),
      ev('escalation-resolved', { issue: 446, id: 'esc-446-msqh7snx', answer: 'ship #446 as-is' }),
    ];
    const clusters = clusterEvents(events);
    const unspecified = clusters.find((c) => c.signature === 'unspecified');
    expect(unspecified).toBeUndefined();
    // three distinct decisions -> three one-off clusters, not one fake 3x pattern
    expect(clusters.filter((c) => c.kind === 'escalation-resolved')).toHaveLength(3);
    expect(clusters.every((c) => c.count === 1)).toBe(true);
  });

  it('AC-465.5: the SAME escalation resolved twice still clusters as a repeat', () => {
    const events = [
      ev('escalation-resolved', { issue: 446, id: 'esc-446-msqfnq7f', answer: 'ship' }),
      ev('escalation-resolved', { issue: 446, id: 'esc-446-msqfnq7f', answer: 'ship, confirmed' }),
    ];
    const clusters = clusterEvents(events);
    expect(clusters).toHaveLength(1);
    expect(clusters[0].count).toBe(2);
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
