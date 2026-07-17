/**
 * Metadata-only sanitizer (spec §11 guardrail; SP9a T2). ALLOWLIST, not
 * denylist: a field that isn't declared here does not leave the machine, no
 * matter who added it upstream. Code, diffs, and prompts have no declared
 * field — they cannot pass. Strings are capped; a doc that still fails the
 * schema refuses to publish (fail-closed: no telemetry beats leaky telemetry).
 */

const CAP = { short: 80, reason: 200, option: 120 };

const cap = (v, n) => (typeof v === 'string' ? v.slice(0, n) : null);
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** field -> extractor; anything not listed is dropped. */
const TELEMETRY_SCHEMA = {
  repo: (v) => cap(v, CAP.short),
  situation: (v) => cap(v, CAP.short),
  glyph: (v) => cap(v, 8),
  branch: (v) => cap(v, CAP.short),
  ticket: (v) => cap(v, 16),
  branchKind: (v) => cap(v, 16),
  collectedAt: (v) => cap(v, 32),
  machineId: (v) => cap(v, CAP.short),
  ledger: (v) => (v && typeof v === 'object'
    ? { total: num(v.total), done: num(v.done), inProgress: num(v.inProgress), pending: num(v.pending) }
    : null),
  pendingDecisions: (v) => (Array.isArray(v) ? v.slice(0, 20).map((d) => ({
    id: cap(d?.id, CAP.short),
    issue: num(d?.issue),
    reason: cap(d?.reason, CAP.reason),
    options: Array.isArray(d?.options) ? d.options.slice(0, 6).map((o) => cap(o, CAP.option)) : [],
    ageHours: num(d?.ageHours),
  })) : []),
  journalTail: (v) => (Array.isArray(v) ? v.slice(-10).map((e) => ({
    ts: cap(e?.ts, 32),
    kind: cap(e?.kind, 32),
    ticket: cap(e?.ticket, 16),
    gate: cap(e?.gate, 32),
    rule: cap(e?.rule, 32),
  })) : []),
};

const REQUIRED = ['repo', 'situation', 'collectedAt', 'machineId'];

export function sanitizeTelemetry(doc) {
  if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) {
    return { ok: false, error: 'telemetry must be an object' };
  }
  const out = {};
  for (const [field, extract] of Object.entries(TELEMETRY_SCHEMA)) {
    if (field in doc) out[field] = extract(doc[field]);
  }
  const missing = REQUIRED.filter((f) => out[f] == null);
  if (missing.length > 0) {
    return { ok: false, error: `telemetry refused to publish — missing required metadata: ${missing.join(', ')}` };
  }
  return { ok: true, doc: out };
}

/** Escalation notifications carry even less: the decision, not its content. */
export function sanitizeEscalation(d, machineId, repo) {
  const out = {
    machineId: cap(machineId, CAP.short),
    repo: cap(repo, CAP.short),
    id: cap(d?.id, CAP.short),
    issue: num(d?.issue),
    reason: cap(d?.reason, CAP.reason),
    options: Array.isArray(d?.options) ? d.options.slice(0, 6).map((o) => cap(o, CAP.option)) : [],
    createdAt: cap(d?.createdAt, 32),
  };
  if (!out.id || !out.reason || out.options.length < 2) {
    return { ok: false, error: 'escalation refused to publish — needs id, reason, and >=2 option labels' };
  }
  return { ok: true, doc: out };
}
