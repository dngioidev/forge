/**
 * Denylist liveness/staleness check (#447 AC.3) — diagnostic-only doctor check
 * family, mirroring the module shape `agy-checks.mjs` established for #431/#442
 * (own lib module, unit-testable independent of `runDoctor`'s gh/git wiring).
 *
 * The problem this reports on (#447): the `PreToolUse` denylist hook is wired
 * via `${CLAUDE_PLUGIN_ROOT}/hooks/denylist.mjs` (`plugin/hooks/hooks.json`),
 * which — for a plugin-marketplace install — resolves to the installed cache
 * copy, not a forge checkout's own working tree. An agent editing
 * `plugin/hooks/denylist.mjs` in a checkout is therefore not necessarily
 * editing the rules actually enforced against its own tool calls that
 * session, and a hardening fix doesn't take effect on an existing install
 * until a reinstall (docs/guides/troubleshooting.md §1's ladder).
 *
 * This is deliberately DIAGNOSTIC ONLY — it reports and warns, it changes no
 * resolution behaviour. Whether a forge checkout SHOULD resolve hooks/scripts
 * against its working tree instead of the cache is a separate, still-open
 * decision (#484) — this check takes no position on that question.
 *
 * Comparison basis: file CONTENT, not just `plugin.json` version. A
 * version-only compare would have missed the incident that motivated this
 * ticket (`plugin/scripts/autopilot/ledger.mjs` diverged from the cache copy
 * while both copies still claimed the same plugin version — the version bump
 * for the fix that introduced the divergence hadn't happened yet). Content
 * equality is the only comparison that actually catches that failure mode.
 *
 * Silence contract (mirrors `checkAgyAdapter`'s "no marker, no check" gate):
 * stays completely silent — no row at all — when the current working
 * directory has no `plugin/hooks/denylist.mjs` of its own to compare. A
 * plain consumer install (cache only, no checkout) must never see this check
 * fire; there is nothing for it to compare against.
 */
import { join, dirname, resolve } from 'node:path';
import { readFile, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { ok, warn } from './runner-checks.mjs';
import { resolveOwnManifest } from './agy-checks.mjs'; // generic plugin.json resolution (Claude layout then co-located) — reused as-is, not agy-specific

/** Where a forge checkout's own copy of the hook lives, relative to a repo root. */
export const WORKING_TREE_DENYLIST_RELPATH = join('plugin', 'hooks', 'denylist.mjs');

/**
 * This module's own plugin root: two levels up from `lib/denylist-checks.mjs`
 * — same idiom as `agy-checks.mjs`'s `ownPluginRoot()`. Resolves to whatever
 * root the RUNNING instance of this file was loaded from: the working tree's
 * `plugin/` when invoked directly (e.g. `node plugin/scripts/doctor.mjs`), or
 * the installed cache root when `doctor.mjs` itself was invoked via
 * `${CLAUDE_PLUGIN_ROOT}` — because `hooks/` and `scripts/lib/` always ship
 * from the same install tree copy, this resolves to the same root the
 * PreToolUse hook wiring resolved `${CLAUDE_PLUGIN_ROOT}` to for that session.
 */
export function ownPluginRoot() {
  return resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
}

const readFileSafe = (path) => readFile(path, 'utf8').catch(() => null);
const readMtimeSafe = async (path) => { try { return (await stat(path)).mtime.toISOString(); } catch { return 'unknown'; } };

/**
 * The check itself. `ownRoot` is injectable for tests (same contract as
 * `checkAgyStaleness`'s `ownRoot` param) — defaults to this module's own
 * resolved root, i.e. whatever plugin root is actually live for this process.
 */
export async function checkDenylistStaleness({ cwd, ownRoot = ownPluginRoot() } = {}) {
  const workingTreePath = join(cwd, WORKING_TREE_DENYLIST_RELPATH);
  const workingTreeContent = await readFileSafe(workingTreePath);
  if (workingTreeContent == null) return null; // no working-tree copy here — stay silent (AC.3 negative case)

  const livePath = join(ownRoot, 'hooks', 'denylist.mjs');
  const liveContent = await readFileSafe(livePath);
  if (liveContent == null) {
    return warn(
      'denylist-staleness',
      `resolved live denylist.mjs (${livePath}) could not be read`,
      'check the plugin install / CLAUDE_PLUGIN_ROOT wiring (docs/guides/troubleshooting.md §4)',
    );
  }

  if (liveContent === workingTreeContent) {
    return ok('denylist-staleness', `live denylist.mjs (${livePath}) matches the working tree copy (${workingTreePath})`);
  }

  const [workingManifest, liveManifest, liveMtime] = await Promise.all([
    resolveOwnManifest(join(cwd, 'plugin')),
    resolveOwnManifest(ownRoot),
    readMtimeSafe(livePath),
  ]);
  const workingVersion = workingManifest?.manifest?.version ?? 'unknown';
  const liveVersion = liveManifest?.manifest?.version ?? 'unknown';

  return warn(
    'denylist-staleness',
    `live denylist.mjs (${livePath}, v${liveVersion}, mtime ${liveMtime}) differs from the working tree copy `
      + `(${workingTreePath}, v${workingVersion}) — the rules enforced this session may not be the rules in the working tree`,
    'reinstall/refresh the plugin so the live copy matches the working tree — docs/guides/troubleshooting.md §1 and §4',
  );
}
