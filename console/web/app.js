/**
 * Console page logic (#39) — extracted from index.html so the pure parts are
 * testable without a browser. DOM wiring only runs when a document exists.
 *
 * Behavior laws (ticket AC-B6.*):
 *  - the poll never destroys typing: any focused or dirty input pauses refresh
 *  - resolving a decision takes two deliberate clicks (arm -> confirm, auto-disarm)
 *  - errors render inline on the card; refreshes announce via the aria-live stamp
 */

export const GLYPH_ORDER = [
  ['security-response', '🔒'], ['incident', '🔥'], ['awaiting-decision', '🚩'], ['building', '▶'], ['idle', '·'],
];

/** Worst active situation across repos -> its glyph (for the tab title). */
export function worstGlyph(repos) {
  for (const [key, glyph] of GLYPH_ORDER) {
    if ((repos ?? []).some((r) => r.situation === key)) return glyph;
  }
  return '·';
}

export function relativeTime(iso, now = Date.now()) {
  const t = Date.parse(iso ?? '');
  if (!Number.isFinite(t)) return '';
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86_400) return `${Math.round(s / 3600 * 10) / 10}h ago`;
  return `${Math.round(s / 86_400 * 10) / 10}d ago`;
}

/** Two-step confirm state machine: arm(id) -> true when that id is already armed. */
export function makeConfirm(disarmMs = 6000, timers = { set: setTimeout, clear: clearTimeout }) {
  let armed = null;
  let timer = null;
  return {
    armedId: () => armed,
    disarm() { if (timer) timers.clear(timer); armed = null; timer = null; },
    arm(id) {
      if (armed === id) { this.disarm(); return true; } // second click: go
      this.disarm();
      armed = id;
      timer = timers.set(() => { armed = null; timer = null; }, disarmMs);
      return false;
    },
  };
}

/** Refresh must pause while the user is mid-answer anywhere in the page. */
export function typingInProgress(doc, confirm) {
  if (confirm.armedId()) return true;
  const active = doc.activeElement;
  if (active && active.tagName === 'INPUT') return true;
  return [...doc.querySelectorAll('input')].some((i) => i.value.trim() !== '');
}

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function repoCard(r, now = Date.now()) {
  if (r.error) return `<div class="repo"><div class="repo-head"><span class="name">${esc(r.repo)}</span></div><div class="error">${esc(r.error)}</div></div>`;
  const l = r.ledger;
  const ledger = l && l.total ? `<div class="ledger" role="img" aria-label="tasks: ${l.done} done, ${l.inProgress} in progress of ${l.total}">
      <span class="done" style="width:${(100 * l.done / l.total).toFixed(0)}%"></span>
      <span class="active" style="width:${(100 * l.inProgress / l.total).toFixed(0)}%"></span></div>` : '';
  const decisions = (r.pendingDecisions ?? []).map((d) => `
    <div class="decision" data-decision="${esc(d.id)}">
      <div class="reason">🚩 <b>#${esc(d.issue)}</b> ${esc(d.reason)} <span class="age">${d.ageHours != null ? esc(d.ageHours) + 'h old' : ''}</span></div>
      <div class="opts">${(d.options ?? []).map((o, i) => `<button data-id="${esc(d.id)}" data-answer="${esc(`option ${i + 1} — ${o}`)}"><span class="label">${i + 1}. ${esc(o)}</span></button>`).join('')}</div>
      <div class="free"><input data-free="${esc(d.id)}" placeholder="or type an answer"><button data-id="${esc(d.id)}" data-from-input="1">send</button></div>
      <div class="errline" role="alert"></div>
    </div>`).join('');
  const journal = (r.journalTail ?? []).slice(-5).reverse().map((e) =>
    `<div title="${esc(e.ts ?? '')}">${esc(relativeTime(e.ts, now))} · ${esc(e.kind)}${e.gate ? ' (' + esc(e.gate) + ')' : ''}${e.ticket ? ' ' + esc(e.ticket) : ''}</div>`).join('');
  // §3b conformance badge (C6): green = inside the lines, amber names the drift.
  const cf = r.conformance;
  const badge = cf ? `<span class="badge ${esc(cf.level)}" title="${esc((cf.checks ?? []).map((c) => `${c.pass ? '✓' : '✗'} ${c.name}: ${c.why}`).join('\n'))}">${cf.level === 'green' ? '🟢 conforms' : '🟡 ' + esc(cf.failing ?? 'drift')}</span>` : '';
  // §3a trace phase strip (C6): the current step is lit.
  const t = r.trace;
  const strip = t && t.steps ? `<div class="trace" role="img" aria-label="work trace">${t.steps.map((s, i) =>
    `${i ? '<span class="tsep">›</span>' : ''}<span class="tstep ${esc(s.state)}${s.key === t.current ? ' cur' : ''}" title="${esc(s.label)}">${esc(s.key)}</span>`).join('')}</div>` : '';
  return `<div class="repo ${esc(r.situation ?? '')}">
    <div class="repo-head"><span class="glyph">${esc(r.glyph ?? '·')}</span><span class="name">${esc(r.repo)}</span>
      <span class="situation ${esc(r.situation)}">${esc(r.situation)}</span>${badge}</div>
    <div class="meta">${r.ticket ? `<b>${esc(r.ticket)}</b> · ` : ''}${esc(r.branch ?? 'no branch')}${l && l.total ? ` · tasks ${l.done}/${l.total}` : ''}</div>
    ${strip}${ledger}${decisions}
    ${journal ? `<div class="journal">${journal}</div>` : ''}
  </div>`;
}

