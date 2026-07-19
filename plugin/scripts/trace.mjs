#!/usr/bin/env node
/**
 * forge trace CLI (C6/#74; spec §3a/§3b). Prints the agent-work timeline + the
 * structure-conformance badge for the current repo, from files the pipeline
 * already writes. An informal "am I inside the lines" check to run BEFORE ship
 * (exit 0 = green/conforming, 1 = amber/drifting). Not a merge gate — the
 * mechanical gates at ship remain the enforcement.
 */
import { readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { run } from './lib/exec.mjs';
import { read as readJournal } from './lib/journal.mjs';
import { parseLedger, LEDGER_RELPATH } from './lib/ledger.mjs';
import { parseBranch } from './lib/ticket.mjs';
import { buildTrace, conformance, ledgerPlanRef, extractPlanFiles } from './lib/trace.mjs';

async function readMaybe(path) { try { return await readFile(path, 'utf8'); } catch { return null; } }

/** Best-effort trail phases from the ticket's gh comments (skipped if gh/ticket absent). */
async function trailPhases(ticket, execFn) {
  if (!ticket) return null;
  const r = await execFn('gh', ['issue', 'view', String(ticket), '--json', 'comments', '-q', '.comments[].body']);
  if (!r.ok) return null;
  const known = ['started', 'plan', 'tests', 'implement', 'gates', 'pr', 'ci-green', 'done'];
  const seen = [];
  for (const line of r.stdout.split('\n')) {
    const m = /\*\*([a-z-]+)\*\*/.exec(line); // trail lines lead with **<phase>**
    if (m && known.includes(m[1]) && seen[seen.length - 1] !== m[1]) seen.push(m[1]);
  }
  return seen.length ? seen : null;
}

export async function runTrace(cwd, { execFn = run, base = 'main', online = true } = {}, log = console.log) {
  const branch = (await execFn('git', ['-C', cwd, 'rev-parse', '--abbrev-ref', 'HEAD'])).stdout?.trim() || '';
  const parsed = parseBranch(branch);

  const ledgerText = (await readMaybe(join(cwd, LEDGER_RELPATH))) ?? '';
  const ledgerTasks = parseLedger(ledgerText);
  const planRef = ledgerPlanRef(ledgerText);
  const planText = planRef ? await readMaybe(resolve(cwd, planRef)) : null;
  const planFiles = extractPlanFiles(planText ?? '');

  const diff = await execFn('git', ['-C', cwd, 'diff', '--name-only', `${base}...HEAD`]);
  const touchedFiles = diff.ok ? diff.stdout.split(/\r?\n/).filter(Boolean) : [];

  const journal = await readJournal(cwd);
  const prMatch = /\bpr[-\s]?#?(\d+)/i.exec(ledgerText) ?? null; // best-effort PR from ledger notes
  const trace = buildTrace({ branch, ledgerTasks, ledgerPlan: planRef, touchedFiles, journalEvents: journal.events, prNumber: prMatch ? Number(prMatch[1]) : null });

  const phasesSeen = online ? await trailPhases(parsed.ticket, execFn) : null;
  const badge = conformance({ branch, ledgerText, planExists: planText != null, touchedFiles, planFiles, phasesSeen });

  // ---- render ----
  const glyph = badge.level === 'green' ? '🟢' : '🟡';
  log(`trace ${trace.ticket ?? '(no ticket)'} — ${branch || '(no branch)'}`);
  log(`  ${trace.steps.map((s) => `${s.state === 'done' ? '●' : s.state === 'active' ? '◐' : s.state === 'missing' ? '○!' : '○'} ${s.key}:${s.label}`).join('   ')}`);
  log(`  ${glyph} conformance: ${badge.level}${badge.failing ? ` (${badge.failing})` : ''}`);
  for (const c of badge.checks) log(`    ${c.pass ? '✓' : '✗'} ${c.name} — ${c.why}`);

  return { ok: true, trace, badge, conforming: badge.level === 'green' };
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  const online = !process.argv.includes('--offline');
  runTrace(process.cwd(), { online }).then((r) => process.exit(r.conforming ? 0 : 1));
}
