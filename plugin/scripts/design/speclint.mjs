#!/usr/bin/env node
/**
 * Visual-spec lint (spec §4 item 11): a design doc must carry every mandatory
 * section — sections are grammar, not decoration. Used by forge:design before
 * the decision comment and by design-reviewer/ship afterwards.
 */
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const MANDATORY_SECTIONS = [
  'States matrix',
  'Breakpoints',
  'Themes',
  'A11y contract',
  'Motion',
  'Token delta',
];

const REQUIRED_STATES = ['default', 'hover', 'focus', 'active', 'disabled', 'loading', 'empty', 'error'];

export function lintSpec(text) {
  const problems = [];
  for (const s of MANDATORY_SECTIONS) {
    if (!new RegExp(`^##\\s+${s}\\b`, 'mi').test(text ?? '')) problems.push(`missing section: ## ${s}`);
  }
  if (/^##\s+States matrix/mi.test(text ?? '')) {
    for (const st of REQUIRED_STATES) {
      if (!new RegExp(`^\\|\\s*${st}\\b`, 'mi').test(text)) problems.push(`states matrix missing row: ${st}`);
    }
  }
  // token governance tripwire: raw hex colors outside the token-delta section are one-offs
  const tokenDeltaIdx = (text ?? '').search(/^##\s+Token delta/mi);
  const beforeDelta = tokenDeltaIdx >= 0 ? text.slice(0, tokenDeltaIdx) : (text ?? '');
  const hexes = [...beforeDelta.matchAll(/#[0-9a-fA-F]{6}\b/g)].map((m) => m[0]);
  for (const h of [...new Set(hexes)]) problems.push(`one-off value ${h} — reference a token instead (token governance)`);
  return { ok: problems.length === 0, problems };
}

export async function runSpecLint(path, log = console.log) {
  let text;
  try {
    text = await readFile(path, 'utf8');
  } catch {
    return { ok: false, problems: [`spec not readable: ${path}`] };
  }
  const res = lintSpec(text);
  for (const p of res.problems) log(`✗ ${p}`);
  log(res.ok ? 'spec-lint: all mandatory sections present' : `spec-lint: ${res.problems.length} problem(s)`);
  return res;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  const path = process.argv[2];
  if (!path) { console.error('usage: speclint.mjs <docs/design/spec.md>'); process.exit(2); }
  runSpecLint(path).then((res) => process.exit(res.ok ? 0 : 1));
}
