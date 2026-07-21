#!/usr/bin/env node
/**
 * agy / Antigravity shared core (#162). One headless-Gemini entry point behind
 * an opt-in flag, used by purpose-built helpers (second opinion, ask). All agy
 * work is ADVISORY and read-only (plan mode) — it never gates the pipeline and
 * never edits the repo. This is not the removed multi-backend role-swap plane
 * (ADR-0004): it's a set of flagged, non-gating tools that share unused quota.
 */
import { run } from '../lib/exec.mjs';

export const DEFAULT_COMMAND = 'agy';
export const DEFAULT_MODEL = 'gemini-3.1-pro-high';

// The live test (#160) showed agy will write its answer to a file and print only
// a summary — force the whole thing to stdout so callers actually get it.
export const INLINE_RULE = 'Print your COMPLETE response inline in this reply. Do NOT write it to a file, a report, or the workspace — output everything directly here.';

/** Opt-in. `features.agy` is the umbrella; `geminiSecondOpinion` stays for back-compat. */
export function agyEnabled(config) {
  return config?.features?.agy === true || config?.features?.geminiSecondOpinion === true;
}
export function agyCommand(config) { return config?.agy?.command ?? DEFAULT_COMMAND; }
export function agyModel(config) { return config?.agy?.model ?? DEFAULT_MODEL; }

/**
 * Headless print, repo in scope, plan mode = read-only, skip prompts (else it
 * hangs). No `--effort`: agy's model names already encode the tier (…-low/-high),
 * and passing a conflicting effort is a hard error (found in the #160 live test).
 */
export function agyArgs({ prompt, cwd, model = DEFAULT_MODEL, mode = 'plan' }) {
  return ['--print', prompt, '--add-dir', cwd, '--model', model, '--mode', mode, '--dangerously-skip-permissions'];
}

/**
 * Run one agy pass. Fails SOFT — advisory work never throws or blocks; a missing
 * `agy` or nonzero exit returns { ok:false } for the caller to note and move on.
 * `execFn` injected for tests.
 */
export async function runAgy(config, { prompt, cwd, model, mode = 'plan' } = {}, execFn = run) {
  if (!agyEnabled(config)) return { ok: false, skipped: true, reason: 'features.agy is off (opt-in)' };
  const command = agyCommand(config);
  const m = model ?? agyModel(config);
  let res;
  try { res = await execFn(command, agyArgs({ prompt, cwd, model: m, mode })); }
  catch (e) { return { ok: false, error: `could not run ${command}: ${e.message}` }; }
  if (!res.ok) return { ok: false, error: res.stderr?.trim() || `${command} --print failed (on PATH? try: ${command} --version)` };
  return { ok: true, model: m, output: (res.stdout ?? '').trim() };
}
