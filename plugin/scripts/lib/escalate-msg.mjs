/**
 * Shared denylist escalate message (#321).
 *
 * The "escalate instead" wording that a denylist block surfaces to the model was
 * copy-pasted into two host shims — the Claude PreToolUse hook (denylist.mjs) and
 * the agy deny shim (agy-deny.mjs) — and the copies had ALREADY DRIFTED (one wrote
 * the spec reference as "§7", the other as "section 7"). This module single-sources
 * the wording so the two hosts cannot drift again (AC-321.1).
 *
 * The escalate command is forge's own board tooling and is host-agnostic — the same
 * `escalate.mjs` invocation is correct from every GAI host — so the WHOLE message is
 * single-sourced here. Should a genuine per-host tweak ever be needed, pass it in
 * rather than forking the core sentence.
 *
 * Pure, side-effect-free module: it exports strings/functions and nothing else (no
 * self-exec guard, no I/O), so any hook or host shim can import it with zero side
 * effects — the same import-safety contract as shell-split.mjs (#320).
 */

/** Canonical spec reference for the escalate path (spec §7 destructive-action gate). */
export const SPEC_REF = 'spec §7';

/** The exact command a human/agent runs to request the blocked destructive action. */
export const ESCALATE_HINT =
  'node plugin/scripts/board/escalate.mjs --issue <n> --reason "..." --options "do it|alternative"';

/**
 * Build the denylist block/deny reason string shared by every host shim.
 * @param {string} rule - the matched denylist rule name (e.g. 'force-push')
 * @param {string} msg  - the rule's human explanation of why it is destructive
 * @returns {string} the single-sourced escalate message
 */
export function escalateMessage(rule, msg) {
  return (
    `forge denylist blocked this command (${rule}): ${msg}. ` +
    `Destructive actions require a human decision — escalate instead: ` +
    `${ESCALATE_HINT} (${SPEC_REF}).`
  );
}
