#!/usr/bin/env node
/**
 * Ground gate (#141, spec §3/§5.3): the safety spine of crazy-mode shaping.
 * `forge:shape` may only promote a backlog ticket to Ready from information that
 * ALREADY EXISTS — never by inventing product direction. It emits a sources
 * manifest (one entry per product/business decision it made, each citing where
 * the answer came from); this gate fails, fail-closed, if any decision is
 * uncited or cites a source that doesn't exist. Ungrounded ⇒ escalate, not promote.
 */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readJson } from '../lib/jsonfile.mjs';

/**
 * A source grounds a decision when it points at something real:
 *   - a repo file that exists (optionally with a #anchor) — e.g. docs/product/x.md#goals
 *   - a ticket ref (#123)
 *   - a code-graph ref (graph:Component)
 *   - the ticket body itself (ticket-body / ticket)
 * Anything empty, or a file path that doesn't exist, is NOT grounded.
 * `fileExists` is injected so the rule is unit-testable without a real tree.
 */
export function isGroundedSource(source, fileExists) {
  if (typeof source !== 'string') return false;
  const s = source.trim();
  if (!s) return false;
  if (/^#\d+$/.test(s)) return true;
  if (/^graph:/i.test(s)) return true;
  if (/^ticket(-body)?$/i.test(s)) return true;
  const path = s.replace(/#.*$/, '').trim();
  return path.length > 0 && fileExists(path);
}

/** Pure evaluation: which declared decisions are ungrounded. */
export function evaluateManifest(manifest, fileExists) {
  if (!manifest || typeof manifest !== 'object' || !Array.isArray(manifest.decisions)) {
    return { ok: false, error: 'sources manifest must have a "decisions" array (spec §5.3)' };
  }
  const ungrounded = manifest.decisions
    .filter((d) => !isGroundedSource(d?.source, fileExists))
    .map((d) => ({ claim: (d?.claim ?? '(unnamed decision)'), source: d?.source ?? null }));
  return { ok: ungrounded.length === 0, ungrounded, count: manifest.decisions.length };
}

export async function runGroundGate({ cwd, manifestPath, fileExists, log = console.log }) {
  const manifest = await readJson(resolve(cwd, manifestPath)).catch(() => null);
  if (manifest === null) return { ok: false, error: `sources manifest not readable: ${manifestPath}` };
  const exists = fileExists ?? ((p) => existsSync(resolve(cwd, p)));
  const res = evaluateManifest(manifest, exists);
  if (res.error) { log(`ground gate: ${res.error}`); return res; }
  for (const u of res.ungrounded) log(`✗ ungrounded decision: ${u.claim}${u.source ? ` (bad source: ${u.source})` : ' (no source cited)'}`);
  if (res.ok) log(`ground gate: clean (${res.count} decision(s), all grounded) — safe to promote to Ready`);
  else log(`ground gate: ${res.ungrounded.length}/${res.count} decision(s) ungrounded — escalate for a human decision, do NOT promote (spec §3)`);
  return res;
}

export function parseArgs(argv) {
  const a = { manifest: null };
  for (let i = 0; i < argv.length; i++) if (argv[i] === '--manifest') a.manifest = argv[++i];
  return a;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  const args = parseArgs(process.argv.slice(2));
  if (!args.manifest) { console.error('--manifest <file> is required (the shaper\'s sources manifest)'); process.exit(2); }
  runGroundGate({ cwd: process.cwd(), manifestPath: args.manifest }).then((res) => {
    if (res.error) console.error(res.error);
    process.exit(res.ok ? 0 : 1);
  });
}
