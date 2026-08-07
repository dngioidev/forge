/* Pure presentation helpers for the cockpit UI (#354).
 *
 * Deliberately side-effect-free and DOM-free so they are unit-testable under
 * node (tests/gates/…-style `node:test`) as well as imported by the browser
 * app module. No token counts or costs are invented here — every function is a
 * pure transform of data the FastAPI cores already return. */

/** Compact a token COUNT to a human string: 3_240_000 -> "3.24M", 5100 -> "5.1K". */
export function formatTokens(n) {
  const v = Number(n) || 0;
  const abs = Math.abs(v);
  if (abs >= 1e9) return (v / 1e9).toFixed(2) + 'B';
  if (abs >= 1e6) return (v / 1e6).toFixed(2) + 'M';
  if (abs >= 1e3) return (v / 1e3).toFixed(1) + 'K';
  return String(Math.round(v));
}

/** Format a USD cost: 14.82 -> "$14.82", 0 -> "$0.00". */
export function formatCost(n) {
  const v = Number(n) || 0;
  return '$' + v.toFixed(2);
}

/**
 * Derive the non-color-only fleet status for a serialized runner entry. The
 * cockpit maps binary runner health onto the heat metaphor (spec Token delta):
 * mis-target → heat.alarm, online → success, offline → heat.cool ("cold iron").
 *
 * "mis-target" mirrors the backend's canonical definition
 * (`provision.py:_is_mistargeted`): a *running* service whose *known* repo shows
 * a *known* online count of 0 — a real orphan/misconfiguration (the service is
 * up but GitHub sees no online runner for that repo). This is the spec's error
 * example, and it is data-driven (never name-guessed): a running orphan is
 * flagged even though its service_state is "running". Returns one of
 * 'online' | 'offline' | 'mistarget'.
 */
export function classifyRunner(entry) {
  if (!entry) return 'offline';
  const state = String(entry.service_state || '').toLowerCase();
  const running = state === 'running' || state === 'active';
  const target = entry.target || {};
  const online = entry.online || {};
  if (running && target.known && online.known && online.online === 0) return 'mistarget';
  if (running) return 'online';
  return 'offline';
}

/** The uppercase text label for a status (never colour-only) — spec a11y contract. */
export function statusLabel(status) {
  return { online: 'online', offline: 'offline', mistarget: 'mis-target' }[status] || 'unknown';
}

/**
 * Which control actions apply to a runner in a given status, and whether each is
 * disabled (start-when-online / stop-when-offline are disabled per the states
 * matrix). Returns [{action, label, disabled, reason, glyph?}].
 *
 * A mis-targeted (orphaned) runner gets the spec's error-state controls: stop it
 * and a lock-glyph **re-provision** control (states matrix, error row) — the
 * re-provision reinstalls the repo-scoped service to fix the mismatch. Every
 * mutation carries the session token (the lock glyph flags that capability).
 */
export function controlsFor(status) {
  if (status === 'mistarget') {
    return [
      { action: 'stop', label: 'stop', disabled: false, reason: 'stop this orphaned service' },
      { action: 'reprovision', label: 're-provision', disabled: false, reason: 're-provision this repo-scoped runner', glyph: '\u{1F512}' },
    ];
  }
  const online = status === 'online';
  const offline = status === 'offline';
  return [
    { action: 'start', label: 'start', disabled: online, reason: online ? 'already running' : '' },
    { action: 'stop', label: 'stop', disabled: offline, reason: offline ? 'already stopped' : '' },
    { action: 'restart', label: 'restart', disabled: false, reason: '' },
  ];
}

/** The present-participle label for a control action (loading state, grammar-correct). */
export function actionGerund(action) {
  return {
    start: 'starting…', stop: 'stopping…', restart: 'restarting…', reprovision: 're-provisioning…',
  }[action] || `${action}…`;
}

/** Zero-padded 24-hour clock stamp (HH:MM:SS) for the fleet update line (spec loading state). */
export function clockStamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** Heuristic log level for a raw log line (non-color-only: the level is also text). */
export function logLevelOf(line) {
  const s = String(line || '');
  if (/\b(error|err|fatal|fail(ed|ure)?)\b/i.test(s)) return 'error';
  if (/\b(warn(ing)?)\b/i.test(s)) return 'warn';
  return 'info';
}

/** The local YYYY-MM-DD key for a Date — matches the usage core's by_day keys. */
export function dayKey(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/**
 * Map a 0-100 load percentage onto the smithy heat scale (#395 — machine
 * metrics signature). The same five-step scale already used for fleet urgency
 * (heat.cool -> heat.alarm, see `classifyRunner`'s doc comment) applies here to
 * real hardware load: a machine literally runs hotter under load, so the
 * metaphor is not decorative — cool iron at idle, alarm-red at saturation.
 * Thresholds are a deliberate, moderate curve (not evenly-spaced) so "warm" is
 * the wide, unremarkable middle a runner box sits in most of the time, and
 * "alarm" is reserved for genuine saturation. Returns one of
 * 'cool' | 'warm' | 'spark' | 'ember' | 'alarm'.
 */
export function heatLevel(pct) {
  const v = Number(pct) || 0;
  if (v >= 92) return 'alarm';
  if (v >= 80) return 'ember';
  if (v >= 60) return 'spark';
  if (v >= 30) return 'warm';
  return 'cool';
}

/** The non-color-only text label for a heat level (a11y contract — status is never colour-only). */
export function heatLabel(level) {
  return { cool: 'idle', warm: 'moderate', spark: 'busy', ember: 'high', alarm: 'saturated' }[level] || 'unknown';
}

/** Format a byte count as a human string: 8_000_000_000 -> "8.0 GB". */
export function formatBytes(n) {
  const v = Number(n) || 0;
  if (v >= 1e12) return (v / 1e12).toFixed(1) + ' TB';
  if (v >= 1e9) return (v / 1e9).toFixed(1) + ' GB';
  if (v >= 1e6) return (v / 1e6).toFixed(1) + ' MB';
  if (v >= 1e3) return (v / 1e3).toFixed(1) + ' KB';
  return Math.round(v) + ' B';
}

/**
 * Build an SVG path pair (area + line) from a list of numeric daily totals,
 * scaled into a `width` x `height` box. Pure geometry — returned as
 * { line, area, last:{x,y} }; the caller injects it into the chart <svg>.
 */
export function sparkPath(values, width = 700, height = 170, pad = 8) {
  const vals = (values || []).map((v) => Number(v) || 0);
  if (vals.length === 0) return { line: '', area: '', last: null };
  const max = Math.max(...vals, 1);
  const n = vals.length;
  const step = n > 1 ? width / (n - 1) : 0;
  const y = (v) => height - pad - (v / max) * (height - pad * 2);
  const pts = vals.map((v, i) => [n > 1 ? i * step : width / 2, y(v)]);
  const line = pts.map(([x, yy], i) => (i === 0 ? `M${x.toFixed(1)},${yy.toFixed(1)}` : `L${x.toFixed(1)},${yy.toFixed(1)}`)).join(' ');
  const area = `${line} L${pts[pts.length - 1][0].toFixed(1)},${height} L${pts[0][0].toFixed(1)},${height} Z`;
  const [lx, ly] = pts[pts.length - 1];
  return { line, area, last: { x: lx, y: ly } };
}
