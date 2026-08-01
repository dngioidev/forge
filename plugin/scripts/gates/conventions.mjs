#!/usr/bin/env node
/**
 * Conventions gate (spec §2 git conventions) — commit-subject lint.
 *
 * Guards the ship ritual's conventions check (forge:ship step 2) mechanically:
 * every commit that will land must carry a real conventional-commit subject
 * `type(scope)?!?: description`. Empty, punctuation-only, or otherwise
 * non-conventional subjects are rejected outright.
 *
 * Root cause this closes (#310): a squash landed with the subject `@ (#297)`
 * — a single punctuation char plus the PR number, with the real message buried
 * in the body — and the prose-only conventions lint never caught it.
 */
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { run } from '../lib/exec.mjs';

/**
 * Accepted commit types: the conventional-commit set plus the extra types this
 * repo's real history uses (`spike`). Kept broader than release/core.mjs's
 * release-bump TYPES on purpose — this lints authorship, not version bumps, so
 * it must accept every legitimate subject the log already contains.
 */
export const CONVENTIONAL_TYPES = [
  'feat', 'fix', 'docs', 'chore', 'refactor', 'test',
  'perf', 'build', 'ci', 'style', 'revert', 'spike',
];

/** `type(scope)?!?: description` — scope and the `!` breaking marker optional. */
const SUBJECT_RE = /^([a-z]+)(\(([^)]*)\))?(!)?:\s+(.+)$/;

/**
 * Lint one commit subject. Returns { ok: true } for a valid conventional
 * header, or { ok: false, reason } naming why it was rejected. Pure — no I/O.
 */
export function lintSubject(rawSubject) {
  const subject = (rawSubject ?? '').trim();
  if (!subject) return { ok: false, reason: 'empty subject' };

  const m = SUBJECT_RE.exec(subject);
  if (!m) {
    // No conventional header at all. Call out the pure-garbage case explicitly.
    if (!/[A-Za-z0-9]/.test(subject)) return { ok: false, reason: 'punctuation-only subject (no conventional-commit header)' };
    return { ok: false, reason: 'not a conventional-commit header (expected "type(scope): description")' };
  }

  const type = m[1];
  if (!CONVENTIONAL_TYPES.includes(type)) {
    return { ok: false, reason: `unknown type "${type}" (expected one of ${CONVENTIONAL_TYPES.join('|')})` };
  }

  const description = (m[5] ?? '').trim();
  if (!description) return { ok: false, reason: 'empty description after type' };
  // A description that is only punctuation / issue refs (e.g. "@", "...", "(#297)")
  // carries no meaning — reject it the same as an empty one.
  const meaningful = description.replace(/\(?#\d+\)?/g, '').trim();
  if (!/[A-Za-z0-9]/.test(meaningful)) return { ok: false, reason: 'punctuation-only description (no words)' };

  return { ok: true };
}

/**
 * Read the subjects of the commits on this branch (base..HEAD, merges excluded)
 * and lint each. Returns { ok, violations:[{sha,subject,reason}] }.
 */
export async function runConventions({ cwd, base = 'main', execFn = run, log = console.log } = {}) {
  const res = await execFn('git', ['-C', cwd, 'log', '--no-merges', '--format=%H %s', `${base}..HEAD`]);
  if (!res.ok) return { ok: false, error: `git log failed: ${res.stderr}` };

  const violations = [];
  for (const line of res.stdout.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const gap = line.indexOf(' ');
    const sha = gap === -1 ? line : line.slice(0, gap);
    const subject = gap === -1 ? '' : line.slice(gap + 1);
    const verdict = lintSubject(subject);
    if (!verdict.ok) violations.push({ sha: sha.slice(0, 7), subject, reason: verdict.reason });
  }

  for (const v of violations) log(`x ${v.sha} "${v.subject}" - ${v.reason}`);
  if (violations.length) {
    log(`conventions: ${violations.length} commit subject(s) fail the conventional-commit rule (spec §2) — reword before shipping`);
  } else {
    log('conventions: clean — every commit subject is a valid conventional-commit header');
  }
  return { ok: violations.length === 0, violations };
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  const base = process.argv.includes('--base') ? process.argv[process.argv.indexOf('--base') + 1] : 'main';
  runConventions({ cwd: process.cwd(), base }).then((r) => {
    if (r.error) console.error(r.error);
    process.exit(r.ok ? 0 : 1);
  });
}
