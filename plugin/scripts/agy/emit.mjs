#!/usr/bin/env node
/**
 * `forge init --host agy` emitter (#289, ADR-0007 AC3).
 *
 * Productizes the proven agy adapter (docs/decisions/0007-agy-adapter/) into a
 * repeatable emit: stage forge as a native Antigravity (`agy`) plugin package.
 *
 * agy ingests the Claude plugin format directly — skills/agents/commands need NO
 * conversion (agy auto-converts commands to skills). Only two things are agy-
 * specific and generated here with COMPUTED paths (never hardcoded to an install):
 *   - `mcp_config.json` — agy reads MCP servers from a plugin-root file, NOT from
 *     plugin.json's `mcpServers` key. Wires forge-graph (and forge-core when #288
 *     lands the server).
 *   - `hooks.json` — agy's named-hook schema, matcher on the tool name
 *     `run_command`, pointing at the agy-deny / agy-capture I/O shims.
 * plus the `plugin.json` marker CO-LOCATED with the component dirs (agy needs them
 * together; the Claude layout splits plugin.json into `.claude-plugin/`).
 *
 * Windows-first + ASCII-only emitted files; long-path aware so `agy plugin install`
 * (which hit MAX_PATH on long source paths during the spike) can stage cleanly.
 */
import { cp, mkdir, writeFile, readFile, rm, access } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** The forge plugin source root — computed from this file (plugin/scripts/agy/emit.mjs -> plugin/). */
export function pluginRoot() {
  return resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
}

/**
 * Windows long-path prefix so paths beyond MAX_PATH (260) still write (AC-289.4).
 * No-op off win32 and on already-prefixed paths.
 */
export function longPath(p) {
  if (process.platform !== 'win32') return p;
  const abs = resolve(p);
  if (abs.startsWith('\\\\?\\')) return abs;
  if (abs.startsWith('\\\\')) return '\\\\?\\UNC\\' + abs.slice(2); // UNC share
  return '\\\\?\\' + abs;
}

/** Forward-slash a path for JSON configs — agy reads these; forward slashes are safe on Windows. */
export function toPosix(p) {
  return p.replace(/\\/g, '/');
}

/** Build the agy MCP registration. forge-core is guarded on server existence (#288 is separate). */
export function buildMcpConfig(destRoot, { hasForgeCore = false } = {}) {
  const mcpServers = {
    'forge-graph': { command: 'node', args: [toPosix(join(destRoot, 'mcp', 'graph', 'server.mjs'))] },
  };
  if (hasForgeCore) {
    mcpServers['forge-core'] = { command: 'node', args: [toPosix(join(destRoot, 'mcp', 'forge', 'server.mjs'))] };
  }
  return { mcpServers };
}

/**
 * Build the agy hooks registration (named-hook schema, matcher `run_command`).
 * Commands quote the computed shim paths and carry a 10s timeout.
 */
export function buildHooksConfig(destRoot) {
  const deny = `node "${toPosix(join(destRoot, 'hooks', 'agy-deny.mjs'))}"`;
  const capture = `node "${toPosix(join(destRoot, 'hooks', 'agy-capture.mjs'))}"`;
  return {
    'forge-safety': {
      PreToolUse: [{ matcher: 'run_command', hooks: [{ type: 'command', command: deny, timeout: 10 }] }],
    },
    'forge-capture': {
      PostToolUse: [{ matcher: 'run_command', hooks: [{ type: 'command', command: capture, timeout: 10 }] }],
    },
  };
}

/** The co-located plugin.json marker: drop Claude-only keys agy ignores ($schema + mcpServers). */
export function buildPluginMarker(sourceManifest) {
  const { $schema, mcpServers, ...marker } = sourceManifest ?? {};
  return marker;
}

// Component dirs agy ingests natively (zero conversion) + the trees the configs point at.
const COMPONENT_DIRS = ['skills', 'agents', 'commands', 'mcp', 'hooks'];

/**
 * Emit the agy plugin package into `destRoot`. Fully manages its own output dir
 * (a clean re-emit each run). Paths in the generated configs are computed from the
 * resolved dest — no hardcoded install path.
 */
export async function emitAgyPlugin({ srcRoot = pluginRoot(), destRoot, log = () => {} } = {}) {
  if (!destRoot) return { ok: false, error: 'destRoot is required' };
  const dest = resolve(destRoot);
  const L = longPath;

  // Clean re-emit: forge fully owns this dir, so a rebuild never leaves stale files.
  await rm(L(dest), { recursive: true, force: true });
  await mkdir(L(dest), { recursive: true });

  const written = [];
  for (const d of COMPONENT_DIRS) {
    const from = join(srcRoot, d);
    try { await access(L(from)); } catch { continue; }
    await cp(L(from), L(join(dest, d)), { recursive: true });
    written.push(`${d}/`);
  }

  // Co-located plugin.json marker.
  const manifest = JSON.parse(await readFile(L(join(srcRoot, '.claude-plugin', 'plugin.json')), 'utf8'));
  await writeFile(L(join(dest, 'plugin.json')), JSON.stringify(buildPluginMarker(manifest), null, 2) + '\n', 'utf8');
  written.push('plugin.json');

  // mcp_config.json — forge-core only when its server actually exists (#288).
  let hasForgeCore = false;
  try { await access(L(join(srcRoot, 'mcp', 'forge', 'server.mjs'))); hasForgeCore = true; } catch { /* not built yet */ }
  await writeFile(L(join(dest, 'mcp_config.json')), JSON.stringify(buildMcpConfig(dest, { hasForgeCore }), null, 2) + '\n', 'utf8');
  written.push('mcp_config.json');

  // hooks.json — agy named-hook schema; overrides the copied Claude hooks/hooks.json at the ROOT.
  await writeFile(L(join(dest, 'hooks.json')), JSON.stringify(buildHooksConfig(dest), null, 2) + '\n', 'utf8');
  written.push('hooks.json');

  log(`agy: emitted forge plugin package at ${dest}`);
  log(`agy: wrote ${written.join(', ')}${hasForgeCore ? ' (forge-graph + forge-core)' : ' (forge-graph)'}`);
  log('agy: install with  agy plugin install "' + dest + '"  (or discover under .agents/plugins/forge/)');
  return { ok: true, dest, written, hasForgeCore };
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  const argv = process.argv.slice(2);
  const outIdx = argv.indexOf('--out');
  const destRoot = outIdx >= 0 ? resolve(process.cwd(), argv[outIdx + 1]) : join(process.cwd(), '.agents', 'plugins', 'forge');
  emitAgyPlugin({ destRoot, log: console.log })
    .then((res) => { if (!res.ok) { console.error(`agy emit failed: ${res.error}`); process.exit(1); } process.exit(0); })
    .catch((err) => { console.error(`agy emit failed: ${err.message}`); process.exit(1); });
}