// ---------- forge-control panel (C3) ----------

/** Verbs whose button needs the two-step confirm before it fires. */
export const CONTROL_DESTRUCTIVE = ['kill-all'];
/** Verbs offered as one-click buttons in the panel (the safe subset of the allowlist). */
export const CONTROL_VERBS = ['pause', 'resume', 'kill-all'];

/** Render the control tab from GET /api/control/state. Pure — no DOM, testable. */
export function controlPanel(state, now = Date.now()) {
  const s = state ?? {};
  const rows = (items, fn, empty) => (items && items.length ? items.map(fn).join('') : `<div class="cempty">${empty}</div>`);
  const queue = rows(s.queue, (e) =>
    `<div class="crow">#${esc(e.seq)} <b>${esc(e.state)}</b> ${esc(e.repo)}${e.ticket ? ' #' + esc(e.ticket) : ''} <span class="cid">${esc(e.id)}</span></div>`, 'queue empty');
  const sessions = rows(s.sessions, (x) =>
    `<div class="crow session ${esc(x.state)}">${esc(x.id)} <b>${esc(x.state)}</b> ${esc(x.repo)}${x.ticket ? ' #' + esc(x.ticket) : ''} pid:${esc(x.pid ?? '—')} · ${esc(relativeTime(x.lastHeartbeat, now))}</div>`, 'no sessions');
  const audit = rows((s.audit ?? []).slice(0, 12), (a) =>
    `<div class="crow">${esc(relativeTime(a.ts, now))} · <b>${esc(a.verb)}</b>${a.repo ? ' ' + esc(a.repo) : ''}${a.ticket ? ' #' + esc(a.ticket) : ''} <span class="cby">${esc(a.by ?? '')}</span></div>`, 'no audit yet');
  const buttons = CONTROL_VERBS.map((v) =>
    `<button data-verb="${esc(v)}"${CONTROL_DESTRUCTIVE.includes(v) ? ' data-destructive="1"' : ''}>${esc(v)}</button>`).join('');
  const pausedBanner = s.paused ? `<div class="cbanner">⏸ PAUSED — the runner spawns nothing until resumed (human-only clear)</div>` : '';
  // §3c alerts (C7): a red banner when anything is wrong + a feed of the events.
  const alerts = s.alerts ?? [];
  const alertBanner = alerts.length ? `<div class="cbanner alert" role="alert">🔴 ${alerts.length} alert${alerts.length === 1 ? '' : 's'} — ${esc(alerts[0].message)}</div>` : '';
  const alertFeed = alerts.length ? `<div class="ccol alerts"><h3>alerts</h3>${alerts.slice(0, 12).map((a) =>
    `<div class="crow alert ${esc(a.severity)}"><b>${esc(a.kind)}</b> ${esc(a.repo ?? '')}${a.ticket ? ' ' + esc(a.ticket) : ''}</div>`).join('')}</div>` : '';
  return `<h2>forge-control${s.paused ? ' · paused' : ''}${alerts.length ? ' · ' + alerts.length + ' alert' + (alerts.length === 1 ? '' : 's') : ''}</h2>${alertBanner}${pausedBanner}
    <div class="cverbs">${buttons}</div>
    <div class="cgrid">
      <div class="ccol"><h3>queue</h3>${queue}</div>
      <div class="ccol"><h3>sessions</h3>${sessions}</div>
      <div class="ccol"><h3>audit</h3>${audit}</div>
    </div>
    ${alertFeed}
    <div class="errline" role="alert"></div>`;
}

