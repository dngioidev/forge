/**
 * Transport contract (SP9a T3). A transport moves sanitized metadata out and
 * decision replies in — nothing else. All methods are async:
 *
 *   publishTelemetry(doc)          one sanitized snapshot per repo per cycle
 *   publishEscalation(doc)         idempotent per doc.id
 *   listDecisionReplies()          -> [{id, answer, by, repliedAt}]
 *   ackDecisionReply(id)           consume exactly once
 *
 * The daemon composes these; it never knows which backend it's talking to.
 */
import { makeFileTransport } from '../transports/file.mjs';
import { makeFirestoreTransport } from '../transports/firestore.mjs';

export function makeTransport(config) {
  switch (config?.transport?.kind) {
    case 'file': return makeFileTransport(config);
    case 'firestore': return makeFirestoreTransport(config);
    default:
      throw new Error(`unknown transport '${config?.transport?.kind}' — valid: file, firestore (daemon.json transport.kind)`);
  }
}
