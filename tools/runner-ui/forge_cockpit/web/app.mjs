/* Cockpit browser UI (#354) — Variant C split cockpit.
 *
 * Wires the FastAPI cores (#351–#353) to the DOM: a persistent fleet sidebar
 * (live /api/fleet, inline token-gated controls), a main pane toggling Usage
 * (/api/usage chart + breakdown), Terminal (real xterm.js over /api/terminal),
 * and Logs (/api/logs). Same-origin on 127.0.0.1 — the capability token comes
 * from the injected meta tag; mutations carry it in X-Forge-Session, the ws in
 * the `token` query param. */
import {
  formatTokens, formatCost, classifyRunner, statusLabel, controlsFor,
  logLevelOf, dayKey, sparkPath, actionGerund, clockStamp,
} from './format.mjs';

const TOKEN = document.querySelector('meta[name="forge-session-token"]')?.content || '';
const REDUCED_MOTION = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

const STATUS_GLYPH = { online: '●', offline: '○', mistarget: '⚠' };
const PLATFORM = {
  nssm: '⋈ windows-native · nssm',
  systemd: '\u{1F427} wsl2-linux · systemd',
  docker: '⌸ docker',
};

const $ = (sel) => document.querySelector(sel);
function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

async function api(path, opts = {}) {
  const headers = Object.assign({}, opts.headers);
  if (opts.method && opts.method !== 'GET') headers['X-Forge-Session'] = TOKEN;
  const res = await fetch(path, Object.assign({}, opts, { headers }));
  if (!res.ok) {
    const detail = await res.json().catch(() => ({}));
    const err = new Error(detail.detail || `${res.status} ${res.statusText}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

// --------------------------------------------------------------------------- //
// Fleet sidebar.
// --------------------------------------------------------------------------- //
let fleet = [];
let selectedKey = null;
let lastFleetSig = null;

const runnerKey = (r) => `${r.name}::${r.mechanism}`;

/** A stable signature of everything the sidebar renders — so an unchanged 5s poll
 *  does NOT rebuild the DOM and steal focus from a card/control (spec a11y contract). */
function fleetSignature() {
  return selectedKey + '|' + fleet.map((r) => {
    const o = r.online || {};
    return [r.name, r.mechanism, r.service_state, classifyRunner(r), o.online, o.total, o.known].join(':');
  }).join('~');
}

function renderFleet(force = false) {
  const sig = fleetSignature();
  if (!force && sig === lastFleetSig) return; // nothing changed — keep focus intact
  lastFleetSig = sig;
  const list = $('#fleet-list');
  list.setAttribute('aria-busy', 'false');
  list.replaceChildren();
  if (fleet.length === 0) {
    list.append(el('div', 'empty-mini', 'no runners for this repo'));
    return;
  }
  for (const r of fleet) {
    const key = runnerKey(r);
    const status = classifyRunner(r);
    const card = el('div', `mini-card ${status}${selectedKey === key ? ' selected' : ''}`);
    card.setAttribute('role', 'listitem');
    card.tabIndex = 0;
    card.addEventListener('click', () => selectRunner(key));
    card.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); selectRunner(key); } });

    const head = el('div', 'mini-head');
    head.append(el('span', 'mini-name', r.repo || r.name));
    const st = el('span', `mini-status ${status}`);
    st.append(el('span', 'glyph', STATUS_GLYPH[status]), document.createTextNode(' ' + statusLabel(status)));
    head.append(st);
    card.append(head);

    card.append(el('div', 'mini-plat', PLATFORM[r.mechanism] || r.mechanism));
    const online = r.online || {};
    const metaText = online.known
      ? `${online.online ?? 0}/${online.total ?? 0} online · ${r.service_state}`
      : `${r.service_state}`;
    card.append(el('div', 'mini-meta', metaText));

    if (status === 'mistarget') {
      const errline = el('div', 'mini-error', `running, but GitHub reports 0 online runners for ${r.repo}`);
      errline.setAttribute('role', 'alert');
      card.append(errline);
    }

    const actions = el('div', 'mini-actions');
    for (const c of controlsFor(status)) {
      const btn = el('button', 'mini-ctl');
      btn.type = 'button';
      btn.dataset.action = c.action;
      if (c.disabled) btn.disabled = true;
      if (c.reason) btn.title = c.reason;
      btn.textContent = (c.glyph ? c.glyph + ' ' : '') + (c.label || c.action);
      btn.addEventListener('click', (e) => { e.stopPropagation(); runControl(r, c.action, card); });
      actions.append(btn);
    }
    card.append(actions);
    list.append(card);
  }
}

async function runControl(r, action, card) {
  // Clear any prior error line on this card.
  card.querySelectorAll('.mini-errline').forEach((n) => n.remove());
  const buttons = card.querySelectorAll('button.mini-ctl');
  buttons.forEach((b) => { b.disabled = true; });
  const target = [...buttons].find((b) => b.dataset.action === action);
  const restoreLabel = target ? target.textContent : action;
  if (target) {
    target.classList.add('loading');
    target.replaceChildren();
    const spin = el('span', 'spin'); spin.setAttribute('aria-hidden', 'true');
    if (REDUCED_MOTION) spin.style.animation = 'none';
    target.append(spin, document.createTextNode(actionGerund(action)));
  }
  try {
    if (action === 'reprovision') {
      const t = r.target || {};
      await api('/api/provision', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'install', owner: t.owner, repo: t.repo, force: true }),
      });
    } else {
      await api('/api/control', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: r.name, mechanism: r.mechanism, action }),
      });
    }
    await loadFleet(); // re-poll so the card settles on the next real state
  } catch (err) {
    const line = el('div', 'mini-errline', `${action} failed: ${err.message}`);
    line.setAttribute('role', 'alert');
    card.append(line);
    buttons.forEach((b) => { b.disabled = false; });
    if (target) { target.classList.remove('loading'); target.textContent = restoreLabel; }
  }
}

function selectRunner(key) {
  selectedKey = key;
  renderFleet();
  if (currentMode === 'logs') loadLogs();
}

async function loadFleet() {
  try {
    const data = await api('/api/fleet');
    fleet = data.runners || [];
    if (selectedKey && !fleet.some((r) => runnerKey(r) === selectedKey)) selectedKey = null;
    if (!selectedKey && fleet.length) selectedKey = runnerKey(fleet[0]);
    renderFleet();
    stamp(`updated ${clockStamp()}`);
  } catch (err) {
    stamp(`fleet error: ${err.message}`);
  }
}

function stamp(text) { $('#fleet-stamp').textContent = text; }

// --------------------------------------------------------------------------- //
// Usage panel.
// --------------------------------------------------------------------------- //
async function loadUsage() {
  const errBox = $('#usage-error');
  errBox.hidden = true; errBox.replaceChildren();
  try {
    const data = await api('/api/usage');
    renderUsage(data);
  } catch (err) {
    const banner = el('div', 'err-banner', `transcripts unreadable — ${err.message}`);
    banner.setAttribute('role', 'alert');
    errBox.replaceChildren(banner);
    errBox.hidden = false;
  }
}

function renderUsage(data) {
  const byDay = data.by_day || {};
  const byModel = data.by_model || {};
  const records = data.records || [];

  const today = dayKey();
  $('#stat-tokens-today').textContent = formatTokens(byDay[today]?.total_tokens || 0);
  $('#stat-cost-today').textContent = formatCost(byDay[today]?.total_cost || 0);

  const days = Object.keys(byDay).sort();
  const last30 = days.slice(-30);
  const cost30 = last30.reduce((s, k) => s + (byDay[k]?.total_cost || 0), 0);
  $('#stat-cost-30d').textContent = formatCost(cost30);

  // Chart — last 14 days of token totals.
  const last14 = days.slice(-14);
  const series = last14.map((k) => byDay[k]?.total_tokens || 0);
  renderChart(series, records.length === 0);

  // By-model breakdown.
  const rows = Object.values(byModel).sort((a, b) => b.total_tokens - a.total_tokens);
  const box = $('#usage-breakdown');
  box.replaceChildren();
  if (rows.length === 0) {
    box.append(el('div', 'empty-mini', 'no usage recorded yet'));
    return;
  }
  const max = Math.max(...rows.map((r) => r.total_tokens), 1);
  for (const r of rows) {
    const row = el('div', 'breakdown-row');
    row.append(el('span', 'model', r.key || 'unknown'));
    const bar = el('div', 'breakdown-bar');
    const fill = el('i'); fill.style.width = `${(r.total_tokens / max) * 100}%`;
    bar.append(fill);
    row.append(bar);
    row.append(el('span', 'figs tabular', `${formatTokens(r.total_tokens)} · ${formatCost(r.total_cost)}`));
    box.append(row);
  }
}

function renderChart(series, empty) {
  const mount = $('#usage-chart-mount');
  mount.replaceChildren();
  if (empty || series.length === 0) {
    mount.append(el('div', 'empty-mini', 'no usage recorded yet'));
    return;
  }
  const W = 700, H = 170;
  const { line, area, last } = sparkPath(series, W, H);
  const peak = formatTokens(Math.max(...series));
  const svgNS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(svgNS, 'svg');
  svg.setAttribute('class', 'chart');
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.setAttribute('preserveAspectRatio', 'none');
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', `Daily token usage, last ${series.length} days, latest ${formatTokens(series[series.length - 1])} tokens (peak ${peak})`);
  svg.innerHTML = `
    <defs><linearGradient id="tokenGrad" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#f0813f" stop-opacity=".28"/>
      <stop offset="100%" stop-color="#f0813f" stop-opacity="0"/>
    </linearGradient></defs>
    <g class="chart-grid">
      <line x1="0" y1="24" x2="${W}" y2="24"/><line x1="0" y1="70" x2="${W}" y2="70"/>
      <line x1="0" y1="116" x2="${W}" y2="116"/><line x1="0" y1="162" x2="${W}" y2="162"/>
    </g>
    <path class="chart-area" d="${area}"/>
    <path class="chart-line" d="${line}"/>
    ${last ? `<circle class="chart-end-glow" cx="${last.x.toFixed(1)}" cy="${last.y.toFixed(1)}" r="9"/>
    <circle class="chart-end" cx="${last.x.toFixed(1)}" cy="${last.y.toFixed(1)}" r="3.5"/>
    <text class="chart-end-label tabular" x="${(last.x - 36).toFixed(1)}" y="${Math.max(last.y - 8, 10).toFixed(1)}">${formatTokens(series[series.length - 1])}</text>` : ''}`;
  mount.append(svg);
}

// --------------------------------------------------------------------------- //
// Logs panel.
// --------------------------------------------------------------------------- //
async function loadLogs() {
  const body = $('#logs-body');
  const title = $('#logs-title');
  const r = fleet.find((x) => runnerKey(x) === selectedKey);
  if (!r) {
    title.textContent = 'logs';
    body.replaceChildren(el('div', 'empty-mini', 'select a runner to read its logs'));
    return;
  }
  title.textContent = `logs · ${r.repo || r.name}`;
  body.replaceChildren(el('div', 'empty-mini', 'reading…'));
  try {
    const q = new URLSearchParams({ name: r.name, mechanism: r.mechanism, lines: '200' });
    const data = await api(`/api/logs?${q.toString()}`);
    const text = (data.text || '').trimEnd();
    if (!data.ok || !text) {
      body.replaceChildren(el('div', 'empty-mini', data.source ? `no logs (${data.source})` : 'no logs available'));
      return;
    }
    body.replaceChildren();
    for (const raw of text.split('\n')) {
      const lvl = logLevelOf(raw);
      const row = el('div', `log-line ${lvl}`);
      row.append(el('span', 'lvl', lvl));
      row.append(el('span', 'txt', raw));
      body.append(row);
    }
  } catch (err) {
    const banner = el('div', 'err-banner', `logs unreadable — ${err.message}`);
    banner.setAttribute('role', 'alert');
    body.replaceChildren(banner);
  }
}

// --------------------------------------------------------------------------- //
// Terminal — real xterm.js over the /api/terminal websocket.
// --------------------------------------------------------------------------- //
let termStarted = false;
function startTerminal() {
  if (termStarted) return;
  termStarted = true;
  const mount = $('#term-mount');
  const note = $('#term-status');
  if (!window.Terminal) {
    note.textContent = 'terminal unavailable — xterm.js failed to load';
    note.classList.add('error');
    return;
  }
  const term = new window.Terminal({
    cursorBlink: !REDUCED_MOTION,
    fontFamily: "Consolas, 'Cascadia Mono', ui-monospace, monospace",
    fontSize: 13,
    theme: { background: '#0d0b09', foreground: '#d8d2c8', cursor: '#d8d2c8', selectionBackground: '#3a322a' },
  });
  const fit = window.FitAddon ? new window.FitAddon.FitAddon() : null;
  if (fit) term.loadAddon(fit);
  term.open(mount);
  const doFit = () => { try { fit && fit.fit(); } catch { /* pane hidden */ } };
  doFit();

  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${proto}://${location.host}/api/terminal?token=${encodeURIComponent(TOKEN)}`);
  ws.binaryType = 'arraybuffer';
  const enc = new TextEncoder();
  const dec = new TextDecoder();

  ws.onopen = () => {
    note.textContent = 'terminal connected · live shell';
    note.classList.remove('error');
    sendResize();
  };
  ws.onmessage = (ev) => {
    term.write(typeof ev.data === 'string' ? ev.data : new Uint8Array(ev.data));
  };
  ws.onclose = () => { note.textContent = 'terminal disconnected'; note.classList.add('error'); };
  ws.onerror = () => { note.textContent = 'terminal connection error'; note.classList.add('error'); };

  term.onData((d) => { if (ws.readyState === WebSocket.OPEN) ws.send(enc.encode(d)); });

  function sendResize() {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
    }
  }
  const ro = new ResizeObserver(() => { doFit(); sendResize(); });
  ro.observe(mount);
  window.addEventListener('resize', () => { doFit(); sendResize(); });
}