// ---------- DOM wiring (browser only) ----------
if (typeof document !== 'undefined') {
  const confirm = makeConfirm();
  const $ = (s) => document.querySelector(s);

  const errlineFor = (id) => document.querySelector(`[data-decision="${CSS.escape(id)}"] .errline`);

  async function decide(id, answer, btn) {
    if (!answer || !answer.trim()) return;
    if (!confirm.arm(id)) {
      btn.classList.add('armed');
      btn.dataset.original = btn.dataset.original ?? btn.innerHTML;
      btn.innerHTML = `<span class="label">click again to confirm → ${btn.dataset.fromInput ? 'send typed answer' : answer.replace(/</g, '&lt;')}</span>`;
      setTimeout(() => { if (confirm.armedId() !== id) refresh(); }, 6200);
      return;
    }
    try {
      const res = await fetch('/api/decide', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id, answer: answer.trim() }) });
      const out = await res.json();
      if (!res.ok) {
        const line = errlineFor(id);
        if (line) line.textContent = `couldn't resolve: ${out.error ?? res.status} — refresh and retry, or answer on the GitHub issue`;
        return;
      }
      refresh(true);
    } catch {
      const line = errlineFor(id);
      if (line) line.textContent = 'server unreachable — is the daemon still running?';
    }
  }

  document.addEventListener('click', (ev) => {
    const btn = ev.target.closest('button[data-id]');
    if (!btn) return;
    const answer = btn.dataset.fromInput
      ? document.querySelector(`input[data-free="${CSS.escape(btn.dataset.id)}"]`)?.value
      : btn.dataset.answer;
    decide(btn.dataset.id, answer, btn);
  });

  async function refresh(force = false) {
    if (!force && typingInProgress(document, confirm)) return; // never destroy an answer in progress
    try {
      const s = await (await fetch('/api/state')).json();
      confirm.disarm();
      $('#machine').textContent = s.machineId;
      $('#stamp').textContent = `updated ${new Date(s.generatedAt).toLocaleTimeString()}`;
      $('#repos').innerHTML = s.repos.map((r) => repoCard(r)).join('');
      $('#empty').hidden = s.repos.length > 0;
      document.title = `${worstGlyph(s.repos)} forge console`;
    } catch {
      $('#stamp').textContent = 'server unreachable';
    }
  }

  // ----- control panel wiring -----
  const controlConfirm = makeConfirm();

  async function refreshControl() {
    try {
      const cs = await (await fetch('/api/control/state')).json();
      const el = $('#control');
      el.innerHTML = controlPanel(cs);
      el.classList.toggle('paused', !!cs.paused);
    } catch { /* control base may not exist yet — leave the panel as-is */ }
  }

  async function runVerb(verb, btn) {
    const destructive = btn.dataset.destructive === '1';
    if (destructive && !controlConfirm.arm(verb)) {
      btn.classList.add('armed');
      btn.dataset.original = btn.dataset.original ?? btn.textContent;
      btn.textContent = `confirm ${verb}?`;
      setTimeout(() => { if (controlConfirm.armedId() !== verb) refreshControl(); }, 6200);
      return;
    }
    const errline = $('#control .errline');
    try {
      const res = await fetch('/api/control', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ verb }) });
      const out = await res.json();
      if (!res.ok) { if (errline) errline.textContent = `control: ${out.error ?? res.status}`; return; }
      refreshControl();
    } catch {
      if (errline) errline.textContent = 'server unreachable — is the console still running?';
    }
  }

  document.addEventListener('click', (ev) => {
    const btn = ev.target.closest('#control button[data-verb]');
    if (!btn) return;
    runVerb(btn.dataset.verb, btn);
  });

  refresh();
  refreshControl();
  setInterval(refresh, 5000);
  setInterval(refreshControl, 5000);
}
