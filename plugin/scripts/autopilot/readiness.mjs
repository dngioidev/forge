#!/usr/bin/env node
/**
 * Ticket readiness (#142, spec §6): is a backlog ticket already SHAPED — i.e.
 * does it carry acceptance criteria — or does it still need the shaping front
 * door? A shaped ticket is deliverable (triage only); an unshaped one is `shape`
 * under crazy mode (--shape) or `escalate` in plain autopilot. Pure + testable;
 * the loop reads the issue body and passes the result to select's actionFor.
 */

/** True when the body carries acceptance criteria (an Acceptance section or AC-ids). */
export function isShaped(body) {
  const text = typeof body === 'string' ? body : '';
  if (/(^|\n)\s{0,3}#{1,6}\s*Acceptance\b/i.test(text)) return true; // "## Acceptance"
  if (/\bAC-?\d+\b/.test(text)) return true;                          // AC-1 / AC12 references
  return false;
}
