import { describe, it, expect } from 'vitest';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseLedger, renderLedger, initLedger, markTask, nextTask, LEDGER_RELPATH } from '../../plugin/scripts/lib/ledger.mjs';

const TASKS = [
  { id: 'T1', title: 'ledger lib' },
  { id: 'T2', title: 'ac gate' },
  { id: 'T3', title: 'ship' },
];

async function tmp() {
  return mkdtemp(join(tmpdir(), 'forge-ledger-'));
}

describe('ledger (AC-5.6)', () => {
  it('init → parse round-trip; re-init keeps existing state', async () => {
    const cwd = await tmp();
    const first = await initLedger(cwd, { ticket: 7, planPath: 'docs/plans/x.md', tasks: TASKS });
    expect(first.existed).toBe(false);
    expect(first.tasks.length).toBe(3);
    await markTask(cwd, 'T1', 'done');
    const again = await initLedger(cwd, { ticket: 7, planPath: 'docs/plans/x.md', tasks: TASKS });
    expect(again.existed).toBe(true);
    expect(again.tasks.find((t) => t.id === 'T1').status).toBe('done');
  });

  it('markTask transitions + notes; unknown id errors with the id list', async () => {
    const cwd = await tmp();
    await initLedger(cwd, { ticket: 7, planPath: 'p', tasks: TASKS });
    await markTask(cwd, 'T1', 'in-progress');
    await markTask(cwd, 'T1', 'done', 'tests green');
    const text = await readFile(join(cwd, LEDGER_RELPATH), 'utf8');
    expect(text).toContain('- [x] T1 — ledger lib');
    expect(text).toContain('  tests green');
    const bad = await markTask(cwd, 'T9', 'done');
    expect(bad.ok).toBe(false);
    expect(bad.error).toContain('T1, T2, T3');
  });

  it('nextTask = resume protocol: first non-done; null when all done; empty when no ledger', async () => {
    const cwd = await tmp();
    expect((await nextTask(cwd)).empty).toBe(true);
    await initLedger(cwd, { ticket: 7, planPath: 'p', tasks: TASKS });
    await markTask(cwd, 'T1', 'done');
    await markTask(cwd, 'T2', 'in-progress');
    const n = await nextTask(cwd);
    expect(n.task.id).toBe('T2'); // in-progress counts as not done
    expect(n.done).toBe(1);
    await markTask(cwd, 'T2', 'done');
    await markTask(cwd, 'T3', 'done');
    expect((await nextTask(cwd)).task).toBe(null);
  });

  it('parse is CRLF-safe', () => {
    const tasks = parseLedger('# h\r\n\r\n- [x] T1 — a\r\n- [ ] T2 — b\r\n  note line\r\n');
    expect(tasks.length).toBe(2);
    expect(tasks[1].notes).toEqual(['note line']);
    expect(renderLedger('# h', tasks)).toContain('- [ ] T2 — b');
  });
});
