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
 * qualifier word ahead of "acceptance criteria") and a dot-separated AC id
 * (`AC.1`, not `AC-1`). Both are now recognised, narrowly: the heading regex
 * accepts one qualifier word from a small curated list (`QUALIFIER_WORDS`)
 * IMMEDIATELY BEFORE the heading term AND requires the literal word
 * "criteria" immediately AFTER it — i.e. it only widens the exact evidenced
 * shape "<qualifier> acceptance criteria", not "<any word> acceptance
 * <anything>". The unqualified path (bare "## Acceptance" / localized
 * headings / `forge.json` config headings) is completely unchanged. This
 * two-sided anchor is deliberate: an adversarial review of an earlier,
 * looser draft (any single word + bare "Acceptance") found real false
 * positives on ordinary two-word phrases where "Acceptance" is used in an
 * unrelated sense — "User Acceptance Testing", "Draft Acceptance email to
 * client", "Client Acceptance sign-off" — none of which are followed by the
 * word "criteria", so the mandatory suffix forecloses that whole class. The
 * id regex accepts `-` or `.` as the AC/number separator.
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

// #491: a small, curated set of qualifier words allowed immediately before
// the heading term — matched case-insensitively, so casing here is just for
// readability. Deliberately NOT a generic "any word" allowance: paired with
// the mandatory trailing "criteria" requirement below, this only widens the
// gate to the exact evidenced convention ("Suggested acceptance criteria")
// and close synonyms, never to an unrelated phrase that merely contains the
// word "Acceptance" ("User Acceptance Testing", "Client Acceptance sign-off").
const QUALIFIER_WORDS = ['Suggested', 'Proposed', 'Draft', 'Revised', 'Updated', 'Sharpened', 'Preliminary'];

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
    const qualifiers = QUALIFIER_WORDS.map(escapeRegExp).join('|');
    // Trailing Unicode-aware word boundary — "Acceptance criteria" matches
    // but a longer word like "Acceptances" does not (parity with the old
    // ASCII \b; safe for diacritic-carrying Vietnamese headings).
    const boundary = '(?![\\p{L}\\p{N}_])';
    // Two heading shapes, either at (indented) line start after the hashes:
    //  1. unqualified — exactly the pre-#491 behavior: the heading term
    //     (built-in/localized/config) sits immediately after the hashes.
    //  2. qualified (#491) — one word from QUALIFIER_WORDS, then the heading
    //     term, then the literal word "criteria". Both ends are anchored:
    //     the qualifier can't be an arbitrary word (closes "User Acceptance
    //     Testing"/"Client Acceptance sign-off"-style false positives), and
    //     "criteria" must follow (closes "Draft Acceptance email to
    //     client"-style false positives even for a qualifier that IS on the
    //     list) — only the exact evidenced shape "<qualifier> acceptance
    //     criteria" is accepted, nothing broader.
    const unqualified = `(?:${alt})${boundary}`;
    const qualified = `(?:${qualifiers})\\s+(?:${alt})\\s+criteria${boundary}`;
    re = new RegExp(`(^|\\n)\\s{0,3}#{1,6}\\s*(?:${qualified}|${unqualified})`, 'iu');
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
