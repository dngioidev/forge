/**
 * agy / Antigravity adapter health checks (#431). Doctor-only consumer today —
 * kept in its own module (mirroring why runner-checks.mjs exists: doctor +
 * runner-check share logic) so each check is unit-testable in isolation from
 * runDoctor's gh/git wiring, and so a future second consumer (a dedicated
 * `forge agy check` preflight, if one is ever warranted) costs nothing to add.
 * #431 deliberately did NOT add that preflight — see the module-level note on
 * `checkAgyAdapter` below for why doctor alone was judged sufficient.
 *
 * Gating signal (AC.1): an EMITTED PACKAGE on disk at the conventional
 * `.agents/plugins/forge/` location — NOT `features.agy`. `features.agy` is the
 * advisory Gemini-offload flag (`plugin/scripts/agy/core.mjs`) and says nothing
 * about whether this repo ever ran `init --host agy`; conflating the two would
 * nag agy-offload users who never emitted a package, or stay silent for
 * adopters who did but never flipped the offload flag. Absent the marker, the
 * whole adapter block is a no-op — exactly as silent as doctor's runner block
 * when `runner.enabled` is unset (doctor.mjs:200-202).
 *
 * `features.agy` gets its OWN, independently-gated check (AC.4, `checkAgyOffload`)
 * — it fires whenever the flag is on, regardless of whether a package was ever
 * emitted, because the offload path (`agy --print`) needs `agy` on PATH too and
 * has nothing to do with the adapter package.
 *
 * A custom `--out` staging path is not detected — only the documented,
 * recommended default (`.agents/plugins/forge/`, in-place discovery) is
 * checked. Every function degrades to a warn/skip on a read failure — never
 * throws, never crashes doctor (same contract as runner-checks.mjs).
 */
