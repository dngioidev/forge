/**
 * Firestore transport (SP9a T3) — REST, no SDK (zero-dependency principle).
 * STRUCTURAL until the owner provisions Firebase: the request shapes are
 * tested with an injected fetch; nothing here has run against a live project.
 * Auth: a short-lived OAuth token minted from a service-account key is the
 * follow-up step recorded in the guide — `authToken` is injected for now so
 * the adapter contract stays honest about what exists.
 *
 * Document layout (mirrors the file transport):
 *   machines/<machineId>/telemetry/<repo>        latest snapshot (PATCH)
 *   machines/<machineId>/escalations/<id>        one per decision (PATCH, idempotent)
 *   machines/<machineId>/replies/<id>            inbox written by the app
 */

const FIELD = (v) => {
  if (v === null || v === undefined) return { nullValue: null };
  if (typeof v === 'string') return { stringValue: v };
  if (typeof v === 'number') return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  if (typeof v === 'boolean') return { booleanValue: v };
  if (Array.isArray(v)) return { arrayValue: { values: v.map(FIELD) } };
  return { mapValue: { fields: toFields(v) } };
};
const toFields = (obj) => Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, FIELD(v)]));

export const fromFields = (fields = {}) => {
  const un = (f) => {
    if ('stringValue' in f) return f.stringValue;
    if ('integerValue' in f) return Number(f.integerValue);
    if ('doubleValue' in f) return f.doubleValue;
    if ('booleanValue' in f) return f.booleanValue;
    if ('nullValue' in f) return null;
    if ('arrayValue' in f) return (f.arrayValue.values ?? []).map(un);
    if ('mapValue' in f) return fromFields(f.mapValue.fields);
    return null;
  };
  return Object.fromEntries(Object.entries(fields).map(([k, f]) => [k, un(f)]));
};

export function makeFirestoreTransport(config, fetchFn = globalThis.fetch) {
  const { projectId, authToken } = config.transport;
  if (!projectId) throw new Error('firestore transport needs transport.projectId (daemon.json)');
  const machineId = config.machineId;
  const root = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents`;
  const headers = () => ({
    'Content-Type': 'application/json',
    ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}),
  });
  const docUrl = (col, id) => `${root}/machines/${machineId}/${col}/${encodeURIComponent(id)}`;

  const patch = async (url, doc) => {
    const res = await fetchFn(url, { method: 'PATCH', headers: headers(), body: JSON.stringify({ fields: toFields(doc) }) });
    return res.ok ? { ok: true } : { ok: false, error: `firestore ${res.status}` };
  };

  return {
    kind: 'firestore',
    publishTelemetry: (doc) => patch(docUrl('telemetry', doc.repo ?? 'unknown'), doc),
    publishEscalation: (doc) => patch(docUrl('escalations', doc.id), doc),

    async listDecisionReplies() {
      const res = await fetchFn(`${root}/machines/${machineId}/replies`, { headers: headers() });
      if (!res.ok) return [];
      const body = await res.json();
      return (body.documents ?? [])
        .map((d) => ({ name: d.name, ...fromFields(d.fields) }))
        .filter((d) => d.id && typeof d.answer === 'string' && !d.acked)
        .map((d) => ({ id: d.id, answer: d.answer, by: d.by ?? null, repliedAt: d.repliedAt ?? null }));
    },

    async ackDecisionReply(id) {
      return patch(`${docUrl('replies', id)}?updateMask.fieldPaths=acked`, { acked: true });
    },
  };
}
