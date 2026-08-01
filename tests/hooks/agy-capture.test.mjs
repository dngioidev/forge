import { describe, it, expect } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const SHIM = join(HERE, '..', '..', 'plugin', 'hooks', 'agy-capture.mjs');

// Spawn the agy-capture shim as agy's PostToolUse hook would: JSON on stdin, an
// empty object `{}` expected on stdout. `cwd` lets us assert the fallback path.
function runCapture(input, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SHIM], { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, out }));
    child.stdin.end(typeof input === 'string' ? input : JSON.stringify(input));
  });
}

// Read the single journal line the shim appends under <ws>/.forge/agy-journal.jsonl.
async function readJournal(ws) {
  const raw = await readFile(join(ws, '.forge', 'agy-journal.jsonl'), 'utf8');
  const lines = raw.split('\n').filter(Boolean);
  return { lines, last: JSON.parse(lines[lines.length - 1]) };
}

describe('agy-capture shim I/O contract (AC-313.2)', () => {
  it('AC-313.2: translates a representative payload into a metadata-only journal line and returns {}', async () => {
    const ws = await mkdtemp(join(tmpdir(), 'agy-cap-'));
    const { code, out } = await runCapture(
      { workspacePaths: [ws], stepIdx: 7, error: 'boom: it broke' },
      undefined,
    );
    expect(code).toBe(0);
    expect(JSON.parse(out)).toEqual({});

    const { last } = await readJournal(ws);
    expect(last).toMatchObject({ host: 'agy', stepIdx: 7, error: 'boom: it broke' });
    expect(typeof last.ts).toBe('string');
    expect(Number.isNaN(Date.parse(last.ts))).toBe(false);
    // Metadata only: the shim must never persist command CONTENT/output — only the
    // four known keys ride along.
    expect(Object.keys(last).sort()).toEqual(['error', 'host', 'stepIdx', 'ts']);
  });

  it('AC-313.2: reads the workspace from workspacePaths[0]', async () => {
    const ws = await mkdtemp(join(tmpdir(), 'agy-cap-'));
    const decoy = await mkdtemp(join(tmpdir(), 'agy-decoy-'));
    await runCapture({ workspacePaths: [ws, decoy], stepIdx: 1, error: null }, undefined);
    const { last } = await readJournal(ws);       // written to [0]
    expect(last.stepIdx).toBe(1);
    // the decoy (index 1) must NOT receive a journal
    await expect(readJournal(decoy)).rejects.toBeTruthy();
  });

  it('AC-313.2: no workspacePaths falls back to cwd', async () => {
    const ws = await mkdtemp(join(tmpdir(), 'agy-cwd-'));
    const { out } = await runCapture({ stepIdx: 3, error: 'x' }, ws);
    expect(JSON.parse(out)).toEqual({});
    const { last } = await readJournal(ws);
    expect(last).toMatchObject({ host: 'agy', stepIdx: 3, error: 'x' });
  });

  it('AC-313.2: missing stepIdx / error default to null (bounded shape)', async () => {
    const ws = await mkdtemp(join(tmpdir(), 'agy-null-'));
    await runCapture({ workspacePaths: [ws] }, undefined);
    const { last } = await readJournal(ws);
    expect(last.stepIdx).toBe(null);
    expect(last.error).toBe(null);
  });

  it('AC-313.2: a long error is truncated to 200 chars (no verbatim secret leak)', async () => {
    const ws = await mkdtemp(join(tmpdir(), 'agy-trunc-'));
    await runCapture({ workspacePaths: [ws], error: 'E'.repeat(500) }, undefined);
    const { last } = await readJournal(ws);
    expect(last.error.length).toBe(200);
  });

  it('AC-313.2: a non-string error is stringified then bounded', async () => {
    const ws = await mkdtemp(join(tmpdir(), 'agy-obj-'));
    await runCapture({ workspacePaths: [ws], error: { code: 'ENOENT' } }, undefined);
    const { last } = await readJournal(ws);
    expect(typeof last.error).toBe('string');
    expect(last.error).toContain('object');
  });

  it('AC-313.2: appends (does not overwrite) across multiple calls', async () => {
    const ws = await mkdtemp(join(tmpdir(), 'agy-append-'));
    await runCapture({ workspacePaths: [ws], stepIdx: 1, error: null }, undefined);
    await runCapture({ workspacePaths: [ws], stepIdx: 2, error: null }, undefined);
    const { lines } = await readJournal(ws);
    expect(lines.length).toBe(2);
    expect(JSON.parse(lines[0]).stepIdx).toBe(1);
    expect(JSON.parse(lines[1]).stepIdx).toBe(2);
  });

  it('AC-313.2: malformed / non-JSON stdin still returns {} and never crashes', async () => {
    for (const bad of ['not json', '', '{"workspacePaths":', 'null']) {
      const { code, out } = await runCapture(bad, await mkdtemp(join(tmpdir(), 'agy-bad-')));
      expect(code, JSON.stringify(bad)).toBe(0);
      expect(JSON.parse(out), JSON.stringify(bad)).toEqual({});
    }
  });

  it('AC-313.2: capture is best-effort — an unwritable workspace still returns {} (never wedges the loop)', async () => {
    // Point the workspace at a path whose parent is a FILE, so mkdir(.forge) fails.
    const base = await mkdtemp(join(tmpdir(), 'agy-nowrite-'));
    const filePath = join(base, 'not-a-dir');
    await writeFile(filePath, 'i am a file', 'utf8');
    const { code, out } = await runCapture({ workspacePaths: [filePath], stepIdx: 9, error: 'x' }, undefined);
    expect(code).toBe(0);
    expect(JSON.parse(out)).toEqual({});
  });
});
