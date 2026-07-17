#!/usr/bin/env node
/**
 * Test-intent gate (spec §13 anti-gaming law): weakening, deleting, or
 * loosening an existing assertion requires explicit reviewer sign-off.
 * Detector: assertion lines REMOVED from pre-existing test files. Pure
 * additions and brand-new test files pass untouched.
 */
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { run } from '../lib/exec.mjs';

const ASSERTION_RE = /\b(expect|assert|toBe|toEqual|toMatch|toContain|toThrow|rejects|resolves)\b/;

/** Parse `git diff -U0` output into per-file removed assertion lines. */
export function findWeakenings(diffText, newFiles = []) {
  const weakenings = [];
  let file = null;
  for (const line of (diffText ?? '').split(/\r?\n/)) {
    const header = /^\+\+\+ b\/(.+)$/.exec(line);
    if (header) { file = header[1]; continue; }
    if (!file || newFiles.includes(file)) continue;
    if (line.startsWith('-') && !line.startsWith('---') && ASSERTION_RE.test(line)) {
      weakenings.push({ file, line: line.slice(1).trim() });
    }
  }
  return weakenings;
}

export async function runTestIntent({ cwd, base = 'main', testGlob = 'tests/', execFn = run, log = console.log }) {
  const status = await execFn('git', ['-C', cwd, 'diff', '--name-status', `${base}...HEAD`, '--', testGlob]);
  if (!status.ok) return { ok: false, error: `git diff failed: ${status.stderr}` };
  const newFiles = status.stdout.split(/\r?\n/).filter((l) => l.startsWith('A')).map((l) => l.split(/\s+/)[1]);

  const diff = await execFn('git', ['-C', cwd, 'diff', '-U0', `${base}...HEAD`, '--', testGlob]);
  if (!diff.ok) return { ok: false, error: `git diff failed: ${diff.stderr}` };

  const weakenings = findWeakenings(diff.stdout, newFiles);
  for (const w of weakenings) log(`✗ assertion removed/changed in existing test: ${w.file} — ${w.line.slice(0, 80)}`);
  if (weakenings.length) {
    log(`test-intent: ${weakenings.length} assertion change(s) in pre-existing tests — requires explicit reviewer sign-off in the PR (anti-gaming law, spec §13)`);
  } else {
    log('test-intent: clean — no existing assertions weakened');
  }
  return { ok: weakenings.length === 0, weakenings };
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  const base = process.argv.includes('--base') ? process.argv[process.argv.indexOf('--base') + 1] : 'main';
  runTestIntent({ cwd: process.cwd(), base }).then((res) => {
    if (res.error) console.error(res.error);
    process.exit(res.ok ? 0 : 1);
  });
}
