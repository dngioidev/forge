import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';

/**
 * Execute ledger (spec §4 item 5): .forge/progress.md — human-readable,
 * survives compaction, powers the resume protocol. Checklist grammar:
 *   - [ ] T1 — description        (pending)
 *   - [~] T2 — description        (in progress)
 *   - [x] T3 — description        (done)
 * Notes lines are indented under a task and preserved verbatim.
 */
export const LEDGER_RELPATH = join('.forge', 'progress.md');
const TASK_RE = /^- \[( |~|x)\] (\S+) — (.*)$/;

export function parseLedger(text) {
  const tasks = [];
  let current = null;
  for (const line of (text ?? '').split(/\r?\n/)) {
    const m = TASK_RE.exec(line);
    if (m) {
      current = { id: m[2], status: m[1] === 'x' ? 'done' : m[1] === '~' ? 'in-progress' : 'pending', title: m[3], notes: [] };
      tasks.push(current);
    } else if (current && /^ {2,}\S/.test(line)) {
      current.notes.push(line.trim());
    }
  }
  return tasks;
}

export function renderLedger(header, tasks) {
  const mark = { pending: ' ', 'in-progress': '~', done: 'x' };
  const lines = [header.trim(), ''];
  for (const t of tasks) {
    lines.push(`- [${mark[t.status]}] ${t.id} — ${t.title}`);
    for (const n of t.notes) lines.push(`  ${n}`);
  }
  return lines.join('\n') + '\n';
}

export async function initLedger(cwd, { ticket, planPath, tasks }) {
  const path = join(cwd, LEDGER_RELPATH);
  try {
    const existing = await readFile(path, 'utf8');
    if (parseLedger(existing).length > 0) return { ok: true, existed: true, tasks: parseLedger(existing) };
  } catch { /* fresh */ }
  const list = tasks.map((t) => ({ id: t.id, status: 'pending', title: t.title, notes: [] }));
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, renderLedger(`# forge execute ledger — #${ticket}\n\nPlan: ${planPath}`, list), 'utf8');
  return { ok: true, existed: false, tasks: list };
}

export async function markTask(cwd, id, status, note = null) {
  const path = join(cwd, LEDGER_RELPATH);
  const text = await readFile(path, 'utf8');
  const tasks = parseLedger(text);
  const task = tasks.find((t) => t.id === id);
  if (!task) return { ok: false, error: `no task '${id}' in the ledger — ids: ${tasks.map((t) => t.id).join(', ')}` };
  task.status = status;
  if (note) task.notes.push(note);
  const header = text.split(/\r?\n- \[/)[0];
  await writeFile(path, renderLedger(header, tasks), 'utf8');
  return { ok: true, task };
}

/** Resume protocol entry point: the first task that isn't done. */
export async function nextTask(cwd) {
  let text;
  try {
    text = await readFile(join(cwd, LEDGER_RELPATH), 'utf8');
  } catch {
    return { ok: true, task: null, empty: true };
  }
  const tasks = parseLedger(text);
  const next = tasks.find((t) => t.status !== 'done') ?? null;
  return { ok: true, task: next, done: tasks.filter((t) => t.status === 'done').length, total: tasks.length };
}
