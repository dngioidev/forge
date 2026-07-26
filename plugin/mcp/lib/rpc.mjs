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
import { resolve, sep } from 'node:path';

export const PROTOCOL_VERSION = '2024-11-05';

/**
 * Cap on a single newline-delimited JSON-RPC line, measured in characters
 * (4,194,304 — ~4 MiB for ASCII payloads). Large enough for any legitimate tool
 * payload (a glob fan-out, a batch of file paths, an escalation body), bounded
 * against a line — terminated or not — that would otherwise buffer without limit
 * and exhaust memory (#296/AC1 — a DoS vector shared by both servers).
 */
export const MAX_LINE_LENGTH = 4 * 1024 * 1024;

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
    if (prop.type === 'string') {
      if (typeof val !== 'string' || val.length < (prop.minLength ?? 0)) return `'${key}' must be a string of length >= ${prop.minLength ?? 0}`;
      if (prop.maxLength != null && val.length > prop.maxLength) return `'${key}' must be a string of length <= ${prop.maxLength}`;
    }
    if (prop.type === 'integer' && !Number.isInteger(val)) return `'${key}' must be an integer`;
    if (prop.type === 'boolean' && typeof val !== 'boolean') return `'${key}' must be a boolean`;
    if (prop.enum && !prop.enum.includes(val)) return `'${key}' must be one of: ${prop.enum.join(', ')}`;
    if (prop.type === 'array') {
      if (!Array.isArray(val) || val.length < (prop.minItems ?? 0)) return `'${key}' must be an array with >= ${prop.minItems ?? 0} items`;
      if (prop.maxItems != null && val.length > prop.maxItems) return `'${key}' must be an array with <= ${prop.maxItems} items`;
      if (prop.items?.type === 'string') {
        if (!val.every((v) => typeof v === 'string')) return `'${key}' items must be strings`;
        if (prop.items.maxLength != null && !val.every((v) => v.length <= prop.items.maxLength)) return `'${key}' items must each be a string of length <= ${prop.items.maxLength}`;
      }
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
 *
 * The line splitter is hand-rolled (rather than node:readline) so it can enforce
 * `maxLineLength`: an unterminated line that grows past the cap is answered with a
 * parse error and its bytes are dropped up to the next newline, instead of
 * buffering without bound and exhausting memory (#296/AC1). Windows `\r\n` line
 * endings are tolerated (a trailing `\r` is stripped before parsing).
 */
export function serve(handle, { input = process.stdin, output = process.stdout, maxLineLength = MAX_LINE_LENGTH } = {}) {
  let buf = '';
  let dropping = false; // current line already exceeded the cap; discard bytes until the next newline
  input.setEncoding('utf8');

  const processLine = async (raw) => {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    if (!line.trim()) return;
    let msg;
    try { msg = JSON.parse(line); }
    catch { output.write(JSON.stringify(rpcError(null, -32700, 'parse error')) + '\n'); return; }
    const res = await handle(msg);
    if (res) output.write(JSON.stringify(res) + '\n');
  };

  const rejectOverLong = () =>
    output.write(JSON.stringify(rpcError(null, -32700, `parse error: line exceeds the ${maxLineLength}-character limit`)) + '\n');

  input.on('data', (chunk) => {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (dropping) { dropping = false; continue; } // tail of an over-long line — already answered
      if (line.length > maxLineLength) { rejectOverLong(); continue; } // a complete-but-oversized line: reject, never parse
      processLine(line);
    }
    // buf now holds the unterminated remainder (no newline yet).
    if (dropping) {
      buf = ''; // still discarding the tail of an already-rejected line — drop without re-answering
    } else if (buf.length > maxLineLength) {
      rejectOverLong(); // an unterminated line grew past the cap: answer ONCE, then drop to the next newline
      buf = '';
      dropping = true;
    }
  });

  return input;
}
