#!/usr/bin/env node
/**
 * AC gate (spec §13): every AC id must appear in ≥1 PASSING test title in the
 * runner's JSON output. Machine evidence only — role reports are never
 * consulted. Vitest JSON reporter format (v1).
 */
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

/** Extract AC-<ticket>.<n> ids from a plan file's **AC map:** sections (or anywhere in the text). */
export function extractAcIds(planText, ticket = null) {
  const re = ticket ? new RegExp(`\\bAC-${ticket}\\.\\d+\\b`, 'g') : /\bAC-\d+[a-z]?\.\d+\b/g;
  return [...new Set((planText ?? '').match(re) ?? [])];
}

/** Flatten vitest JSON results into [{title, fullName, passed}]. */
export function flattenResults(vitestJson) {
  const out = [];
  for (const file of vitestJson.testResults ?? []) {
    for (const t of file.assertionResults ?? []) {
      out.push({ title: t.title ?? '', fullName: t.fullName ?? t.title ?? '', passed: t.status === 'passed' });
    }
  }
  return out;
}

export function checkAcCoverage(acIds, tests) {
  const missing = [];
  const failing = [];
  for (const id of acIds) {
    const hits = tests.filter((t) => t.title.includes(id) || t.fullName.includes(id));
    if (hits.length === 0) missing.push(id);
    else if (!hits.some((t) => t.passed)) failing.push(id);
  }
  return { ok: missing.length === 0 && failing.length === 0, missing, failing, covered: acIds.length - missing.length - failing.length };
}

export function parseArgs(argv) {
  const a = { plan: null, ticket: null, results: null, acs: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--plan') a.plan = argv[++i];
    else if (argv[i] === '--ticket') a.ticket = Number(argv[++i]);
    else if (argv[i] === '--results') a.results = argv[++i];
    else if (argv[i] === '--acs') a.acs = argv[++i];
  }
  return a;
}

export async function runAcGate(args, log = console.log) {
  let acIds;
  if (args.acs) acIds = args.acs.split(',').map((s) => s.trim()).filter(Boolean);
  else if (args.plan) acIds = extractAcIds(await readFile(args.plan, 'utf8'), args.ticket);
  else return { ok: false, error: 'need --acs "AC-7.1,…" or --plan <file> [--ticket N]' };
  if (acIds.length === 0) return { ok: false, error: 'no AC ids found — the plan must map ACs (AC-<ticket>.<n>) to tests' };
  if (!args.results) return { ok: false, error: '--results <vitest-json-file> is required (run: vitest run --reporter=json --outputFile=<file>)' };

  const json = JSON.parse(await readFile(args.results, 'utf8'));
  const check = checkAcCoverage(acIds, flattenResults(json));
  for (const id of acIds) {
    const state = check.missing.includes(id) ? '✗ no test' : check.failing.includes(id) ? '✗ failing' : '✓';
    log(`${state.padEnd(10)} ${id}`);
  }
  log(check.ok ? `ac-gate: all ${acIds.length} ACs covered by passing tests` : `ac-gate: ${check.missing.length} unmapped, ${check.failing.length} failing`);
  return { ...check, acIds };
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  runAcGate(parseArgs(process.argv.slice(2))).then((res) => {
    if (res.error) console.error(res.error);
    process.exit(res.ok ? 0 : 1);
  });
}
