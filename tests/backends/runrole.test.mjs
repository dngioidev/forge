import { describe, it, expect } from 'vitest';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runRole } from '../../plugin/scripts/backends/runrole.mjs';
import { read as readJournal } from '../../plugin/scripts/lib/journal.mjs';

const GOOD_REPORT = 'Looked at it.\n\n```json\n{"verdict":"pass","findings":[]}\n```\n';

function adapter({ availableResult = true, outputs = [GOOD_REPORT] } = {}) {
  let call = 0;
  const prompts = [];
  return {
    prompts,
    id: 'agy',
    defaultModel: 'gemini-flash',
    async available() { return availableResult; },
    async runPrompt(prompt) {
      prompts.push(prompt);
      const out = outputs[Math.min(call, outputs.length - 1)];
      call += 1;
      return typeof out === 'string' ? { ok: true, output: out } : out;
    },
  };
}

async function tmp() {
  return mkdtemp(join(tmpdir(), 'forge-runrole-'));
}

describe('runRole (AC-4.3)', () => {
  it('claude backends are returned for orchestrator-side execution', async () => {
    const res = await runRole({ role: 'reviewer', taskBrief: 'x', cwd: await tmp(), roster: {}, branchName: 'feat/4-x' });
    expect(res).toMatchObject({ ok: true, claude: true, model: 'fable' });
  });

  it('CLI role: prompt = card + brief + contract; report parsed and cite-or-dropped', async () => {
    const cwd = await tmp();
    await writeFile(join(cwd, 'real.mjs'), 'x', 'utf8');
    const a = adapter({ outputs: ['body\n```json\n{"verdict":"fail","findings":[{"severity":"major","file":"real.mjs","line":1,"summary":"real"},{"severity":"major","file":"ghost.mjs","line":1,"summary":"ghost"}]}\n```'] });
    const res = await runRole({ role: 'librarian', taskBrief: 'find the config loader', cwd, roster: { librarian: { backend: 'agy:gemini-flash' } }, branchName: 'feat/4-x', adapters: { agy: a } });
    expect(res.ok).toBe(true);
    expect(a.prompts[0]).toContain('# librarian');
    expect(a.prompts[0]).toContain('find the config loader');
    expect(a.prompts[0]).toContain('Report contract');
    expect(res.report.findings.map((f) => f.summary)).toEqual(['real']); // ghost dropped
    const j = await readJournal(cwd, { kinds: ['review-finding'] });
    expect(j.events[0]).toMatchObject({ role: 'librarian', dropped: 1 });
  });

  it('malformed report → one retry with the violation appended, then success', async () => {
    const cwd = await tmp();
    const a = adapter({ outputs: ['no json at all', GOOD_REPORT] });
    const res = await runRole({ role: 'investigator', taskBrief: 'x', cwd, roster: { investigator: { backend: 'agy' } }, branchName: 'f', adapters: { agy: a } });
    expect(res.ok).toBe(true);
    expect(res.report.verdict).toBe('pass');
    expect(a.prompts.length).toBe(2);
    expect(a.prompts[1]).toContain('Contract violation');
  });

  it('two failures → fallback journaled; missing CLI skips straight to fallback', async () => {
    const cwd = await tmp();
    const bad = adapter({ outputs: ['junk', 'junk again'] });
    const res = await runRole({ role: 'investigator', taskBrief: 'x', cwd, roster: { investigator: { backend: 'agy', fallback: 'claude:haiku' } }, branchName: 'f', adapters: { agy: bad } });
    expect(res).toMatchObject({ ok: true, claude: true, fellBack: true, model: 'haiku' });

    const cwd2 = await tmp();
    const gone = adapter({ availableResult: false });
    const res2 = await runRole({ role: 'investigator', taskBrief: 'x', cwd: cwd2, roster: { investigator: { backend: 'agy' } }, branchName: 'f', adapters: { agy: gone } });
    expect(res2).toMatchObject({ ok: true, claude: true, fellBack: true });
    expect(gone.prompts.length).toBe(0); // never attempted
    const j = await readJournal(cwd2, { kinds: ['backend-fallback'] });
    expect(j.events[0].detail).toContain('not available');
  });

  it('optional roles skip instead of falling back', async () => {
    const cwd = await tmp();
    const gone = adapter({ availableResult: false });
    const res = await runRole({ role: 'second-opinion', taskBrief: 'x', cwd, roster: { 'second-opinion': { backend: 'agy', optional: true } }, branchName: 'f', adapters: { agy: gone } });
    expect(res).toMatchObject({ ok: true, skipped: true });
  });

  it('pre-send refusal never retries and never sends', async () => {
    const cwd = await tmp();
    const a = adapter();
    const res = await runRole({ role: 'librarian', taskBrief: 'context includes ghp_abcdefghijklmnopqrstuvwx1234567890', cwd, roster: { librarian: { backend: 'agy' } }, branchName: 'f', adapters: { agy: a } });
    expect(res).toMatchObject({ ok: true, claude: true, fellBack: true });
    expect(res.why).toContain('pre-send scan refused');
    expect(a.prompts.length).toBe(0);
  });

  it('pinned role with non-claude roster entry journals the pin warning', async () => {
    const cwd = await tmp();
    const res = await runRole({ role: 'security', taskBrief: 'x', cwd, roster: { security: { backend: 'agy:gemini-pro' } }, branchName: 'f' });
    expect(res).toMatchObject({ ok: true, claude: true });
    const j = await readJournal(cwd, { kinds: ['backend-fallback'] });
    expect(j.events[0]).toMatchObject({ role: 'security', reason: 'pin-ignored' });
  });
});
