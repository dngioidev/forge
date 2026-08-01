/**
 * Shared shell-segment splitter (#320).
 *
 * Splits a command line into sub-commands on shell separators (&& || ; | newline)
 * so a caller can test ONE sub-command at a time, not the whole string. This is
 * security-relevant parsing — the denylist (PreToolUse) and the capture hook
 * (PostToolUse) both depend on it, so it lives in ONE place to keep the two copies
 * from drifting.
 *
 * Over-splitting is safe by design: a destructive command is still fully contained
 * in its own segment (denylist rationale, #85). NOTE: rules that must see a
 * separator (e.g. denylist's pipe-to-shell RCE match, #311) run against the FULL
 * command string, NOT these segments — splitting on `|` is exactly what such a
 * payload hides behind.
 *
 * Pure, side-effect-free module: it exports a function and nothing else (no
 * self-exec guard), so any hook or host shim can import it with zero side effects.
 */

/**
 * @param {string} command - the raw command line
 * @returns {string[]} trimmed, non-empty sub-command segments
 */
export function splitSegments(command) {
  return command.split(/&&|\|\||[;|\n]/).map((s) => s.trim()).filter(Boolean);
}
