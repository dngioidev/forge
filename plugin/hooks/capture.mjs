#!/usr/bin/env node
/**
 * PostToolUse capture hook (spec §8; SP7 T1). Failing Bash commands feed the
 * learning-loop journal: gate scripts as `gate-fail`, everything else as
 * `cmd-fail`. Read-only commands are excluded AT CAPTURE TIME — the tasky-ai
 * journal-noise lesson (a grep with no match exits 1; that is not a lesson).
 * Best-effort and silent: no determinable exit code, or any internal error,
 * means capture nothing (exit 0). A capture hook never blocks the session.
 */
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { append } from '../scripts/lib/journal.mjs';
import { parseBranch } from '../scripts/lib/ticket.mjs';
import { splitSegments } from '../scripts/lib/shell-split.mjs';

const READ_ONLY = new Set([
  'grep', 'rg', 'ls', 'cat', 'head', 'tail', 'find', 'which', 'echo', 'pwd',
  'wc', 'sort', 'uniq', 'cut', 'tr', 'diff', 'file', 'stat', 'du', 'df',
  'type', 'env', 'printenv', 'date', 'cygpath', 'true', 'cd', 'export',
]);
const GIT_READ = new Set([
  'log', 'status', 'diff', 'show', 'rev-parse', 'describe', 'blame',
  'shortlog', 'ls-files', 'ls-remote', 'reflog', 'remote', 'grep', 'cat-file',
]);
const GH_READ = new Set(['view', 'list', 'status', 'checks', 'diff']);
const GATE_RE = /scripts[\\/]+gates[\\/]+([a-z]+)\.mjs/;

function segmentIsReadOnly(segment) {
  const tokens = segment.trim().split(/\s+/).filter(Boolean);
  let i = 0;
  while (i < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i])) i++;
  if (i >= tokens.length) return true; // bare env assignment
  const t0 = tokens[i].replace(/^["'(]+/, '');
  if (READ_ONLY.has(t0)) return true;
  if (t0 === 'git') return GIT_READ.has(tokens[i + 1]);
  if (t0 === 'gh') return tokens.slice(i + 1, i + 4).some((t) => GH_READ.has(t));
  return false;
}

export function isReadOnly(command) {
  // Shared splitter (#320) — one copy of the shell-segment regex across both hooks.
  // It trims each segment; segmentIsReadOnly also trims, so behavior is unchanged.
  const segments = splitSegments(command);
  return segments.length > 0 && segments.every(segmentIsReadOnly);
}

/** Exit code from whatever shape the harness sends; null = undeterminable. */
export function extractExit(response) {
  if (typeof response === 'string') {
    const m = /exit(?:ed with)?(?: code)?[ :]+(\d+)/i.exec(response);
    return m ? Number(m[1]) : null;
  }
  if (!response || typeof response !== 'object') return null;
  for (const k of ['exitCode', 'exit_code', 'code', 'returncode']) {
    if (typeof response[k] === 'number') return response[k];
  }
  if (typeof response.error === 'string') return extractExit(response.error);
  if (response.is_error === true || response.success === false) return 1;
  return null;
}

export function lastErrLine(response) {
  const text = typeof response === 'string'
    ? response
    : [response?.stderr, response?.error, response?.stdout].find((t) => typeof t === 'string' && t.trim()) ?? '';
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  return (lines[lines.length - 1] ?? '').slice(0, 200);
}

/** Pure classifier: payload -> {capture:false} | {capture:true, kind, data}. */
export function classify(payload, branch = null) {
  if (payload?.tool_name !== 'Bash') return { capture: false };
  const cmd = payload.tool_input?.command;
  if (typeof cmd !== 'string' || !cmd.trim()) return { capture: false };
  const exit = extractExit(payload.tool_response);
  if (exit === null || exit === 0) return { capture: false };
  if (isReadOnly(cmd)) return { capture: false };

  const parsed = parseBranch(branch ?? '');
  const gate = GATE_RE.exec(cmd);
  return {
    capture: true,
    kind: gate ? 'gate-fail' : 'cmd-fail',
    data: {
      tool: 'Bash',
      ...(gate ? { gate: gate[1] } : {}),
      cmd: cmd.slice(0, 300),
      exit,
      err_line: lastErrLine(payload.tool_response),
      ticket: parsed.ticket ? `#${parsed.ticket}` : null,
      branch: branch || null,
    },
  };
}

export async function currentBranch(cwd) {
  try {
    const head = await readFile(join(cwd, '.git', 'HEAD'), 'utf8');
    const m = /^ref: refs\/heads\/(.+)$/m.exec(head.trim());
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

async function main() {
  let raw = '';
  for await (const chunk of process.stdin) raw += chunk;
  const payload = JSON.parse(raw);
  const cwd = payload.cwd ?? process.cwd();
  const res = classify(payload, await currentBranch(cwd));
  if (res.capture) await append(cwd, res.kind, res.data);
  return 0;
}

// Self-exec guard is ANCHORED via exact module-URL identity (AC-289.3): main()
// only fires when THIS file is the entry point, so importing capture.mjs (or a
// host shim importing it) has zero side effects — no stdin consumption, no exit.
const isMain = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) main().then((code) => process.exit(code)).catch(() => process.exit(0)); // fail open