import { join, dirname, resolve } from 'node:path';
import { readFile, readdir, access, lstat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { ok, warn, fail } from './runner-checks.mjs'; // generic {name,level,msg,hint} result shape — not runner-specific
import { compareVersions } from './runner-release.mjs'; // generic dotted-version compare, reused as-is
import { readJson } from './jsonfile.mjs'; // parse-or-throw; every call site opts into "unreadable/malformed -> null" via .catch
import { agyEnabled } from '../agy/core.mjs';

/** Where `init --host agy` emits by default (no `--out`) — the recommended, verified-primary path (docs/guides/cross-gai.md). */
export const AGY_PKG_RELPATH = join('.agents', 'plugins', 'forge');

/** Parse-or-null: missing, unreadable, AND malformed all degrade to null here — every caller in this module treats "can't read it" and "it's garbage" the same way (a fail/warn row, never a throw). */
const readJsonSafe = (path) => readJson(path).catch(() => null);

async function pathExists(path) {
  try { await access(path); return true; } catch { return false; }
}

/** True (and returns the parsed marker) when `dir` carries a forge-emitted `plugin.json` ({"name":"forge",...}). */
export async function readEmittedMarker(dir) {
  const marker = await readJsonSafe(join(dir, 'plugin.json'));
  return marker?.name === 'forge' ? marker : null;
}

/**
 * This module's own plugin root: two levels up from `lib/agy-checks.mjs`,
 * mirroring `emit.mjs`'s `pluginRoot()`. Resolves to `plugin/` when this file
 * is running from the canonical Claude-layout checkout, and to the emitted
 * package's own root when this SAME file is the copy inside
 * `.agents/plugins/forge/scripts/lib/agy-checks.mjs` — `emit.mjs`'s
 * COMPONENT_DIRS copies `scripts/` wholesale, `lib/` included.
 */
export function ownPluginRoot() {
  return resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
}

/**
 * Resolve the manifest of the forge instance CURRENTLY RUNNING this check —
 * tries the Claude layout first (`<root>/.claude-plugin/plugin.json`), then the
 * agy co-located layout (`<root>/plugin.json`, i.e. this file IS an emitted
 * copy). Returns null when neither resolves (unrecognised install shape) —
 * staleness then stays silent rather than guessing.
 */
export async function resolveOwnManifest(root = ownPluginRoot()) {
  const claudePath = join(root, '.claude-plugin', 'plugin.json');
  const claude = await readJsonSafe(claudePath);
  if (claude) return { manifest: claude, path: claudePath };
  const coLocatedPath = join(root, 'plugin.json');
  const co = await readJsonSafe(coLocatedPath);
  if (co) return { manifest: co, path: coLocatedPath };
  return null;
}

/**
 * Staleness (AC.2) — consumes #433's documented seam (cross-gai.md "Updating
 * the emitted package", install.md's Antigravity section) instead of building
 * a parallel version check: compare the emitted package's `plugin.json` version
 * against the CURRENTLY-RUNNING forge instance's own version. Silent (returns
 * null, never a check row — never a false signal) when:
 *  - this instance's own version can't be resolved (unrecognised layout);
 *  - this instance IS the emitted copy itself (self-comparison against its own
 *    version always reads "current" regardless of real drift — meaningless).
 *    That remains the one case the guides still ask the operator to check by
 *    hand: pull a reference forge checkout and compare there.
 */
export async function checkAgyStaleness({ pkgDir, marker, ownRoot = ownPluginRoot() } = {}) {
  const own = await resolveOwnManifest(ownRoot);
  if (!own?.manifest?.version) return null;
  if (resolve(own.path) === resolve(join(pkgDir, 'plugin.json'))) return null; // self-comparison — no signal
  const ownV = own.manifest.version;
  const emittedV = marker?.version;
  if (!emittedV) {
    return warn('agy-staleness', 'emitted plugin.json has no version field', 're-emit with a current forge checkout: node <forge checkout>/plugin/scripts/init.mjs --host agy');
  }
  const cmp = compareVersions(emittedV, ownV);
  if (cmp < 0) {
    return warn(
      'agy-staleness',
      `emitted agy package is v${emittedV}, this forge install is v${ownV} — the package is stale`,
      're-run node <forge checkout>/plugin/scripts/init.mjs --host agy to refresh, then commit the diff (docs/guides/cross-gai.md#updating-the-emitted-package)',
    );
  }
  if (cmp > 0) {
    return warn('agy-staleness', `emitted agy package is v${emittedV}, newer than this forge install's v${ownV}`, 'this forge instance may itself be behind — git pull the checkout driving it');
  }
  return ok('agy-staleness', `emitted package is current (v${emittedV})`);
}

const SHIMS = ['hooks/agy-deny.mjs', 'hooks/agy-capture.mjs'];

/** Integrity of the three generated files + the two host-mode I/O shims (AC.1). */
export async function checkAgyPackageIntegrity({ pkgDir, marker }) {
  const mcp = await readJsonSafe(join(pkgDir, 'mcp_config.json'));
  const hooks = await readJsonSafe(join(pkgDir, 'hooks.json'));
  const problems = [];
  if (!marker?.name) problems.push('plugin.json: missing name');
  if (!mcp?.mcpServers?.['forge-graph']?.command) problems.push('mcp_config.json: missing forge-graph server');
  if (!hooks?.['forge-safety']?.PreToolUse?.length) problems.push('hooks.json: missing forge-safety PreToolUse');
  if (!hooks?.['forge-capture']?.PostToolUse?.length) problems.push('hooks.json: missing forge-capture PostToolUse');
  for (const shim of SHIMS) {
    if (!(await pathExists(join(pkgDir, shim)))) problems.push(`missing ${shim}`);
  }
  if (problems.length) {
    return fail('agy-package', `emitted package integrity: ${problems.join('; ')}`, 're-emit: node <forge checkout>/plugin/scripts/init.mjs --host agy');
  }
  return ok('agy-package', 'plugin.json, mcp_config.json, hooks.json, and the deny/capture shims all present + well-formed');
}

/**
 * #294 regression class: `${CLAUDE_PLUGIN_ROOT}` surviving into emitted skill/
 * command prose. `emit.mjs` rewrites this at emit time
 * (`rewriteAgyRuntimePaths`); this re-checks the emitted COPY post-hoc, catching
 * a hand-edit, a partial/interrupted emit, or a future emitter regression. Scans
 * only `skills/` and `commands/` — the only trees `emit.mjs` rewrites — and only
 * `.md` files, never following a symlink (same defensive guard as the emitter)
 * — including the `skills/`/`commands/` TOP-LEVEL directory itself: an emitted
 * package is read from a checked-out tree that could, in principle, carry a
 * hostile PR's crafted content (e.g. `skills/` replaced with a symlink to an
 * arbitrary directory), so the entry guard below has to apply before the first
 * `readdir` too, not just to entries discovered during the walk.
 */
export async function findUnrewrittenPlaceholders(pkgDir) {
  const hits = [];
  for (const d of ['skills', 'commands']) {
    const top = join(pkgDir, d);
    const topStat = await lstat(top).catch(() => null);
    if (!topStat || topStat.isSymbolicLink() || !topStat.isDirectory()) continue;
    const walk = async (dir) => {
      const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
      for (const e of entries) {
        const p = join(dir, e.name);
        if (e.isSymbolicLink()) continue;
        if (e.isDirectory()) { await walk(p); continue; }
        if (!e.name.toLowerCase().endsWith('.md')) continue;
        const text = await readFile(p, 'utf8').catch(() => '');
        if (text.includes('${CLAUDE_PLUGIN_ROOT}')) hits.push(p.slice(pkgDir.length + 1).replace(/\\/g, '/'));
      }
    };
    await walk(top);
  }
  return hits;
}

export async function checkAgyRewrite({ pkgDir }) {
  const hits = await findUnrewrittenPlaceholders(pkgDir);
  if (hits.length) {
    return warn(
      'agy-rewrite',
      `\${CLAUDE_PLUGIN_ROOT} not rewritten in ${hits.length} file(s), e.g. ${hits[0]} (#294 bug class)`,
      're-emit the package: node <forge checkout>/plugin/scripts/init.mjs --host agy',
    );
  }
  return ok('agy-rewrite', 'no unrewritten ${CLAUDE_PLUGIN_ROOT} found in skills/commands');
}

/**
 * `.forge/agy-journal.jsonl` sanity (`agy-capture.mjs`'s output). Absent is
 * NORMAL for a freshly-emitted, not-yet-used package — silent (null), never a
 * warn. Only speaks up when the file exists and a line doesn't parse as JSON.
 */
export async function checkAgyJournal({ cwd }) {
  let text;
  try { text = await readFile(join(cwd, '.forge', 'agy-journal.jsonl'), 'utf8'); } catch { return null; }
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  if (lines.length === 0) return null;
  const badLines = [];
  for (let i = 0; i < lines.length; i++) {
    try { JSON.parse(lines[i]); } catch { badLines.push(i + 1); }
  }
  if (badLines.length) {
    return warn(
      'agy-journal',
      `.forge/agy-journal.jsonl has ${badLines.length} malformed line(s) (first at line ${badLines[0]})`,
      'safe to delete — agy-capture.mjs regenerates it (metadata-only, never raw command output)',
    );
  }
  return ok('agy-journal', `.forge/agy-journal.jsonl valid (${lines.length} entr${lines.length === 1 ? 'y' : 'ies'})`);
}

/** `agy --version` on PATH. `exec` injectable for tests (same contract as runner-checks.mjs). */
async function agyOnPath(exec) {
  try { return (await exec('agy', ['--version'])).ok; } catch { return false; }
}

/**
 * The full adapter-health block (AC.1/AC.2), appended to doctor's results ONLY
 * when an emitted package is found at the conventional `.agents/plugins/forge/`
 * location — fully silent otherwise (AC.5's negative case). Doctor-plus-preflight
 * vs. doctor-only (#225/#245 precedent): this ticket kept doctor-only — the
 * runner preflight exists because adopting a self-hosted runner is a one-time,
 * multi-step, security-relevant setup (private-repo guard, PAT store, Docker,
 * service registration) worth a dedicated go/no-go gate before flipping a
 * switch. The agy adapter has no comparable "flip a switch" moment: emitting is
 * a single idempotent command, and `agy plugin validate forge` is already the
 * host-side adoption gate (documented in cross-gai.md Step 4). A second forge
 * command duplicating that role would add surface without adding signal, so
 * this block folds into doctor's existing always-available health check instead.
 */
export async function checkAgyAdapter({ cwd, exec, results, pkgRelPath = AGY_PKG_RELPATH }) {
  const pkgDir = join(cwd, pkgRelPath);
  const marker = await readEmittedMarker(pkgDir);
  if (!marker) return; // no emitted package here — stay completely silent (AC.1/AC.5)

  results.push((await agyOnPath(exec))
    ? ok('agy-cli', 'agy on PATH')
    : warn('agy-cli', 'emitted agy package found but `agy` is not on PATH', 'install Antigravity, or add agy to PATH (docs/guides/cross-gai.md prerequisites)'));

  results.push(await checkAgyPackageIntegrity({ pkgDir, marker }));
  results.push(await checkAgyRewrite({ pkgDir }));

  const staleness = await checkAgyStaleness({ pkgDir, marker });
  if (staleness) results.push(staleness);

  const journal = await checkAgyJournal({ cwd });
  if (journal) results.push(journal);
}

/**
 * `features.agy` offload-reachability (AC.4) — INDEPENDENT of `checkAgyAdapter`
 * above: fires whenever the advisory Gemini-offload flag is on, whether or not
 * an adapter package was ever emitted, because `agy --print` (core.mjs) needs
 * `agy` on PATH regardless. Silent when the flag is off — same shape as every
 * other feature-gated doctor block (deploy, graph).
 */
export async function checkAgyOffload({ cfg, exec }) {
  if (!agyEnabled(cfg)) return null;
  return (await agyOnPath(exec))
    ? ok('agy-offload', 'features.agy is on and `agy` is reachable on PATH')
    : warn('agy-offload', 'features.agy is on but `agy` is not reachable on PATH', 'install Antigravity / add agy to PATH, or turn features.agy off (docs/guides/install.md#4-optional-wiring-per-feature-all-off-by-default)');
}
