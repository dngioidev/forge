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
 * in forge.json (AC2) without a code change. The `AC-\d+` id match is unchanged.
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

/** Build the case-insensitive, Unicode-safe heading regex from a heading list. */
function headingRegex(headings) {
  const alt = headings.map(escapeRegExp).join('|');
  // "#{1,6} <heading>" at (indented) line start; trailing (?![\p{L}\p{N}_]) is a
  // Unicode-aware word boundary so "Acceptance criteria" matches but a longer
  // word like "Acceptances" does not — parity with the old ASCII \b, safe for
  // diacritic-carrying Vietnamese headings.
  return new RegExp(`(^|\\n)\\s{0,3}#{1,6}\\s*(?:${alt})(?![\\p{L}\\p{N}_])`, 'iu');
}

/**
 * True when the body carries acceptance criteria: an acceptance-heading section
 * (English/Vietnamese built-ins + any `config.readiness.acHeadings`) or AC-ids.
 * @param {string} body   issue body
 * @param {object} [config] loaded forge.json config (for extra AC headings)
 */
export function isShaped(body, config = null) {
  const text = typeof body === 'string' ? body : '';
  const headings = [...DEFAULT_AC_HEADINGS, ...configHeadings(config)];
  if (headingRegex(headings).test(text)) return true; // "## Acceptance" / localized
  if (/\bAC-?\d+\b/.test(text)) return true;           // AC-1 / AC12 references
  return false;
}
