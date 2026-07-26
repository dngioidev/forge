#!/usr/bin/env node
/**
 * Graph MCP server (spec §9; SP8 T4) — newline-delimited JSON-RPC 2.0 over
 * stdio, hand-rolled (zero deps; the protocol surface we need is tiny:
 * initialize, tools/list, tools/call, ping). Hardening: every tool input is
 * schema-validated, file paths are canonicalized to the repo root, SQL is
 * parameterized in the layers below. With features.graph off the server stays
 * up and answers every call with a teaching error — a crash-looping server
 * would be noisier than an honest refusal.
 */
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { openDb } from './db.mjs';
import { findComponent, whoUses, similarProps, blastRadius, codeForTicket, reuseCandidates } from './queries.mjs';
import { PROTOCOL_VERSION, validateInput, canonicalize, rpcError, toolText, makeRpcHandler, serve } from '../lib/rpc.mjs';

// Re-export the shared transport primitives so existing importers (graph tests)
// keep resolving them from this module after the rpc.mjs factoring (#288).
export { PROTOCOL_VERSION, validateInput, canonicalize };

export const TOOLS = [
  { name: 'find_component', description: 'Find components/exports by name substring — ask before writing anything new.',
    inputSchema: { type: 'object', properties: { query: { type: 'string', minLength: 1 } }, required: ['query'] } },
  { name: 'who_uses', description: 'Who renders/imports a symbol or uses a token — impact of touching it.',
    inputSchema: { type: 'object', properties: { symbol: { type: 'string', minLength: 1 } }, required: ['symbol'] } },
  { name: 'similar_props', description: 'Props interfaces ranked by member overlap — near-duplicates to reuse instead.',
    inputSchema: { type: 'object', properties: { members: { type: 'array', items: { type: 'string' }, minItems: 1 } }, required: ['members'] } },
  { name: 'blast_radius', description: 'Transitive dependents (files, tests, stories) of a set of files — the test set for a change.',
    inputSchema: { type: 'object', properties: { files: { type: 'array', items: { type: 'string' }, minItems: 1 } }, required: ['files'] } },
  { name: 'code_for_ticket', description: 'Files linked to a ticket via commit-message issue refs.',
    inputSchema: { type: 'object', properties: { ticket: { type: 'string', minLength: 1 } }, required: ['ticket'] } },
  { name: 'reuse_candidates', description: 'Existing exports/components ranked against a feature description — check before creating files.',
    inputSchema: { type: 'object', properties: { description: { type: 'string', minLength: 3 } }, required: ['description'] } },
];

export function makeHandler({ db, root, graphEnabled }) {
  // Per-tool logic; the protocol envelope (initialize/ping/tools/list/tools-call
  // routing, unknown-tool/method, notifications) lives in the shared rpc.mjs.
  const onCall = ({ id, tool, args }) => {
    if (!graphEnabled) {
      return toolText(id, { error: 'features.graph is off for this repo — enable it in .claude/forge.json and run `node plugin/scripts/graph/graphctl.mjs rebuild` (TypeScript repos only; grep-first is the permanent fallback otherwise).' }, true);
    }
    const invalid = validateInput(tool.inputSchema, args);
    if (invalid) return rpcError(id, -32602, `invalid arguments for ${tool.name}: ${invalid}`);
    try {
      switch (tool.name) {
        case 'find_component': return toolText(id, findComponent(db, args.query));
        case 'who_uses': return toolText(id, whoUses(db, args.symbol));
        case 'similar_props': return toolText(id, similarProps(db, args.members));
        case 'blast_radius': {
          const rels = args.files.map((f) => canonicalize(root, f));
          if (rels.some((r) => r === null)) return rpcError(id, -32602, 'invalid arguments for blast_radius: paths must stay inside the repo root');
          return toolText(id, blastRadius(db, rels));
        }
        case 'code_for_ticket': return toolText(id, codeForTicket(db, args.ticket));
        case 'reuse_candidates': return toolText(id, reuseCandidates(db, args.description));
      }
    } catch (e) {
      return toolText(id, { error: `graph query failed: ${e.message}` }, true);
    }
    return rpcError(id, -32603, 'unreachable');
  };
  return makeRpcHandler({ serverInfo: { name: 'forge-graph', version: '0.1.0' }, tools: TOOLS, onCall });
}

export async function isGraphEnabled(root) {
  try {
    const { loadConfig } = await import('../../scripts/lib/config.mjs');
    const cfg = await loadConfig(root);
    return cfg.ok && cfg.config?.features?.graph === true;
  } catch {
    return false;
  }
}

/**
 * Per-call graph state (#105) — re-reads features.graph on every call so a
 * toggle in forge.json (+ `graphctl rebuild`) takes effect without restarting
 * the MCP process. The db is opened lazily on the first enabled call and
 * memoized (no reopen per call); flipping the flag off closes and drops it.
 */
export function makeGraphState(root, { open = openDb, isEnabled = isGraphEnabled } = {}) {
  let db = null;
  return async function resolve() {
    const enabled = await isEnabled(root);
    if (enabled && !db) db = open(root);
    else if (!enabled && db) { try { db.close?.(); } catch { /* ignore */ } db = null; }
    return { enabled, db };
  };
}

async function main() {
  const root = process.cwd();
  const state = makeGraphState(root);
  // Resolve enabled/db fresh per line (via serve's async handle) so a
  // features.graph toggle takes effect without restarting the process (#105).
  serve(async (msg) => {
    const { enabled, db } = await state();
    return makeHandler({ db, root, graphEnabled: enabled })(msg);
  });
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) main();
