#!/usr/bin/env node
/**
 * Gemini second opinion via agy / Antigravity (#160). Opt-in, ADVISORY, never a
 * gate. `agy --print` runs a headless agentic pass on a genuinely different model
 * (Gemini) at zero Claude cost — a real independent reviewer for a diff/spec.
 * This does NOT reintroduce the removed multi-backend role-swap plane (ADR-0004):
 * it's one purpose-built, non-gating tool behind a feature flag.
 */
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { run } from '../lib/exec.mjs';
import { loadConfig } from '../lib/config.mjs';

export const DEFAULT_COMMAND = 'agy';
export const DEFAULT_MODEL = 'gemini-3.1-pro-high';

export function agyEnabled(config) {
  return config?.features?.geminiSecondOpinion === true;
}

/** A skeptical, read-only, advisory review brief for the second model. */
export function buildBrief({ ticket = null, acs = [], target = 'the diff on the current branch' } = {}) {
  return [
    'You are an INDEPENDENT second reviewer, a different model from the author. This is ADVISORY — you do not gate or merge anything, and you must NOT modify any files.',
    `Review ${target}${ticket ? ` for ticket #${ticket}` : ''}. Be skeptical. Look for correctness bugs first, then security, then design/simplification.`,
    acs.length ? `Check these acceptance criteria:\n${acs.map((a) => `- ${a}`).join('\n')}` : '',
    'Report concise, severity-tagged findings (critical | high | medium | low). If you find nothing real, say so plainly — "Unknown" or "no issues found" are valid answers.',
  ].filter(Boolean).join('\n\n');
}

/** The agy invocation: headless print, repo in scope, plan mode = read-only. */
export function agyArgs({ prompt, cwd, model = DEFAULT_MODEL, effort = 'high' }) {
  return ['--print', prompt, '--add-dir', cwd, '--model', model, '--effort', effort, '--mode', 'plan', '--dangerously-skip-permissions'];
}

/**
 * Run the second opinion. Fails SOFT — advisory work never throws or blocks the
 * pipeline; a missing `agy` or a nonzero exit returns { ok:false } for the caller
 * to note and move on. `execFn` is injected for tests.
 */
export async function runAgyOpinion(config, { cwd, ticket = null, acs = [], target } = {}, execFn = run) {
  if (!agyEnabled(config)) return { ok: false, skipped: true, reason: 'features.geminiSecondOpinion is off (opt-in)' };
  const command = config?.agy?.command ?? DEFAULT_COMMAND;
  const model = config?.agy?.model ?? DEFAULT_MODEL;
  const prompt = buildBrief({ ticket, acs, target });
  let res;
  try { res = await execFn(command, agyArgs({ prompt, cwd, model })); }
  catch (e) { return { ok: false, error: `could not run ${command}: ${e.message}` }; }
  if (!res.ok) return { ok: false, error: res.stderr?.trim() || `${command} --print failed (is it on PATH? try: ${command} --version)` };
  return { ok: true, model, critique: (res.stdout ?? '').trim() };
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  const argv = process.argv.slice(2);
  const get = (f) => (argv.includes(f) ? argv[argv.indexOf(f) + 1] : null);
  const acs = argv.reduce((a, v, i) => (v === '--ac' ? [...a, argv[i + 1]] : a), []);
  const cwd = process.cwd();
  loadConfig(cwd).then(async (cfg) => {
    const res = await runAgyOpinion(cfg.config ?? {}, { cwd, ticket: get('--ticket'), acs, target: get('--target') ?? undefined });
    if (res.skipped) { console.error(res.reason + ' — set it true in .claude/forge.json'); process.exit(2); }
    if (!res.ok) { console.error(`second opinion failed: ${res.error}`); process.exit(1); }
    console.log(`# Gemini second opinion (${res.model}) — advisory\n`);
    console.log(res.critique);
  });
}
