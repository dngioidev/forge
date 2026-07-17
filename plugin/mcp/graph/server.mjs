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
import { createInterface } from 'node:readline';
import { resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { openDb } from './db.mjs';
import { findComponent, whoUses, similarProps, blastRadius, codeForTicket, reuseCandidates } from './queries.mjs';

export const PROTOCOL_VERSION = '2024-11-05';

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

/** Minimal validator for the schema subset TOOLS uses. */
export function validateInput(schema, args) {
  if (args == null || typeof args !== 'object' || Array.isArray(args)) return 'arguments must be an object';
  for (const key of schema.required ?? []) if (!(key in args)) return `missing required '${key}'`;
  for (const [key, val] of Object.entries(args)) {
    const prop = schema.properties[key];
    if (!prop) return `unknown argument '${key}'`;
    if (prop.type === 'string' && (typeof val !== 'string' || val.length < (prop.minLength ?? 0))) {
      return `'${key}' must be a string of length >= ${prop.minLength ?? 0}`;
    }
    if (prop.type === 'array') {
      if (!Array.isArray(val) || val.length < (prop.minItems ?? 0)) return `'${key}' must be an array with >= ${prop.minItems ?? 0} items`;
      if (prop.items?.type === 'string' && !val.every((v) => typeof v === 'string')) return `'${key}' items must be strings`;
    }
  }
  return null;
}

/** Canonicalize a repo-relative path; traversal outside the root is refused. */
export function canonicalize(root, p) {
  const abs = resolve(root, p);
  const base = resolve(root);
  if (abs !== base && !abs.startsWith(base + sep)) return null;
  return abs.slice(base.length + 1).split(sep).join('/') || null;
}

export function makeHandler({ db, root, graphEnabled }) {
  const rpcError = (id, code, message) => ({ jsonrpc: '2.0', id, error: { code, message } });
  const result = (id, res) => ({ jsonrpc: '2.0', id, result: res });
  const toolText = (id, payload, isError = false) =>
    result(id, { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }], isError });

  return function handle(msg) {
    if (msg?.jsonrpc !== '2.0' || typeof msg.method !== 'string') return rpcError(msg?.id ?? null, -32600, 'invalid request');
    const { id, method, params } = msg;
    if (method.startsWith('notifications/')) return null; // notifications get no response
    switch (method) {
      case 'initialize':
        return result(id, {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: { name: 'forge-graph', version: '0.1.0' },
        });
      case 'ping':
        return result(id, {});
      case 'tools/list':
        return result(id, { tools: TOOLS });
      case 'tools/call': {
        const tool = TOOLS.find((t) => t.name === params?.name);
        if (!tool) return rpcError(id, -32602, `unknown tool '${params?.name}'`);
        if (!graphEnabled) {
          return toolText(id, { error: 'features.graph is off for this repo — enable it in .claude/forge.json and run `node plugin/scripts/graph/graphctl.mjs rebuild` (TypeScript repos only; grep-first is the permanent fallback otherwise).' }, true);
        }
        const args = params.arguments ?? {};
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
      }
      default:
        return rpcError(id, -32601, `method '${method}' not found`);
    }
  };
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

async function main() {
  const root = process.cwd();
  const graphEnabled = await isGraphEnabled(root);
  const db = graphEnabled ? openDb(root) : null;
  const handle = makeHandler({ db, root, graphEnabled });
  const rl = createInterface({ input: process.stdin, terminal: false });
  rl.on('line', (line) => {
    if (!line.trim()) return;
    let msg;
    try { msg = JSON.parse(line); } catch { process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } }) + '\n'); return; }
    const res = handle(msg);
    if (res) process.stdout.write(JSON.stringify(res) + '\n');
  });
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) main();
