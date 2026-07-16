/**
 * Pre-send scan (spec §13 anti-secret-leak): every composed prompt is scanned
 * before it reaches an external CLI. Pattern hits or high-entropy token-shaped
 * strings ⇒ refuse — the adapter must not send.
 */
const PATTERNS = [
  /gh[pousr]_[A-Za-z0-9]{20,}/,
  /github_pat_[A-Za-z0-9_]{20,}/,
  /xox[baprs]-[A-Za-z0-9-]{10,}/,
  /sk-[A-Za-z0-9_-]{20,}/,
  /AKIA[0-9A-Z]{16}/,
  /-----BEGIN [A-Z ]*PRIVATE KEY/,
  /eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/, // signed JWT
  /\b[A-Z][A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|PASSWD|API_KEY)[A-Z0-9_]*\s*[=:]\s*['"]?[^\s'"]{8,}/,
];

export function shannonEntropy(s) {
  const freq = new Map();
  for (const c of s) freq.set(c, (freq.get(c) ?? 0) + 1);
  let h = 0;
  for (const n of freq.values()) {
    const p = n / s.length;
    h -= p * Math.log2(p);
  }
  return h;
}

/** Long unbroken tokens with near-random entropy look like credentials. */
function highEntropyTokens(text) {
  const hits = [];
  for (const m of text.matchAll(/[A-Za-z0-9+/=_-]{32,}/g)) {
    const tok = m[0];
    // skip obvious non-secrets: paths, repeated chars, hex hashes of committed objects are fine to flag anyway — bias to refuse
    if (/^[0-9a-f]{40}$|^[0-9a-f]{64}$/.test(tok)) continue; // git/sha256 hashes are not credentials
    if (shannonEntropy(tok) >= 4.5) hits.push(tok.slice(0, 8) + '…');
  }
  return hits;
}

export function scanPrompt(text) {
  if (typeof text !== 'string') return { ok: true };
  for (const re of PATTERNS) {
    const m = re.exec(text);
    if (m) return { ok: false, reason: `secret-shaped content (pattern ${re.source.slice(0, 24)}…) at offset ${m.index}` };
  }
  const entropy = highEntropyTokens(text);
  if (entropy.length) return { ok: false, reason: `high-entropy token(s) resembling credentials: ${entropy.slice(0, 3).join(', ')}` };
  return { ok: true };
}