// --------------------------------------------------------------------------- //
// Mode bar (tablist).
// --------------------------------------------------------------------------- //
let currentMode = 'term';
const MODES = { usage: 'm-usage', term: 'm-term', logs: 'm-logs' };
const TABS = { usage: 'tab-usage', term: 'tab-term', logs: 'tab-logs' };

function switchMode(mode) {
  currentMode = mode;
  for (const [m, tabId] of Object.entries(TABS)) {
    const tab = document.getElementById(tabId);
    const selected = m === mode;
    tab.setAttribute('aria-selected', String(selected));
    tab.tabIndex = selected ? 0 : -1;
    document.getElementById(MODES[m]).hidden = !selected;
  }
  if (mode === 'usage') loadUsage();
  else if (mode === 'logs') loadLogs();
  else if (mode === 'term') startTerminal();
}

function wireTabs() {
  const order = ['usage', 'term', 'logs'];
  for (const m of order) {
    const tab = document.getElementById(TABS[m]);
    tab.addEventListener('click', () => switchMode(m));
    tab.addEventListener('keydown', (e) => {
      const i = order.indexOf(m);
      let next = null;
      if (e.key === 'ArrowRight') next = order[(i + 1) % order.length];
      else if (e.key === 'ArrowLeft') next = order[(i - 1 + order.length) % order.length];
      if (next) {
        e.preventDefault();
        document.getElementById(TABS[next]).focus();
        switchMode(next);
      }
    });
  }
}

// --------------------------------------------------------------------------- //
// Health / session pill + boot.
// --------------------------------------------------------------------------- //
async function pollHealth() {
  const pill = $('#session-pill');
  const label = $('#session-label');
  try {
    await api('/api/health');
    pill.classList.remove('down');
    label.textContent = `session ${TOKEN ? TOKEN.slice(0, 4) + '…' : '?'} · connected`;
  } catch {
    pill.classList.add('down');
    label.textContent = 'session · disconnected';
  }
}

function boot() {
  wireTabs();
  switchMode('term'); // Terminal is the default main view (spec).
  loadFleet();
  pollHealth();
  setInterval(loadFleet, 5000);
  setInterval(pollHealth, 15000);
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
else boot();
