/**
 * File transport (SP9a T3) — the live-today backend: a shared directory
 * (local disk, synced folder, network share) stands in for the cloud.
 * Layout, machine-scoped:
 *   <dir>/<machineId>/telemetry.jsonl      append-only snapshots
 *   <dir>/<machineId>/escalations.jsonl    append-only, idempotent per id
 *   <dir>/<machineId>/decisions/<id>.json  inbox: replies dropped by a human/app
 *   <dir>/<machineId>/decisions/<id>.json.done  ack marker (consumed exactly once)
 */
import { appendFile, readFile, readdir, rename, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

export function makeFileTransport(config) {
  const machineId = config.machineId;
  const base = join(config.transport.dir, machineId);
  const decisionsDir = join(base, 'decisions');
  const ensure = () => mkdir(decisionsDir, { recursive: true });

  return {
    kind: 'file',

    async publishTelemetry(doc) {
      await ensure();
      await appendFile(join(base, 'telemetry.jsonl'), JSON.stringify(doc) + '\n', 'utf8');
      return { ok: true };
    },

    async publishEscalation(doc) {
      await ensure();
      const path = join(base, 'escalations.jsonl');
      const existing = await readFile(path, 'utf8').catch(() => '');
      if (existing.includes(`"id":${JSON.stringify(doc.id)}`)) return { ok: true, duplicate: true };
      await appendFile(path, JSON.stringify(doc) + '\n', 'utf8');
      return { ok: true };
    },

    async listDecisionReplies() {
      await ensure();
      const replies = [];
      for (const f of (await readdir(decisionsDir)).filter((f) => f.endsWith('.json'))) {
        try {
          const d = JSON.parse(await readFile(join(decisionsDir, f), 'utf8'));
          if (d.id && typeof d.answer === 'string') replies.push({ id: d.id, answer: d.answer, by: d.by ?? null, repliedAt: d.repliedAt ?? null });
        } catch { /* half-written reply — next cycle */ }
      }
      return replies;
    },

    async ackDecisionReply(id) {
      const src = join(decisionsDir, `${id}.json`);
      await rename(src, `${src}.done`).catch(() => {});
      return { ok: true };
    },
  };
}
