#!/usr/bin/env node
/**
 * agy ask (#162) — read-only codebase Q&A on Gemini, to offload cheap-but-frequent
 * lookups (investigator/librarian-style "where does X happen?", "does Y already
 * exist?") off Claude and onto the shared quota. Opt-in, advisory, read-only.
 */
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadConfig } from '../lib/config.mjs';
import { runAgy, INLINE_RULE } from './core.mjs';

/** A read-only, factual Q&A brief — locate/explain, don't judge or change anything. */
export function buildAsk(question) {
  return [
    'You are a READ-ONLY code assistant working in this repository. Do NOT modify any files. Answer factually from the code; cite file paths and symbols.',
    `Question: ${String(question ?? '').trim()}`,
    'If the answer is not in the code, say "not found" rather than guessing.',
    INLINE_RULE,
  ].join('\n\n');
}

export async function runAgyAsk(config, { cwd, question } = {}, execFn) {
  if (!question || !String(question).trim()) return { ok: false, error: 'a --question is required' };
  const res = await runAgy(config, { prompt: buildAsk(question), cwd }, execFn);
  if (!res.ok) return res;
  return { ok: true, model: res.model, answer: res.output };
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  const argv = process.argv.slice(2);
  const qi = argv.indexOf('--question');
  const question = qi >= 0 ? argv[qi + 1] : argv.join(' ');
  const cwd = process.cwd();
  loadConfig(cwd).then(async (cfg) => {
    const res = await runAgyAsk(cfg.config ?? {}, { cwd, question });
    if (res.skipped) { console.error(res.reason + ' — set features.agy true in .claude/forge.json'); process.exit(2); }
    if (!res.ok) { console.error(`agy ask failed: ${res.error}`); process.exit(1); }
    console.log(`# Gemini (${res.model}) — read-only, advisory\n\n${res.answer}`);
  });
}
