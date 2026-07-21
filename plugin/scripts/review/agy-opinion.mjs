#!/usr/bin/env node
/**
 * Gemini second opinion via agy / Antigravity (#160, #162). Opt-in, ADVISORY,
 * never a gate — a genuinely different model's eyes on a diff/file at zero Claude
 * cost. Built on the shared agy core.
 */
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadConfig } from '../lib/config.mjs';
import { runAgy, agyEnabled, agyArgs, INLINE_RULE, DEFAULT_MODEL, DEFAULT_COMMAND } from '../agy/core.mjs';

// Re-export for back-compat with existing importers.
export { agyEnabled, agyArgs, DEFAULT_MODEL, DEFAULT_COMMAND };

/** A skeptical, read-only, advisory review brief for the second model. */
export function buildBrief({ ticket = null, acs = [], target = 'the diff on the current branch' } = {}) {
  return [
    'You are an INDEPENDENT second reviewer, a different model from the author. This is ADVISORY — you do not gate or merge anything, and you must NOT modify any files.',
    `Review ${target}${ticket ? ` for ticket #${ticket}` : ''}. Be skeptical. Look for correctness bugs first, then security, then design/simplification.`,
    acs.length ? `Check these acceptance criteria:\n${acs.map((a) => `- ${a}`).join('\n')}` : '',
    'Report concise, severity-tagged findings (critical | high | medium | low). If you find nothing real, say so plainly — "Unknown" or "no issues found" are valid answers.',
    INLINE_RULE,
  ].filter(Boolean).join('\n\n');
}

export async function runAgyOpinion(config, { cwd, ticket = null, acs = [], target } = {}, execFn) {
  const res = await runAgy(config, { prompt: buildBrief({ ticket, acs, target }), cwd }, execFn);
  if (!res.ok) return res;
  return { ok: true, model: res.model, critique: res.output };
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  const argv = process.argv.slice(2);
  const get = (f) => (argv.includes(f) ? argv[argv.indexOf(f) + 1] : null);
  const acs = argv.reduce((a, v, i) => (v === '--ac' ? [...a, argv[i + 1]] : a), []);
  const cwd = process.cwd();
  loadConfig(cwd).then(async (cfg) => {
    const res = await runAgyOpinion(cfg.config ?? {}, { cwd, ticket: get('--ticket'), acs, target: get('--target') ?? undefined });
    if (res.skipped) { console.error(res.reason + ' — set features.agy true in .claude/forge.json'); process.exit(2); }
    if (!res.ok) { console.error(`second opinion failed: ${res.error}`); process.exit(1); }
    console.log(`# Gemini second opinion (${res.model}) — advisory\n\n${res.critique}`);
  });
}
