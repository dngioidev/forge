/**
 * actions/runner release pinning (#233). One source of truth for BOTH:
 *  - init --runner scaffold-time pinning (Dockerfile + setup-runner.ps1), and
 *  - doctor's staleness check (is the scaffolded pin behind the latest release?).
 *
 * GitHub DEPRECATES old runner versions ("Runner version vX is deprecated and
 * cannot receive messages"), and an ephemeral/JIT runner can't auto-update — so a
 * fixed pin silently stops receiving jobs. Scaffolding must pin the CURRENT
 * release, and doctor must warn when a pin falls behind.
 *
 * The published SHA-256 for each asset lives in the release BODY between
 * `<!-- BEGIN SHA <arch> -->…<!-- END SHA <arch> -->` markers.
 */

/**
 * Last-known-good pin — a REAL, buildable release (v2.336.0), never a REPLACE-ME.
 * Used only when the live gh lookup fails, so a fresh scaffold still builds offline.
 * Keep current-ish; doctor stays silent (never warns) against this fallback.
 */
export const FALLBACK_RUNNER_PIN = Object.freeze({
  version: '2.336.0',
  linux: '04cf0be1aff4c3ec3554466c39124ca250e3effd8873bb7e8d68535aa9505d5d',
  win: 'd59123a43003e357b0805b5d0f611d0bd2f65ab67d51bd070dd4e7a0f685c162',
});

const shaMarker = (arch) =>
  new RegExp(`<!--\\s*BEGIN SHA ${arch}\\s*-->\\s*([0-9a-fA-F]{64})\\s*<!--\\s*END SHA ${arch}\\s*-->`);

/**
 * Parse a release tag + body into a pin ({version, linux, win}) or null when the
 * version or either SHA can't be extracted (caller falls back).
 */
export function parseRunnerRelease(tagName, body) {
  const version = String(tagName ?? '').trim().replace(/^v/, '');
  const linux = shaMarker('linux-x64').exec(String(body ?? ''))?.[1];
  const win = shaMarker('win-x64').exec(String(body ?? ''))?.[1];
  if (!/^\d+\.\d+\.\d+/.test(version) || !linux || !win) return null;
  return { version, linux: linux.toLowerCase(), win: win.toLowerCase() };
}

/**
 * Fetch the CURRENT actions/runner release pin (version + linux-x64/win-x64 SHA).
 * Degrades to FALLBACK_RUNNER_PIN (a real, buildable pin — NEVER a REPLACE-ME) with
 * a warning when the gh call fails or the release can't be parsed. `source` is
 * 'live' on a successful fetch, 'fallback' otherwise, so callers (doctor) can stay
 * silent rather than warn against a stale fallback.
 */
export async function fetchRunnerPin(gh, log = () => {}) {
  const res = await gh(['api', 'repos/actions/runner/releases/latest'], { parseJson: true });
  if (res.ok && res.json) {
    const pin = parseRunnerRelease(res.json.tag_name, res.json.body);
    if (pin) return { ...pin, source: 'live' };
  }
  const why = res.ok ? 'release body missing SHA markers' : (res.stderr?.split(/\r?\n/).find((l) => l.trim()) || 'gh api failed');
  log(`warning: could not resolve the current actions/runner release (${why}) — pinning last-known-good v${FALLBACK_RUNNER_PIN.version}. Re-run once gh is reachable, or bump the pin if it has since deprecated (#233).`);
  return { ...FALLBACK_RUNNER_PIN, source: 'fallback' };
}

/** Parse the pinned RUNNER_VERSION from a scaffolded Dockerfile / setup-runner.ps1. */
export function parsePinnedVersion(text) {
  if (!text) return null;
  // Dockerfile:  ARG RUNNER_VERSION=2.336.0
  // ps1:         [string]$RunnerVersion = '2.336.0',
  const m = /ARG\s+RUNNER_VERSION=([0-9]+\.[0-9]+\.[0-9]+)/.exec(text)
    || /\$RunnerVersion\s*=\s*'([0-9]+\.[0-9]+\.[0-9]+)'/.exec(text);
  return m ? m[1] : null;
}

/** Semver-ish compare of two dotted versions: <0, 0, >0. Non-numeric parts → 0. */
export function compareVersions(a, b) {
  const pa = String(a).split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b).split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}
