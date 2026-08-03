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
