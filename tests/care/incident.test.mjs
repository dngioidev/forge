import { describe, it, expect } from 'vitest';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runIncident, parseArgs } from '../../plugin/scripts/care/incident.mjs';
import { evaluate, runGate } from '../../plugin/scripts/gates/situationgate.mjs';
import { deriveSituation } from '../../plugin/scripts/lib/situation.mjs';
import { computeReadiness } from '../../plugin/scripts/release/readiness.mjs';
import { runRole } from '../../plugin/scripts/backends/runrole.mjs';

const noop = () => {};
const tmp = () => mkdtemp(join(tmpdir(), 'forge-inc-'));

describe('incident open/close (AC-10.1)', () => {
  it('AC-10.1: open flips the situation to incident; close with postmortem clears it', async () => {
    const cwd = await tmp();
    const open = await runIncident(cwd, parseArgs(['open', '--ticket', '42', '--summary', 'prod healthcheck failing']), noop);
    expect(open).toMatchObject({ ok: true, situation: 'incident' });
    expect((await deriveSituation(cwd)).key).toBe('incident');

    const noPm = await runIncident(cwd, parseArgs(['close', '--ticket', '42']), noop);
    expect(noPm.ok).toBe(false);
    expect(noPm.error).toMatch(/postmortem/);
    expect((await deriveSituation(cwd)).key).toBe('incident'); // refusal wrote nothing

    const close = await runIncident(cwd, parseArgs(['close', '--ticket', '42', '--postmortem', '#43']), noop);
    expect(close.ok).toBe(true);
    expect((await deriveSituation(cwd)).key).toBe('idle');

    const journal = await readFile(join(cwd, '.forge', 'journal.jsonl'), 'utf8');
    expect(journal).toContain('"summary":"prod healthcheck failing"');
    expect(journal).toContain('"postmortem":"#43"');
  });
});

describe('respond-open/close (AC-10.2)', () => {
  it('AC-10.2: respond-open outranks an open incident; respond-close needs a postmortem', async () => {
    const cwd = await tmp();
    await runIncident(cwd, parseArgs(['open', '--ticket', '1', '--summary', 's']), noop);
    const ro = await runIncident(cwd, parseArgs(['respond-open', '--reason', 'leaked token suspected']), noop);
    expect(ro.situation).toBe('security-response'); // outranks incident

    expect((await runIncident(cwd, parseArgs(['respond-close']), noop)).ok).toBe(false);
    await runIncident(cwd, parseArgs(['respond-close', '--postmortem', '#9']), noop);
    expect((await deriveSituation(cwd)).key).toBe('incident'); // incident still open underneath
  });
});

describe('situation gate (AC-10.3)', () => {
  it('AC-10.3: incident — hotfix ships, others refused with the unlocking command; release refused', () => {
    expect(evaluate('incident', 'ship', { branch: 'hotfix/42-fix-crash' }).allowed).toBe(true);
    const refused = evaluate('incident', 'ship', { branch: 'feat/13-hotfix-respond' });
    expect(refused.allowed).toBe(false);
    expect(refused.why).toMatch(/incident\.mjs close/);
    expect(evaluate('incident', 'release', {}).allowed).toBe(false);
    expect(evaluate('incident', 'backend', {}).allowed).toBe(true);
  });

  it('AC-10.3: security-response — only respond/investigate skills pass', () => {
    expect(evaluate('security-response', 'skill', { skill: 'respond' }).allowed).toBe(true);
    expect(evaluate('security-response', 'skill', { skill: 'investigate' }).allowed).toBe(true);
    expect(evaluate('security-response', 'skill', { skill: 'execute' }).allowed).toBe(false);
    expect(evaluate('security-response', 'ship', { branch: 'hotfix/1-x' }).allowed).toBe(false);
    expect(evaluate('security-response', 'backend', {}).allowed).toBe(false);
    expect(evaluate('security-response', 'release', {}).why).toMatch(/respond-close/);
  });

  it('normal situations restrict nothing; runGate reads the journal live', async () => {
    expect(evaluate('building', 'ship', { branch: 'feat/1-x' }).allowed).toBe(true);
    const cwd = await tmp();
    await runIncident(cwd, parseArgs(['open', '--ticket', '1', '--summary', 's']), noop);
    const res = await runGate(cwd, { action: 'ship', branch: 'feat/1-x', skill: null }, noop);
    expect(res).toMatchObject({ ok: true, allowed: false, situation: 'incident' });
  });
});

