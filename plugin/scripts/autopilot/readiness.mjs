#!/usr/bin/env node
/**
 * Ticket readiness (#142, spec §6): is a backlog ticket already SHAPED — i.e.
 * does it carry acceptance criteria — or does it still need the shaping front
 * door? A shaped ticket is deliverable (triage only); an unshaped one is `shape`
 * under crazy mode (--shape) or `escalate` in plain autopilot. Pure + testable;
 * the loop reads the issue body and passes the result to select's actionFor.
 *
 * #176: a project's language policy may write its acceptance section under a
 * localized heading (iomanage: Vietnamese `## Tiêu chí nghiệm thu` /
 * `## Tiêu chí chấp nhận`). Matching only the English `## Acceptance` mis-flagged
 * every shaped ticket as UNSHAPED. Recognition is now driven by a heading list:
 * built-in English + Vietnamese defaults, extensible via `readiness.acHeadings`
 * in forge.json (AC2) without a code change.
 *
 * #491: two ordinary, widely-used spellings on this board still defeated the
 * gate — a *qualified* heading (`## Suggested acceptance criteria`: one
 * qualifier word ahead of the heading term) and a dot-separated AC id
 * (`AC.1`, not `AC-1`). Both are now recognised: the heading regex tolerates
 * an optional single qualifier word before the heading term (a longer word
 * sharing the same prefix, e.g. "Acceptances...", still fails — the boundary
 * check still applies immediately after the heading term itself), and the id
 * regex accepts `-` or `.` as the AC/number separator.
 */

/**
 * Built-in acceptance-criteria headings, matched case-insensitively. English
 * plus the common Vietnamese phrasings; a consumer adds more via forge.json.
 */
export const DEFAULT_AC_HEADINGS = [
  'Acceptance',           // en: "Acceptance" / "Acceptance criteria"
  'Tiêu chí nghiệm thu',  // vi
  'Tiêu chí chấp nhận',   // vi
];

const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Extra headings from config, tolerating a missing/malformed block: only
 * non-empty trimmed strings survive. Accepts the whole forge.json config object.
 */
function configHeadings(config) {
  const list = config?.readiness?.acHeadings;
  if (!Array.isArray(list)) return [];
  return list.filter((h) => typeof h === 'string' && h.trim().length > 0).map((h) => h.trim());
}

// The heading list is constant for a run (built-ins + one config), so compile the
// regex once per distinct list instead of on every per-ticket isShaped() call.
const _regexCache = new Map();

/** Build (memoized) the case-insensitive, Unicode-safe heading regex. */
function headingRegex(headings) {
  const key = headings.join('\n'); // newline can't appear inside a heading string
  let re = _regexCache.get(key);
  if (!re) {
    const alt = headings.map(escapeRegExp).join('|');
    // "#{1,6} <heading>" at (indented) line start, tolerating an optional
    // single qualifier word ahead of the heading term (#491: "## Suggested
    // acceptance criteria"). The qualifier word must be followed by
    // whitespace before the heading term is tried, so it can't itself
    // absorb part of the heading term; trailing (?![\p{L}\p{N}_]) is a
    // Unicode-aware word boundary so "Acceptance criteria" matches but a
    // longer word like "Acceptances" does not — parity with the old ASCII
    // \b, safe for diacritic-carrying Vietnamese headings. That boundary
    // check is unaffected by the qualifier, so "## Draft Acceptances of the
    // plan" still fails: no amount of qualifier words turns "Acceptances"
    // into a match for the heading term "Acceptance".
    re = new RegExp(
      `(^|\\n)\\s{0,3}#{1,6}\\s*(?:\\p{L}[\\p{L}\\p{N}'-]*\\s+){0,1}(?:${alt})(?![\\p{L}\\p{N}_])`,
      'iu'
    );
    _regexCache.set(key, re);
  }
  return re;
}

/**
 * True when the body carries acceptance criteria: an acceptance-heading section
 * (English/Vietnamese built-ins + any `config.readiness.acHeadings`) or AC-ids.
 * Body and headings are NFC-normalized first so a visually-identical but NFD-
 * encoded Vietnamese heading (macOS/IME authoring) still matches its NFC literal.
 * @param {string} body   issue body
 * @param {object} [config] loaded forge.json config (for extra AC headings)
 */
export function isShaped(body, config = null) {
  const text = (typeof body === 'string' ? body : '').normalize('NFC');
  const headings = [...DEFAULT_AC_HEADINGS, ...configHeadings(config)].map((h) => h.normalize('NFC'));
  if (headingRegex(headings).test(text)) return true; // "## Acceptance" / localized
  if (/\bAC[-.]?\d+\b/.test(text)) return true;        // AC-1 / AC12 / AC.1 references
  return false;
}
