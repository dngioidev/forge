import { access } from 'node:fs/promises';
import { join, isAbsolute } from 'node:path';

/**
 * Report contract (spec §5): markdown body + terminal JSON block. Gates
 * consume the JSON only — never prose. Cite-or-drop (spec §13): findings
 * whose file doesn't exist are dropped, not debated.
 */
const SEVERITIES = ['critical', 'major', 'minor'];

/** Extract the LAST fenced json block (the terminal one). */
export function extractReport(text) {
  if (typeof text !== 'string') return { ok: false, error: 'empty output' };
  const blocks = [...text.matchAll(/```json\s*\r?\n([\s\S]*?)```/g)];
  const raw = blocks.length ? blocks[blocks.length - 1][1] : null;
  if (!raw) return { ok: false, error: 'no terminal JSON block in report (contract violation)' };
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return { ok: false, error: `report JSON unparseable: ${err.message}` };
  }
  const v = validateReport(parsed);
  if (!v.ok) return v;
  return { ok: true, report: parsed, body: text.slice(0, blocks[blocks.length - 1].index).trim() };
}

export function validateReport(r) {
  if (!r || typeof r !== 'object') return { ok: false, error: 'report is not an object' };
  if (r.verdict !== 'pass' && r.verdict !== 'fail') return { ok: false, error: `verdict must be pass|fail, got '${r.verdict}'` };
  if (!Array.isArray(r.findings)) return { ok: false, error: 'findings must be an array' };
  for (const [i, f] of r.findings.entries()) {
    if (!SEVERITIES.includes(f?.severity)) return { ok: false, error: `findings[${i}].severity must be ${SEVERITIES.join('|')}` };
    if (typeof f.summary !== 'string' || !f.summary) return { ok: false, error: `findings[${i}].summary required` };
  }
  return { ok: true };
}

/** Cite-or-drop: keep findings whose cited file exists (or that cite no file). */
export async function citeOrDrop(cwd, findings) {
  const kept = [];
  const dropped = [];
  for (const f of findings) {
    if (!f.file) { kept.push(f); continue; }
    const p = isAbsolute(f.file) ? f.file : join(cwd, f.file);
    try {
      await access(p);
      kept.push(f);
    } catch {
      dropped.push(f);
    }
  }
  return { kept, dropped };
}