describe('CLI backend freeze (AC-10.4)', () => {
  const roster = { investigator: { backend: 'agy:gemini-flash' } };

  it('AC-10.4: a CLI-pinned role falls back to Claude during security-response, journaled', async () => {
    const cwd = await tmp();
    await runIncident(cwd, parseArgs(['respond-open', '--reason', 'r']), noop);
    const res = await runRole({ role: 'investigator', taskBrief: 'look', cwd, roster, execFn: async () => ({ ok: true, code: 0, stdout: '', stderr: '' }) });
    expect(res).toMatchObject({ ok: true, claude: true, fellBack: true });
    expect(res.why).toMatch(/security-response/);
    const journal = await readFile(join(cwd, '.forge', 'journal.jsonl'), 'utf8');
    expect(journal).toContain('"reason":"security-response"');
  });

  it('AC-10.4: Claude-pinned roles are untouched during security-response', async () => {
    const cwd = await tmp();
    await runIncident(cwd, parseArgs(['respond-open', '--reason', 'r']), noop);
    const res = await runRole({ role: 'security', taskBrief: 'scan', cwd, roster: {}, execFn: async () => ({ ok: true }) });
    expect(res).toMatchObject({ ok: true, claude: true });
    expect(res.fellBack).toBeUndefined();
  });
});

describe('release readiness during emergencies (AC-10.5)', () => {
  const gitOk = async (cmd, args) => {
    if (args?.includes('--abbrev-ref')) return { ok: true, stdout: 'main\n', stderr: '' };
    if (args?.includes('--porcelain')) return { ok: true, stdout: '', stderr: '' };
    if (args?.includes('--count')) return { ok: true, stdout: '0\n', stderr: '' };
    return { ok: true, stdout: '', stderr: '' };
  };

  it('AC-10.5: readiness fails with a situation item during incident, passes after close', async () => {
    const cwd = await tmp();
    await runIncident(cwd, parseArgs(['open', '--ticket', '1', '--summary', 's']), noop);
    const during = await computeReadiness({ cwd, execFn: gitOk, config: {}, verifyCmd: null });
    const item = during.items.find((i) => i.name === 'situation');
    expect(during.ok).toBe(false);
    expect(item).toMatchObject({ level: 'fail' });
    expect(item.msg).toMatch(/incident/);

    await runIncident(cwd, parseArgs(['close', '--ticket', '1', '--postmortem', '#2']), noop);
    const after = await computeReadiness({ cwd, execFn: gitOk, config: {}, verifyCmd: null });
    expect(after.items.find((i) => i.name === 'situation')).toMatchObject({ level: 'pass' });
  });
});

describe('skills + runbooks carry the laws (AC-10.6)', () => {
  const read = (rel) => readFile(new URL(rel, import.meta.url), 'utf8');

  it('AC-10.6: hotfix/respond skills and both runbooks state the laws', async () => {
    const hotfix = await read('../../plugin/skills/hotfix/SKILL.md');
    expect(hotfix).toMatch(/only the process ritual is compressed — the deploy path is not/i);
    expect(hotfix).toMatch(/postmortem/i);
    expect(hotfix).toMatch(/staging/i);

    const respond = await read('../../plugin/skills/respond/SKILL.md');
    expect(respond).toMatch(/containment before code/i);
    expect(respond).toMatch(/scrub-and-rotate over history rewrites/i);
    expect(respond).toMatch(/hands off/i);

    const rollback = await read('../../docs/guides/rollback-runbook.md');
    expect(rollback).toMatch(/digests, not branches/i);
    expect(rollback).toMatch(/rollback is containment, not the fix/i);

    const recovery = await read('../../docs/guides/data-recovery-runbook.md');
    expect(recovery).toMatch(/restore → verify → postmortem/i);
    expect(recovery).toMatch(/never debug against the only copy/i);

    const ship = await read('../../plugin/skills/ship/SKILL.md');
    expect(ship).toMatch(/situationgate\.mjs/);
  });
});
