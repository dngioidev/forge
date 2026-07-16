import { appendFile, readFile, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';

/**
 * Learning-loop journal (spec §8): kind-tagged JSONL in .forge/journal.jsonl.
 * SP3 ships the format + append/read; capture hooks arrive with SP7.
 * Secrets never enter the journal — redaction happens at append time (§13).
 */
export const KINDS = [
  'gate-fail', 'blocked-edit', 'cmd-fail', 'backend-fallback', 'review-finding',
  'escalation', 'escalation-resolved', 'incident', 'auto-approve', 'respond-open', 'respond-close',
];

export const JOURNAL_RELPATH = join('.forge', 'journal.jsonl');

const SECRET_KEY_RE = /(token|secret|password|passwd|api[-_]?key|authorization|credential|private[-_]?key)/i;
const SECRET_VALUE_RE = /(gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|sk-[A-Za-z0-9_-]{20,}|AKIA[0-9A-Z]{16}|-----BEGIN [A-Z ]*PRIVATE KEY|eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,})/;
const ENV_ASSIGN_RE = /\b([A-Z][A-Z0-9_]*(?:TOKEN|SECRET|KEY|PASSWORD|PASSWD)[A-Z0-9_]*)=(\S+)/g;

export function redact(value) {
  if (typeof value === 'string') {
    let out = value.replace(ENV_ASSIGN_RE, (_, name) => `${name}=[redacted]`);
    if (SECRET_VALUE_RE.test(out)) out = out.replace(new RegExp(SECRET_VALUE_RE, 'g'), '[redacted]');
    return out;
  }
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = SECRET_KEY_RE.test(k) ? '[redacted]' : redact(v);
    }
    return out;
  }
  return value;
}

export async function append(cwd, kind, data = {}) {
  if (!KINDS.includes(kind)) return { ok: false, error: `unknown journal kind '${kind}' — valid: ${KINDS.join(', ')}` };
  const path = join(cwd, JOURNAL_RELPATH);
  await mkdir(dirname(path), { recursive: true });
  const entry = { ts: new Date().toISOString(), kind, ...redact(data) };
  await appendFile(path, JSON.stringify(entry) + '\n', 'utf8');
  return { ok: true, entry };
}

export async function read(cwd, { kinds = null } = {}) {
  let raw;
  try {
    raw = await readFile(join(cwd, JOURNAL_RELPATH), 'utf8');
  } catch {
    return { ok: true, events: [] };
  }
  const events = [];
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line);
      if (!kinds || kinds.includes(e.kind)) events.push(e);
    } catch { /* skip corrupt lines — journal is best-effort evidence, not a ledger */ }
  }
  return { ok: true, events };
}
