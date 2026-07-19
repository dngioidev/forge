/**
 * Agent-work trace + structure conformance (C6/#74; spec §3a/§3b). Pure
 * functions over state the pipeline ALREADY writes — journal, ledger, plan,
 * branch, git diff, PR. No new capture; every external read (git diff, file
 * existence) is injected by the caller so this stays offline-safe and testable.
 *
 * §3a buildTrace  → an ordered timeline: "where did the agent go".
 * §3b conformance → a green/amber badge: "does it match the forge structure".
 */
import { parseBranch } from './ticket.mjs';
import { isAllowed, DEFAULT_ALLOW, extractPlanFiles } from '../gates/plandrift.mjs';

/** The ledger header records `Plan: <path>` (ledger.mjs initLedger). */
export function ledgerPlanRef(ledgerText) {
  const m = /^Plan:\s*(.+)$/m.exec(ledgerText ?? '');
  return m ? m[1].trim() : null;
}

/**
 * Resolve the plan governing this work (#76). Ledger `Plan:` ref first; else the
 * ticket's committed plan doc — so the plan-doc loop (plans in docs/plans/ + main,
 * no `initLedger`) is recognized instead of read as drift. `plans` is the injected
 * docs/plans listing [{path, text}] (name-sorted, newest last). Returns
 * { found, ref, files, source: 'ledger'|'plandoc'|null }.
 */
export function resolvePlan({ ledgerText = '', ticket = null, plans = [] } = {}) {
  const norm = (s) => String(s ?? '').replaceAll('\\', '/');
  const ref = ledgerPlanRef(ledgerText);
  if (ref) {
    const nref = norm(ref);
    const hit = (plans ?? []).find((p) => { const np = norm(p?.path); return np && (np === nref || np.endsWith(nref) || nref.endsWith(np)); });
    if (hit) return { found: true, ref, files: extractPlanFiles(hit.text), source: 'ledger' };
  }
  if (ticket != null) {
    const tag = new RegExp(`#${ticket}\\b`);
    const cands = (plans ?? []).filter((p) => tag.test(p?.text ?? '') || tag.test(p?.path ?? ''));
    if (cands.length) {
      const pick = cands[cands.length - 1]; // callers pass name-sorted; date-prefixed newest last
      return { found: true, ref: pick.path, files: extractPlanFiles(pick.text ?? ''), source: 'plandoc' };
    }
  }
  return { found: false, ref: ref ?? null, files: [], source: null };
}

/** Canonical pipeline phase order — used to light the current step + check ordering. */
export const PHASE_ORDER = ['started', 'plan', 'tests', 'implement', 'gates', 'pr', 'ci-green', 'done'];

/**
 * §3a — reconstruct the ordered timeline from injected pipeline state.
 *   { branch, ledgerTasks[], ledgerPlan, touchedFiles[], journalEvents[], prNumber }
 * Returns { ticket, branch, branchKind, steps[], current, touched } where steps
 * is the ordered "phase strip" and `current` is the active step's key.
 */
export function buildTrace({ branch = '', ledgerTasks = [], ledgerPlan = null, touchedFiles = [], journalEvents = [], prNumber = null } = {}) {
  const parsed = parseBranch(branch || '');
  const done = ledgerTasks.filter((t) => t.status === 'done').length;
  const active = ledgerTasks.find((t) => t.status === 'in-progress') ?? null;
  const total = ledgerTasks.length;

  const steps = [
    { key: 'plan', label: ledgerPlan ? ledgerPlan.split(/[\\/]/).pop() : 'no plan', state: ledgerPlan ? 'done' : 'missing' },
    { key: 'tasks', label: total ? `${done}/${total} tasks${active ? ` · ${active.id}` : ''}` : 'no ledger', state: !total ? 'missing' : done === total ? 'done' : active ? 'active' : 'pending' },
    { key: 'files', label: `${touchedFiles.length} file${touchedFiles.length === 1 ? '' : 's'}`, state: touchedFiles.length ? 'active' : 'pending' },
    { key: 'pr', label: prNumber ? `#${prNumber}` : '—', state: prNumber ? 'done' : 'pending' },
  ];
  // the current step = the first non-done / non-missing step, else 'pr'
  const current = (steps.find((s) => s.state === 'active') ?? steps.find((s) => s.state === 'pending') ?? steps[steps.length - 1]).key;

  return {
    ticket: parsed.ticket ? `#${parsed.ticket}` : null,
    branch: branch || null,
    branchKind: parsed.kind,
    steps,
    current,
    touched: touchedFiles,
    // the raw event stream, newest last — the literal "where it went"
    events: (journalEvents ?? []).map((e) => ({ ts: e.ts ?? null, kind: e.kind, gate: e.gate ?? null, ticket: e.ticket ?? null })),
  };
}

