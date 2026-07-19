/**
 * Telemetry collectors (spec §11 monitor; SP9a T1). Everything here reads
 * state the pipeline already writes — .forge/journal.jsonl, .forge/decisions/,
 * .forge/progress.md, .git/HEAD. No network, no gh: the daemon must be able
 * to snapshot a repo even when offline. Output goes through sanitize.mjs
 * before any transport sees it.
 */
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { deriveSituation, pendingDecisions } from '../../plugin/scripts/lib/situation.mjs';
import { read as readJournal } from '../../plugin/scripts/lib/journal.mjs';
import { parseLedger, LEDGER_RELPATH } from '../../plugin/scripts/lib/ledger.mjs';
import { parseBranch } from '../../plugin/scripts/lib/ticket.mjs';
import { buildTrace, conformance, resolvePlan } from '../../plugin/scripts/lib/trace.mjs';

/** docs/plans/*.md listing [{path, text}] for the plan-doc conformance fallback (#76). */
async function readPlanDocs(cwd) {
  let names;
  try { names = (await readdir(join(cwd, 'docs', 'plans'))).filter((f) => f.endsWith('.md')).sort(); } catch { return []; }
  const out = [];
  for (const n of names) out.push({ path: `docs/plans/${n}`, text: (await readFile(join(cwd, 'docs', 'plans', n), 'utf8').catch(() => '')) });
  return out;
}

export async function currentBranch(cwd) {
  try {
    const head = await readFile(join(cwd, '.git', 'HEAD'), 'utf8');
    const m = /^ref: refs\/heads\/(.+)$/m.exec(head.trim());
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

export async function ledgerCounts(cwd) {
  try {
    const text = await readFile(join(cwd, LEDGER_RELPATH), 'utf8');
    const tasks = parseLedger(text);
    const by = (s) => tasks.filter((t) => t.status === s).length;
    return { total: tasks.length, done: by('done'), inProgress: by('in-progress'), pending: by('pending') };
  } catch {
    return null;
  }
}

const AGE_MS_HOUR = 3_600_000;

/**
 * git diff of the branch vs base, as a name list. Local (not network) but a
 * subprocess — so it's injectable and degrades to [] when git is absent, keeping
 * the collector offline-safe. The console omits the trail phases check (§3b), so
 * no gh is needed here either.
 */
async function defaultDiff(cwd, base = 'main') {
  try {
    const { run } = await import('../../plugin/scripts/lib/exec.mjs');
    const r = await run('git', ['-C', cwd, 'diff', '--name-only', `${base}...HEAD`]);
    return r.ok ? r.stdout.split(/\r?\n/).filter(Boolean) : [];
  } catch { return []; }
}

/** One repo's snapshot. `now` injected — the daemon stamps once per cycle. */
export async function collectRepo(cwd, now = Date.now(), { diff = defaultDiff } = {}) {
  const branch = await currentBranch(cwd);
  const parsed = parseBranch(branch ?? '');
  const situation = await deriveSituation(cwd);
  const pending = await pendingDecisions(cwd);
  const journal = await readJournal(cwd);

  // §3a/§3b (C6): trace timeline + conformance badge from files already written.
  const ledgerText = (await readFile(join(cwd, LEDGER_RELPATH), 'utf8').catch(() => '')) || '';
  const ledgerTasks = parseLedger(ledgerText);
  // #76: resolve the plan from the ledger ref first, else the ticket's committed plan doc.
  const plan = resolvePlan({ ledgerText, ticket: parsed.ticket, plans: await readPlanDocs(cwd) });
  const touched = await diff(cwd, 'main').catch(() => []);
  const trace = buildTrace({ branch: branch ?? '', ledgerTasks, ledgerPlan: plan.ref, touchedFiles: touched, journalEvents: journal.events });
  const badge = conformance({ branch: branch ?? '', ledgerText, planExists: plan.found, planSource: plan.source, planRef: plan.ref, touchedFiles: touched, planFiles: plan.files, phasesSeen: null });

  return {
    repo: cwd.split(/[\\/]/).filter(Boolean).pop() ?? 'unknown',
    situation: situation.key,
    glyph: situation.glyph,
    branch,
    ticket: parsed.ticket ? `#${parsed.ticket}` : null,
    branchKind: parsed.kind,
    ledger: await ledgerCounts(cwd),
    trace: { steps: trace.steps, current: trace.current },
    conformance: { level: badge.level, failing: badge.failing, checks: badge.checks },
    pendingDecisions: pending.map((d) => ({
      id: d.id,
      issue: d.issue,
      reason: d.reason,
      options: d.options,
      ageHours: d.createdAt ? Math.round(((now - Date.parse(d.createdAt)) / AGE_MS_HOUR) * 10) / 10 : null,
    })),
    journalTail: journal.events.slice(-10).map((e) => ({
      ts: e.ts, kind: e.kind, ticket: e.ticket ?? null, gate: e.gate ?? null, rule: e.rule ?? null,
    })),
    collectedAt: new Date(now).toISOString(),
  };
}
