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
import { cp, mkdir, writeFile, readFile, rm, access, stat, readdir } from 'node:fs/promises';
import { join, resolve, dirname, sep } from 'node:path';
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

/** True when `child` is `parent` itself or nested under it (both resolved). */
function isAtOrUnder(parent, child) {
  const p = resolve(parent);
  const c = resolve(child);
  return c === p || c.startsWith(p.endsWith(sep) ? p : p + sep);
}

/**
 * Blast-radius guard (AC-289.4): the emitter recursively clears its dest, so it must
 * NEVER be pointed at a directory forge does not own. Returns a refusal string, or
 * null when `dest` is safe to emit into. Caught cases:
 *   - a filesystem root;
 *   - the current working dir or any ancestor of it (`--out .` / `--out ..` would
 *     delete the operator's working tree, incl. .git);
 *   - a dir that contains the forge plugin source;
 *   - a path with shell-unsafe characters (they would also break the hooks.json
 *     command string, which agy's contract requires to be a quoted string).
 */
export function unsafeDestReason(dest, { cwd, srcRoot }) {
  const d = resolve(dest);
  if (dirname(d) === d) return `refusing to emit into a filesystem root: ${d}`;
  if (isAtOrUnder(d, cwd)) return `refusing to emit into '${d}': it is the current directory or an ancestor of it (a re-emit would delete your working tree). Pass --out <a dedicated subdirectory>.`;
  if (isAtOrUnder(d, srcRoot)) return `refusing to emit into '${d}': it contains the forge plugin source. Choose a separate --out dir.`;
  if (/["\r\n\t`]/.test(d)) return `refusing to emit into a path with shell-unsafe characters: ${d}`;
  return null;
}

/** A dir counts as forge-owned (safe to clear) only when it carries the emitted plugin.json marker. */
async function isForgeOwned(dest) {
  try {
    const marker = JSON.parse(await readFile(longPath(join(dest, 'plugin.json')), 'utf8'));
    return marker?.name === 'forge';
  } catch { return false; }
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

// Component dirs agy ingests natively (skills/agents/commands, zero conversion) + the
// trees the configs and skills point at: mcp (server), hooks (shims), scripts + bin
// (the `forge <area> <cmd>` shell tier the skills shell out to — copied so the paths
// they reference physically exist in the package).
const COMPONENT_DIRS = ['skills', 'agents', 'commands', 'mcp', 'hooks', 'scripts', 'bin'];

/**
 * Emit the agy plugin package into `destRoot`. Fully manages its own output dir
 * (a clean re-emit each run). Paths in the generated configs are computed from the
 * resolved dest — no hardcoded install path.
 */
export async function emitAgyPlugin({ srcRoot = pluginRoot(), destRoot, cwd = process.cwd(), log = () => {} } = {}) {
  if (!destRoot) return { ok: false, error: 'destRoot is required' };
  srcRoot = resolve(srcRoot);
  const dest = resolve(destRoot);
  const L = longPath;

  // Blast-radius guard: never recursively delete a dir forge does not own.
  const reason = unsafeDestReason(dest, { cwd, srcRoot });
  if (reason) return { ok: false, error: reason };

  const existing = await stat(L(dest)).catch(() => null);
  if (existing) {
    if (!existing.isDirectory()) return { ok: false, error: `refusing to overwrite non-directory: ${dest}` };
    const owned = await isForgeOwned(dest);
    const entries = await readdir(L(dest)).catch(() => []);
    if (!owned && entries.length > 0) {
      return { ok: false, error: `refusing to overwrite ${dest}: it is not empty and carries no forge plugin.json marker (not a forge-emitted package). Choose an empty or dedicated --out dir.` };
    }
    // Clean re-emit only over a dir forge itself previously emitted — never leaves stale files.
    if (owned) await rm(L(dest), { recursive: true, force: true });
  }
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

  // hooks.json — agy named-hook schema at the plugin ROOT (agy reads this, not the
  // Claude-format hooks/hooks.json that came along in the hooks/ copy).
  await writeFile(L(join(dest, 'hooks.json')), JSON.stringify(buildHooksConfig(dest), null, 2) + '\n', 'utf8');
  written.push('hooks.json');

  log(`agy: emitted forge plugin package at ${dest}`);
  log(`agy: wrote ${written.join(', ')}${hasForgeCore ? ' (forge-graph + forge-core)' : ' (forge-graph)'}`);
  log('agy: install with  agy plugin install "' + dest + '" (or discover under .agents/plugins/forge/)');
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