/** phasesSeen is a subsequence of PHASE_ORDER (no phase appears before an earlier one). */
export function phasesInOrder(phasesSeen) {
  let i = 0;
  for (const p of phasesSeen ?? []) {
    const at = PHASE_ORDER.indexOf(p, i);
    if (at === -1) return false; // unknown phase or out of order
    i = at;
  }
  return (phasesSeen ?? []).includes('started');
}

/**
 * §3b — the conformance badge. All external facts injected:
 *   { branch, ledgerText, planExists, touchedFiles[], planFiles[], phasesSeen[]|null }
 * `phasesSeen: null` (default) OMITS the phases-in-order check — the trail lives on
 * GitHub, so the offline console skips it while the CLI (with gh) supplies the real
 * sequence. Returns { level: 'green'|'amber', checks: [{name, pass, why}], failing }.
 */
export function conformance({ branch = '', ledgerText = '', planExists = false, planSource = null, planRef = null, touchedFiles = [], planFiles = [], phasesSeen = null } = {}) {
  const parsed = parseBranch(branch || '');
  const ledgerRef = ledgerPlanRef(ledgerText);
  const validBranch = parsed.kind === 'work' || parsed.kind === 'hotfix';
  const deviations = (touchedFiles ?? []).filter((f) => !isAllowed(f, planFiles, [], DEFAULT_ALLOW));
  // A plan counts when found via the ledger ref OR (#76) the ticket's committed plan doc.
  // Legacy callers pass no planSource → the check stays exactly ledger-only (back-compat).
  const planPass = planExists && (!!ledgerRef || planSource === 'plandoc');

  const checks = [
    {
      name: 'valid-branch',
      pass: validBranch,
      why: validBranch ? `on ${parsed.type}/${parsed.ticket ?? '?'}` : `branch '${branch || '?'}' is not a forge work/hotfix branch (kind: ${parsed.kind})`,
    },
    {
      name: 'ledger-plan',
      pass: planPass,
      why: planSource === 'plandoc' ? `plan doc → ${planRef ?? '?'}`
        : !ledgerRef ? 'no plan: ledger has no Plan: line and no plan doc references this ticket'
          : !planExists ? `ledger Plan '${ledgerRef}' is not a committed file` : `ledger → ${ledgerRef}`,
    },
    {
      name: 'files-in-scope',
      pass: deviations.length === 0,
      why: deviations.length === 0 ? `${(touchedFiles ?? []).length} touched, all in plan/allowed` : `off-plan: ${deviations.join(', ')}`,
    },
  ];
  if (phasesSeen != null) {
    checks.push({
      name: 'phases-in-order',
      pass: phasesInOrder(phasesSeen),
      why: phasesInOrder(phasesSeen) ? `phases: ${phasesSeen.join(' → ')}` : `phases missing 'started' or out of order: ${phasesSeen.join(' → ') || 'none'}`,
    });
  }

  const failing = checks.find((c) => !c.pass) ?? null;
  return { level: failing ? 'amber' : 'green', checks, failing: failing?.name ?? null };
}

export { extractPlanFiles };
