import { describe, it, expect } from 'vitest';
import { Readable } from 'node:stream';
import { serve, MAX_LINE_LENGTH, validateInput } from '../../plugin/mcp/lib/rpc.mjs';

// A microtask/IO flush so async processLine writes settle before assertions.
const flush = () => new Promise((r) => setImmediate(r));

/** Drive serve() over an in-memory stream pair; collect what it writes and what the handler saw. */
function harness({ maxLineLength } = {}) {
  const input = new Readable({ read() {} });
  const written = [];
  const output = { write: (s) => { written.push(s); return true; } };
  const handled = [];
  serve(async (msg) => { handled.push(msg); return { jsonrpc: '2.0', id: msg.id, result: {} }; }, { input, output, maxLineLength });
  return { input, written, handled };
}

describe('AC-296.1: serve() caps stdio line length against unbounded buffering', () => {
  it('AC-296.1: an over-long unterminated line is answered with a parse error and never handled', async () => {
    const { input, written, handled } = harness({ maxLineLength: 100 });
    input.push('x'.repeat(250)); // 250 chars, no newline -> exceeds the cap
    await flush();
    expect(handled).toHaveLength(0); // never parsed/handled (no OOM buffering, no hang)
    expect(written.some((w) => /parse error/.test(w) && /limit/.test(w))).toBe(true);
    // the rejected line's tail is discarded up to the next newline; a valid line after it still works
    input.push('leftover-garbage\n' + JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'ping' }) + '\n');
    await flush();
    expect(handled).toEqual([{ jsonrpc: '2.0', id: 7, method: 'ping' }]);
  });

  it('AC-296.1: a complete, over-cap, newline-terminated line in one chunk is rejected, not handled', async () => {
    const { input, written, handled } = harness({ maxLineLength: 100 });
    // The common client pattern: assemble the full JSON payload, then one write(json + "\n").
    input.push('x'.repeat(250) + '\n');
    await flush();
    expect(handled).toHaveLength(0); // the oversized complete line never reaches the handler
    expect(written.some((w) => /parse error/.test(w) && /limit/.test(w))).toBe(true);
    // the loop stays alive: a valid line right after it is still parsed
    input.push(JSON.stringify({ jsonrpc: '2.0', id: 4, method: 'ping' }) + '\n');
    await flush();
    expect(handled).toEqual([{ jsonrpc: '2.0', id: 4, method: 'ping' }]);
  });

  it('AC-296.1: a growing unterminated over-cap line is answered exactly once (no response amplification)', async () => {
    const { input, written, handled } = harness({ maxLineLength: 100 });
    // Stream far more than the cap, in several chunks, with no newline until the end.
    for (let i = 0; i < 5; i++) input.push('y'.repeat(80));
    await flush();
    input.push('\n' + JSON.stringify({ jsonrpc: '2.0', id: 5, method: 'ping' }) + '\n');
    await flush();
    const errors = written.filter((w) => /parse error/.test(w) && /limit/.test(w));
    expect(errors).toHaveLength(1); // one rejected line -> one error, not one per chunk
    expect(handled).toEqual([{ jsonrpc: '2.0', id: 5, method: 'ping' }]);
  });

  it('AC-296.1: a line exactly at the cap is still accepted (the cap is an over-limit guard, not a floor)', async () => {
    const payload = { jsonrpc: '2.0', id: 3, method: 'ping' };
    const line = JSON.stringify(payload);
    const { input, handled } = harness({ maxLineLength: line.length + 1 });
    input.push(line + '\n');
    await flush();
    expect(handled).toEqual([payload]);
  });

  it('AC-296.1: normal newline-delimited lines parse and Windows CRLF is tolerated; default cap is 4 MiB', async () => {
    expect(MAX_LINE_LENGTH).toBe(4 * 1024 * 1024);
    const { input, handled } = harness();
    input.push(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }) + '\r\n');
    input.push(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'ping' }) + '\n');
    await flush();
    expect(handled).toEqual([
      { jsonrpc: '2.0', id: 1, method: 'ping' },
      { jsonrpc: '2.0', id: 2, method: 'ping' },
    ]);
  });

  it('AC-296.1: a malformed (but bounded) line still answers with a parse error and keeps the loop alive', async () => {
    const { input, written, handled } = harness();
    input.push('{not json}\n' + JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'ping' }) + '\n');
    await flush();
    expect(written.some((w) => /parse error/.test(w))).toBe(true);
    expect(handled).toEqual([{ jsonrpc: '2.0', id: 9, method: 'ping' }]); // loop survives the bad line
  });
});

describe('AC-296.2: validateInput enforces maxItems / maxLength ceilings', () => {
  const schema = {
    type: 'object',
    properties: {
      tag: { type: 'string', maxLength: 4 },
      files: { type: 'array', items: { type: 'string', maxLength: 3 }, minItems: 1, maxItems: 2 },
    },
    required: [],
  };
  it('AC-296.2: an over-long string is rejected', () => {
    expect(validateInput(schema, { tag: 'toolong' })).toMatch(/'tag' must be a string of length <= 4/);
  });
  it('AC-296.2: too many array items are rejected', () => {
    expect(validateInput(schema, { files: ['a', 'b', 'c'] })).toMatch(/'files' must be an array with <= 2 items/);
  });
  it('AC-296.2: an over-long array item is rejected', () => {
    expect(validateInput(schema, { files: ['abcd'] })).toMatch(/'files' items must each be a string of length <= 3/);
  });
  it('AC-296.2: in-bounds values pass (ceilings do not change existing floors)', () => {
    expect(validateInput(schema, { tag: 'ok', files: ['ab', 'cd'] })).toBe(null);
  });
});
