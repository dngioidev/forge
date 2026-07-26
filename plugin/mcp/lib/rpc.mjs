#!/usr/bin/env node
/**
 * Shared JSON-RPC 2.0 transport for forge MCP servers (#288, ADR-0007 §b).
 *
 * Factored out of mcp/graph/server.mjs so forge-graph and forge-core sit on ONE
 * hardened, zero-dependency, newline-delimited-stdio transport. This module owns
 * only the host-neutral protocol surface:
 *   - the envelope router (initialize / ping / tools/list / tools/call, plus
 *     invalid-request, notification, and unknown-method handling),
 *   - `validateInput` (the minimal schema-subset validator both servers use),
 *   - `canonicalize` (repo-root path confinement),
 *   - the `{ content:[{ type:'text', text }], isError }` tool-result shape,
 *   - the stdin line loop (`serve`).
 * Per-server tool logic is injected via `onCall`; nothing here is graph- or
 * board-specific, so neither server can regress the other's transport.
 */
import { createInterface } from 'node:readline';
import { resolve, sep } from 'node:path';

export const PROTOCOL_VERSION = '2024-11-05';

/** JSON-RPC response builders (id-parameterized; pure). */
export const rpcError = (id, code, message) => ({ jsonrpc: '2.0', id, error: { code, message } });
export const rpcResult = (id, res) => ({ jsonrpc: '2.0', id, result: res });
export const toolText = (id, payload, isError = false) =>
  rpcResult(id, { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }], isError });

/** Minimal validator for the schema subset the tool inputSchemas use. */
export function validateInput(schema, args) {
  if (args == null || typeof args !== 'object' || Array.isArray(args)) return 'arguments must be an object';
  for (const key of schema.required ?? []) if (!(key in args)) return `missing required '${key}'`;
  for (const [key, val] of Object.entries(args)) {
    const prop = schema.properties[key];
    if (!prop) return `unknown argument '${key}'`;
    if (prop.type === 'string' && (typeof val !== 'string' || val.length < (prop.minLength ?? 0))) {
      return `'${key}' must be a string of length >= ${prop.minLength ?? 0}`;
    }
    if (prop.type === 'integer' && !Number.isInteger(val)) return `'${key}' must be an integer`;
    if (prop.type === 'boolean' && typeof val !== 'boolean') return `'${key}' must be a boolean`;
    if (prop.enum && !prop.enum.includes(val)) return `'${key}' must be one of: ${prop.enum.join(', ')}`;
    if (prop.type === 'array') {
      if (!Array.isArray(val) || val.length < (prop.minItems ?? 0)) return `'${key}' must be an array with >= ${prop.minItems ?? 0} items`;
      if (prop.items?.type === 'string' && !val.every((v) => typeof v === 'string')) return `'${key}' items must be strings`;
    }
    if (prop.type === 'object' && (val == null || typeof val !== 'object' || Array.isArray(val))) return `'${key}' must be an object`;
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

/**
 * Build the JSON-RPC envelope handler. Routes the protocol methods and delegates
 * `tools/call` (after the tool exists) to `onCall({ id, tool, args })`, which may
 * be sync (graph) or async (forge) and returns a JSON-RPC response object (or a
 * Promise of one). Notifications get no response (null). This is the ~50-line
 * skeleton both servers share.
 */
export function makeRpcHandler({ serverInfo, tools, onCall, protocolVersion = PROTOCOL_VERSION }) {
  return function handle(msg) {
    if (msg?.jsonrpc !== '2.0' || typeof msg.method !== 'string') return rpcError(msg?.id ?? null, -32600, 'invalid request');
    const { id, method, params } = msg;
    if (method.startsWith('notifications/')) return null; // notifications get no response
    switch (method) {
      case 'initialize':
        return rpcResult(id, { protocolVersion, capabilities: { tools: {} }, serverInfo });
      case 'ping':
        return rpcResult(id, {});
      case 'tools/list':
        return rpcResult(id, { tools });
      case 'tools/call': {
        const tool = tools.find((t) => t.name === params?.name);
        if (!tool) return rpcError(id, -32602, `unknown tool '${params?.name}'`);
        return onCall({ id, tool, args: params?.arguments ?? {} });
      }
      default:
        return rpcError(id, -32601, `method '${method}' not found`);
    }
  };
}

/**
 * Newline-delimited JSON-RPC stdio loop. `handle(msg)` may return a response
 * object, `null` (notification), or a Promise of either. A malformed line
 * answers with a parse error and never crashes the loop.
 */
export function serve(handle, { input = process.stdin, output = process.stdout } = {}) {
  const rl = createInterface({ input, terminal: false });
  rl.on('line', async (line) => {
    if (!line.trim()) return;
    let msg;
    try { msg = JSON.parse(line); }
    catch { output.write(JSON.stringify(rpcError(null, -32700, 'parse error')) + '\n'); return; }
    const res = await handle(msg);
    if (res) output.write(JSON.stringify(res) + '\n');
  });
  return rl;
}
