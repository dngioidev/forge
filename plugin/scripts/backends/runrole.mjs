import { readFile } from 'node:fs/promises';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveBackend } from './loader.mjs';
import { ADAPTERS } from './agy.mjs';
import { scanPrompt } from './presend.mjs';
import { extractReport, citeOrDrop } from './report.mjs';
import { append as journalAppend } from '../lib/journal.mjs';
import { deriveSituation } from '../lib/situation.mjs';

const PLUGIN_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * Run one role on its resolved backend (spec §5 failure handling):
 * missing CLI/auth → straight to fallback · timeout/exit/malformed report →
 * one retry with the violation appended, then fallback · optional roles skip.
 * Claude backends are NOT executed here — the orchestrator spawns native
 * subagents itself; this runner returns { claude: true } to signal that.
 */
export async function runRole({ role, taskBrief, cwd, roster = {}, branchName = '', adapters = ADAPTERS, execFn }) {
  const resolved = resolveBackend(role, roster, branchName);
  if (!resolved.ok) return resolved;
  for (const w of resolved.warnings) {
    await journalAppend(cwd, 'backend-fallback', { role, reason: 'pin-ignored', detail: w });
  }
  if (resolved.runtime === 'claude') {
    return { ok: true, claude: true, model: resolved.model, warnings: resolved.warnings };
  }

  // security-response freezes CLI backends: no repo content reaches third-party
  // models during a suspected leak (spec §7/§4 item 18) — Claude-side fallback.
  const situation = await deriveSituation(cwd);
  if (situation.key === 'security-response') {
    await journalAppend(cwd, 'backend-fallback', { role, reason: 'security-response', detail: `CLI backend ${resolved.runtime} frozen during security-response` });
    return { ok: true, claude: true, model: null, fellBack: true, why: 'security-response: CLI backends frozen' };
  }

  const adapter = adapters[resolved.runtime];
  const card = await readFile(join(PLUGIN_ROOT, 'cards', `${role}.md`), 'utf8').catch(() => null);
  if (!card) return { ok: false, error: `no role card for '${role}'` };

  const attempt = async (extra = '') => {
    const prompt = [
      card,
      '\n## Task brief\n', taskBrief,
      '\n## Report contract\nEnd your reply with the terminal JSON block exactly as the output contract specifies.',
      extra,
    ].join('\n');
    const scan = scanPrompt(prompt);
    if (!scan.ok) return { ok: false, refused: true, error: `pre-send scan refused: ${scan.reason}` };
    const res = await adapter.runPrompt(prompt, resolved.model, { execFn, cwd });
    if (!res.ok) return res;
    const report = extractReport(res.output);
    if (!report.ok) return { ok: false, malformed: true, error: report.error };
    const { kept, dropped } = await citeOrDrop(cwd, report.report.findings);
    if (dropped.length) {
      await journalAppend(cwd, 'review-finding', { role, dropped: dropped.length, reason: 'cite-or-drop: cited file missing' });
    }
    return { ok: true, report: { ...report.report, findings: kept }, body: report.body, backend: `${resolved.runtime}:${resolved.model ?? adapter.defaultModel}` };
  };

  const fallbackOrSkip = async (why) => {
    if (resolved.optional) {
      await journalAppend(cwd, 'backend-fallback', { role, reason: 'optional-skipped', detail: why });
      return { ok: true, skipped: true, why };
    }
    await journalAppend(cwd, 'backend-fallback', { role, reason: 'fallback', detail: why, fallback: resolved.fallback ? `${resolved.fallback.runtime}:${resolved.fallback.model ?? ''}` : 'claude' });
    // fallback is always Claude-side execution by the orchestrator
    return { ok: true, claude: true, model: resolved.fallback?.model ?? null, fellBack: true, why };
  };

  if (!adapter) return fallbackOrSkip(`no adapter for runtime '${resolved.runtime}'`);
  if (!(await adapter.available(execFn))) return fallbackOrSkip(`${resolved.runtime} CLI not available`);

  const first = await attempt();
  if (first.ok) return first;
  if (first.refused) return fallbackOrSkip(first.error); // never retry a secret-bearing prompt
  const second = await attempt(`\n## Contract violation on previous attempt\n${first.error} — fix your output format.`);
  if (second.ok) return second;
  return fallbackOrSkip(`two failed attempts: ${first.error} / ${second.error}`);
}
