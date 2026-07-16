/**
 * Backend loader — the swap allowlist enforced in code, not convention
 * (spec §5). Pinned roles ignore non-Claude roster entries with a warning;
 * implementer swaps only on an agent child branch.
 */
import { parseBranch } from '../lib/ticket.mjs';

export const ROLES = [
  'implementer', 'reviewer', 'security', 'design-reviewer', 'scoper',
  'test-architect', 'devops', 'designer', 'investigator', 'librarian', 'second-opinion',
];

/** Roles that may run on non-Claude backends. Everything else feeds a gate or writes — pinned. */
export const SWAPPABLE = ['investigator', 'librarian', 'second-opinion'];

export const DEFAULTS = {
  implementer: 'claude:sonnet',
  reviewer: 'claude:fable',
  security: 'claude:fable',
  'design-reviewer': 'claude:sonnet',
  scoper: 'claude:sonnet',
  'test-architect': 'claude:sonnet',
  devops: 'claude:sonnet',
  designer: 'claude:sonnet',
  investigator: 'claude:haiku',
  librarian: 'claude:haiku',
  'second-opinion': 'codex:gpt-5',
};

/** `<runtime>[:<model>]` — bare runtime means the adapter's declared default model. */
export function parseBackendId(id) {
  if (typeof id !== 'string' || id.length === 0) return null;
  const [runtime, ...rest] = id.split(':');
  if (!runtime) return null;
  return { runtime, model: rest.length ? rest.join(':') : null };
}

/**
 * Resolve a role's backend from the roster, enforcing pins.
 * Returns { runtime, model, optional, fallback, warnings[] }.
 */
export function resolveBackend(role, roster = {}, branchName = '') {
  if (!ROLES.includes(role)) return { ok: false, error: `unknown role '${role}' — valid: ${ROLES.join(', ')}` };
  const warnings = [];
  const entry = roster[role] ?? {};
  let id = entry.backend ?? DEFAULTS[role];
  let parsed = parseBackendId(id);
  if (!parsed) {
    warnings.push(`invalid backend id '${id}' for ${role} — using default`);
    parsed = parseBackendId(DEFAULTS[role]);
  }

  const isClaude = parsed.runtime === 'claude';
  if (!isClaude) {
    if (role === 'implementer') {
      // child-branch rule: non-Claude implementer only on `…--implementer`
      const b = parseBranch(branchName);
      if (!(b.isAgentChild && b.role === 'implementer')) {
        warnings.push(`implementer backend '${id}' requires an agent child branch (…--implementer); current branch '${branchName}' — pinned to ${DEFAULTS.implementer}`);
        parsed = parseBackendId(DEFAULTS.implementer);
      }
    } else if (!SWAPPABLE.includes(role)) {
      warnings.push(`role '${role}' is pinned to claude (gate/write role, spec §5) — roster entry '${id}' ignored`);
      parsed = parseBackendId(DEFAULTS[role]);
    }
  }

  // pinned roles may still choose a different *Claude* model via roster
  const fallback = entry.fallback ? parseBackendId(entry.fallback) : null;
  return {
    ok: true,
    runtime: parsed.runtime,
    model: parsed.model,
    optional: entry.optional === true,
    fallback: fallback && fallback.runtime === 'claude' ? fallback : (fallback ? { ...fallback } : null),
    warnings,
  };
}
