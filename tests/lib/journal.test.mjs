import { describe, it, expect } from 'vitest';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { append, read, redact, KINDS, JOURNAL_RELPATH } from '../../plugin/scripts/lib/journal.mjs';

async function tmp() {
  return mkdtemp(join(tmpdir(), 'forge-journal-'));
}

describe('journal (AC-3.1)', () => {
  it('appends kind-tagged JSONL and reads it back', async () => {
    const cwd = await tmp();
    const r1 = await append(cwd, 'gate-fail', { cmd: 'pnpm verify', exit: 1, ticket: '#3' });
    expect(r1.ok).toBe(true);
    await append(cwd, 'escalation', { issue: 3, id: 'esc-1' });
    const all = await read(cwd);
    expect(all.events.length).toBe(2);
    expect(all.events[0]).toMatchObject({ kind: 'gate-fail', cmd: 'pnpm verify' });
    const filtered = await read(cwd, { kinds: ['escalation'] });
    expect(filtered.events.length).toBe(1);
  });

  it('rejects unknown kinds listing the valid ones', async () => {
    const cwd = await tmp();
    const r = await append(cwd, 'vibes', {});
    expect(r.ok).toBe(false);
    expect(r.error).toContain('gate-fail');
    expect(KINDS).toContain('respond-open');
  });

  it('redacts secret-shaped values at append time', async () => {
    const cwd = await tmp();
    await append(cwd, 'cmd-fail', {
      cmd: 'curl -H "Authorization: Bearer x" && GH_TOKEN=ghp_abcdefghijklmnopqrstuvwx123456 gh api',
      token: 'ghp_abcdefghijklmnopqrstuvwx123456',
      err_line: 'error: bad key sk-abcdefghijklmnopqrstuvwxyz123456',
    });
    const raw = await readFile(join(cwd, JOURNAL_RELPATH), 'utf8');
    expect(raw).not.toContain('ghp_abcdefghijklmnopqrstuvwx123456');
    expect(raw).not.toContain('sk-abcdefghijklmnopqrstuvwxyz123456');
    expect(raw).toContain('GH_TOKEN=[redacted]');
    expect(raw).toContain('"token":"[redacted]"');
  });

  it('redact handles nested objects, arrays, and key-name matches', () => {
    const out = redact({ apiKey: 'plain-value', nested: { list: ['AKIAABCDEFGHIJKLMNOP'] }, safe: 'hello' });
    expect(out.apiKey).toBe('[redacted]');
    expect(out.nested.list[0]).toBe('[redacted]');
    expect(out.safe).toBe('hello');
  });

  it('read skips corrupt lines instead of failing', async () => {
    const cwd = await tmp();
    await append(cwd, 'gate-fail', { n: 1 });
    const { appendFile } = await import('node:fs/promises');
    await appendFile(join(cwd, JOURNAL_RELPATH), 'not json\n', 'utf8');
    await append(cwd, 'gate-fail', { n: 2 });
    const all = await read(cwd);
    expect(all.events.length).toBe(2);
  });
});
