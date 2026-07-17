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
  return `<div class="repo ${esc(r.situation ?? '')}">
    <div class="repo-head"><span class="glyph">${esc(r.glyph ?? '·')}</span><span class="name">${esc(r.repo)}</span>
      <span class="situation ${esc(r.situation)}">${esc(r.situation)}</span></div>
    <div class="meta">${r.ticket ? `<b>${esc(r.ticket)}</b> · ` : ''}${esc(r.branch ?? 'no branch')}${l && l.total ? ` · tasks ${l.done}/${l.total}` : ''}</div>
    ${ledger}${decisions}
    ${journal ? `<div class="journal">${journal}</div>` : ''}
  </div>`;
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

  refresh();
  setInterval(refresh, 5000);
}
