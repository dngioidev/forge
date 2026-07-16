/**
 * Managed-block helpers. Forge only ever rewrites content between its own
 * markers — everything outside survives byte-for-byte (spec §5/§6 law,
 * same pattern as the GEMINI.md/AGENTS.md managed blocks).
 */
export const begin = (marker) => `<!-- forge:${marker}:begin -->`;
export const end = (marker) => `<!-- forge:${marker}:end -->`;

/** Replace the marked block in `text`, or append one when absent. */
export function upsertBlock(text, marker, content) {
  const b = begin(marker);
  const e = end(marker);
  const block = `${b}\n${content}\n${e}`;
  const re = new RegExp(`${escapeRe(b)}[\\s\\S]*?${escapeRe(e)}`);
  if (re.test(text)) return text.replace(re, block);
  const base = text.trimEnd();
  return base.length ? `${base}\n\n${block}\n` : `${block}\n`;
}

/** Single-marker comments (trail/receipt/log rows): marker + body. */
export function markedBody(marker, content) {
  return `<!-- forge:${marker} -->\n${content}`;
}

export function hasMarker(text, marker) {
  return typeof text === 'string' && text.includes(`<!-- forge:${marker} -->`);
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
