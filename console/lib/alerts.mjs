/**
 * Alerts (C7/#77; spec §3c). Pure derivation of "something went wrong" signals
 * from state the pipeline already writes: failure-kind journal events + control
 * sessions whose heartbeat has gone stale. No new capture. Honest limit: this is
 * local best-effort-loud alerting (banner / feed / opt-in toast) — true
 * push-to-phone stays the Firebase step.
 */

/** Journal kinds that mean trouble (spec §3c). */
export const ALERT_KINDS = ['gate-fail', 'cmd-fail', 'blocked-edit', 'backend-fallback', 'incident', 'respond-open'];

const HOUR = 3_600_000;
const sev = (kind) => (kind === 'incident' || kind === 'respond-open' ? 'high' : kind === 'stale-session' ? 'high' : 'warn');

function ageLabel(ts, now) {
  const t = Date.parse(ts ?? '');
  if (!Number.isFinite(t)) return '';
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  return `${Math.round((s / 3600) * 10) / 10}h ago`;
}

/**
 * Compute the current alert set.
 *   repos:    [{ repo, journalTail:[{ts, kind, ticket, gate}], error? }]
 *   sessions: [{ id, state, repo, ticket, lastHeartbeat }]
 * A journal event alerts if its kind is in ALERT_KINDS and it falls within
 * windowMs. A session alerts if it's `alive` but its heartbeat is older than
 * staleMs. Ids are stable (repo+kind+ts / session id) so callers can dedup.
 * Returns newest-first.
 */
export function deriveAlerts({ repos = [], sessions = [], now = Date.now(), staleMs = 5 * 60_000, windowMs = 24 * HOUR } = {}) {
  const out = [];

  for (const r of repos ?? []) {
    for (const e of r?.journalTail ?? []) {
      if (!ALERT_KINDS.includes(e?.kind)) continue;
      const t = Date.parse(e.ts ?? '');
      if (Number.isFinite(t) && now - t > windowMs) continue; // too old to be actionable
      out.push({
        id: `${r.repo}:${e.kind}:${e.ts ?? ''}`,
        kind: e.kind,
        repo: r.repo,
        ticket: e.ticket ?? null,
        ts: e.ts ?? null,
        severity: sev(e.kind),
        message: `${e.kind}${e.gate ? ` (${e.gate})` : ''} in ${r.repo}${e.ticket ? ` ${e.ticket}` : ''} · ${ageLabel(e.ts, now)}`,
      });
    }
  }

  for (const s of sessions ?? []) {
    if (s?.state !== 'alive') continue;
    const hb = Date.parse(s.lastHeartbeat ?? '');
    if (!Number.isFinite(hb) || now - hb <= staleMs) continue;
    out.push({
      id: `session:${s.id}:stale`,
      kind: 'stale-session',
      repo: s.repo ?? null,
      ticket: s.ticket ?? null,
      ts: s.lastHeartbeat ?? null,
      severity: 'high',
      message: `session ${s.id} heartbeat stale (${ageLabel(s.lastHeartbeat, now)}) — hung or crashed`,
    });
  }

  return out.sort((a, b) => (Date.parse(b.ts ?? 0) || 0) - (Date.parse(a.ts ?? 0) || 0));
}
