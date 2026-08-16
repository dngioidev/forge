#!/usr/bin/env node
/**
 * /distill mechanics (spec §8): read the journal, cluster repeats, render one
 * proposal per cluster. This script only REPORTS and ARCHIVES — applying a
 * lesson is permanently human (automation-ladder ceiling): a maintainer
 * approves each proposal and the approved edits land as a PR.
 *
 *   node distill.mjs             # report mode: clusters + proposals to stdout
 *   node distill.mjs --archive   # journal -> .forge/journal-archive/<date>.jsonl
 */
import { mkdir, rename, readFile, appendFile, rm, access } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { read, JOURNAL_RELPATH } from '../lib/journal.mjs';

export const ARCHIVE_DIR = join('.forge', 'journal-archive');

/**
 * blocked-edit clustering by rule name ALONE cannot tell a genuine destructive
 * attempt from an agent deliberately exercising the guard — see #465. Grounded
 * against the real 2026-08-13 round (119 blocked-edit events, all 8 role-card
 * proposals rejected because the premise was false): every discriminator below
 * was validated against that data, not invented. 117/119 carried at least one
 * signal, with zero false positives on manual audit of every single-signal hit.
 *
 * Deliberately TWO states, not three. Absence of a guard-testing signal is not
 * proof of genuine intent — it just means this cheap text match found nothing —
 * so there is no confident "genuine" label here, only "guard-testing" (a
 * discriminator matched) and "unclassified" (none did, review the excerpt).
 * The 2 real events with no signal: one was the single genuinely bare
 * `git push --force origin main` in the whole round (correctly stays
 * unclassified/visible), the other an adversarial CRLF-splitting probe with no
 * denylist reference at all — an honest can't-tell case. Erring toward keeping
 * an event visible (AC.2) is the point: a false "guard-testing" label is the
 * dangerous direction, a false "unclassified" one merely asks a human to look.
 */
export function classifyBlockedEdit(cmd) {
  if (typeof cmd !== 'string' || !cmd) return { guardTesting: false, reasons: [] };
  const reasons = [];
  // Testing the guard itself: invoking check()/denylist.mjs, the agy shim's
  // toolCall envelope, or importing anything under plugin/hooks/.
  if (/denylist\.mjs/.test(cmd) || /check\(/.test(cmd) || /toolCall/.test(cmd) || /isAllowedCommand/.test(cmd) || /spawnSync/.test(cmd) || /agy-deny\.mjs/.test(cmd) || /plugin\/hooks\//.test(cmd)) {
    reasons.push('denylist-harness');
  }
  // A throwaway or review-worktree target, never the working tree the agent
  // actually cares about (forge-security-N / forge-review-N are this repo's
  // own adversarial-review worktree naming, per #433/#437).
  if (/\/tmp\//.test(cmd) || /AppData[\\/]Local[\\/]Temp/.test(cmd) || /scratchpad/.test(cmd) || /\.tmp-review/.test(cmd) || /forge-(security|review)-\d+/.test(cmd)) {
    reasons.push('scratch-path');
  }
  // Writing ABOUT a blocked command (PR body, heredoc doc/test fixture) rather
  // than invoking it — the literal-string caveat: the denylist matches inside
  // quoted/heredoc bodies too, so quoting a blocked string here still trips it.
  if (/--body-file/.test(cmd) || /<<\s*'?"?[A-Za-z_]{2,}'?"?/.test(cmd) || /\$\(cat <</.test(cmd)) {
    reasons.push('doc-write');
  }
  // Adversarial probe shapes: ReDoS/length tails, brace expansion, a long
  // repeated-character run, or ANSI-C/quoted flag-spelling tricks.
  if (/;\s*echo\s+y{5,}/.test(cmd) || /\{[^{}]{1,40},[^{}]{1,40}\}/.test(cmd) || /\{[^{}\s]{1,20}\.\.[^{}\s]{1,20}\}/.test(cmd) || /(.)\1{14,}/.test(cmd) || /\$'/.test(cmd) || /-\\"[a-zA-Z]\\"/.test(cmd) || /-"[a-zA-Z]"/.test(cmd)) {
    reasons.push('adversarial-probe');
  }
  return { guardTesting: reasons.length > 0, reasons };
}

/** Truncate a command excerpt for inline evidence — one line, bounded length. */
function cmdExcerpt(cmd, max = 140) {
  if (typeof cmd !== 'string' || !cmd) return null;
  const oneLine = cmd.replace(/\s+/g, ' ').trim();
  return oneLine.length > max ? `${oneLine.slice(0, max)}…` : oneLine;
}

/** Stable cluster signature: same signature = same recurring lesson. */
export function signature(event) {
  switch (event.kind) {
    case 'gate-fail': return event.gate ?? firstTokens(event.cmd);
    case 'cmd-fail': return firstTokens(event.cmd);
    case 'blocked-edit': {
      const rule = event.rule ?? 'unknown-rule';
      const { guardTesting } = classifyBlockedEdit(event.cmd);
      return `${rule} [${guardTesting ? 'guard-testing' : 'unclassified'}]`;
    }
    case 'backend-fallback': return `${event.role ?? '?'}:${event.backend ?? event.from ?? '?'}`;
    case 'escalation': return (event.reason ?? '').slice(0, 60) || 'unspecified';
    // Resolved escalations carry their decision under `answer`, not `reason` —
    // there is no `event.reason` on this event kind at all. Keying off it (as
    // the pre-#465 code did) means EVERY resolved escalation falls through to
    // the literal 'unspecified' fallback and merges into one fake pattern
    // regardless of ticket — confirmed against the real #407/#446 archive data
    // (AC.5): three unrelated decisions across five days, two from the same
    // ticket, reported as one recurring cluster. `id` is the primitive that
    // actually ties a resolution back to the escalation it resolves, so it is
    // the correct signature — distinct decisions never coalesce, and a
    // genuinely re-resolved escalation (same id) still clusters as a repeat.
    case 'escalation-resolved': return event.id ? `resolved:${event.id}` : (event.issue ? `resolved:issue-${event.issue}` : 'unspecified');
    default: return event.kind;
  }
}

function firstTokens(cmd) {
  if (typeof cmd !== 'string' || !cmd.trim()) return 'unknown-cmd';
  const tokens = cmd.trim().split(/\s+/).filter((t) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(t));
  const wide = new Set(['git', 'gh', 'node', 'npm', 'pnpm', 'npx', 'docker']);
  return wide.has(tokens[0]) ? tokens.slice(0, 2).join(' ') : (tokens[0] ?? 'unknown-cmd');
}

// 'blocked-edit' is deliberately absent here — see proposalFor() below, which
// branches on classifyBlockedEdit() instead of using one fixed proposal for
// every rule regardless of cause (that fixed text is what #465 exists to fix).
const PROPOSALS = {
  'gate-fail': 'lint/hook guard or CLAUDE.md rule — stop this gate from failing the same way again',
  'cmd-fail': 'CLAUDE.md rule or shell-notes entry — record the working invocation',
  'backend-fallback': 'backends config change or memory entry — this backend keeps failing for this role',
  'incident': 'CLAUDE.md rule + runbook note — production lessons are the most valuable /distill sees',
  'escalation': 'memory entry — recurring decisions suggest a missing standing rule',
};

export function clusterEvents(events) {
  const map = new Map();
  for (const e of events) {
    const key = `${e.kind}|${signature(e)}`;
    if (!map.has(key)) map.set(key, { kind: e.kind, signature: signature(e), count: 0, events: [] });
    const c = map.get(key);
    c.count++;
    c.events.push(e);
  }
  return [...map.values()].sort((a, b) => b.count - a.count || a.kind.localeCompare(b.kind));
}

/**
 * blocked-edit gets its own proposal text per classification (AC.1/AC.2) rather
 * than the fixed "teach the escalation path" line every rule used to get
 * regardless of cause. A guard-testing cluster gets NO role-card proposal — the
 * #465 round's whole failure was proposing exactly that for behaviour that is
 * desirable. An unclassified cluster gets a QUESTION with evidence, never an
 * instruction: the classifier has no signal either way, and a diagnosis
 * phrasing here is what produced silent rubber-stamping risk before.
 */
function proposalFor(c) {
  if (c.kind !== 'blocked-edit') return PROPOSALS[c.kind] ?? 'memory entry';
  const rule = c.events[0]?.rule ?? 'unknown-rule';
  const { guardTesting, reasons } = classifyBlockedEdit(c.events[0]?.cmd);
  if (guardTesting) {
    return `no role-card change proposed — every event matching \`${rule}\` here carries a guard-testing signal (${reasons.join(', ')}: scratch/review-worktree path, denylist-harness invocation, doc-write, or adversarial-probe shape). This reads as the guard being deliberately exercised, not an agent reaching for the action. Kept as evidence only.`;
  }
  return `**question, not a diagnosis** — ${c.count} event(s) matching \`${rule}\` show no known guard-testing signal (no scratch path, harness reference, doc-write, or probe shape detected). Is this a genuine destructive attempt, or a guard-testing shape this classifier doesn't recognise yet? Check the excerpt below before deciding on a role-card edit.`;
}

export function renderReport(clusters) {
  if (clusters.length === 0) return 'nothing to distill — the journal is empty.';
  const repeats = clusters.filter((c) => c.count >= 2);
  const singles = clusters.filter((c) => c.count === 1);
  const lines = ['# /distill report', ''];
  lines.push(`${clusters.reduce((n, c) => n + c.count, 0)} events → ${repeats.length} recurring cluster(s), ${singles.length} one-off(s).`, '');
  for (const c of repeats) {
    lines.push(`## ${c.kind}: ${c.signature} (${c.count}×)`, '');
    lines.push(`**Proposal:** ${proposalFor(c)}`, '');
    const sample = c.events.find((e) => e.err_line) ?? c.events[0];
    // AC.3: refs used to be bare timestamps — a maintainer had to go hand-query
    // journal.jsonl to sanity-check a cluster's premise, which is how the #465
    // round's misreading survived until a reviewer did exactly that. Surface a
    // representative excerpt inline instead, from whichever field the kind
    // actually carries (err_line for gate/cmd failures, cmd for blocked-edit).
    if (sample.err_line) lines.push(`Sample: \`${sample.err_line}\``);
    else if (cmdExcerpt(sample.cmd)) lines.push(`Sample: \`${cmdExcerpt(sample.cmd)}\``);
    lines.push(`Refs: ${c.events.map((e) => e.ts).filter(Boolean).join(', ') || '(no timestamps)'}`, '');
  }
  if (singles.length) {
    lines.push('## One-offs (no pattern yet — stay in the archive as evidence)', '');
    for (const c of singles) lines.push(`- ${c.kind}: ${c.signature}`);
    lines.push('');
  }
  lines.push('---', 'A maintainer approves each proposal before anything is written; approved lessons land as a PR. Then archive: `distill.mjs --archive`.');
  return lines.join('\n');
}

/** Move the live journal aside; same-day re-archive appends. No journal = no-op. */
export async function archive(cwd, date) {
  const src = join(cwd, JOURNAL_RELPATH);
  const dest = join(cwd, ARCHIVE_DIR, `${date}.jsonl`);
  let raw;
  try {
    raw = await readFile(src, 'utf8');
  } catch {
    return { ok: true, archived: null, count: 0 };
  }
  await mkdir(join(cwd, ARCHIVE_DIR), { recursive: true });
  // rename replaces an existing dest on Windows — same-day re-archive must append, never clobber
  const destExists = await access(dest).then(() => true, () => false);
  if (destExists) {
    await appendFile(dest, raw, 'utf8');
    await rm(src, { force: true });
  } else {
    await rename(src, dest);
  }
  const count = raw.split(/\r?\n/).filter((l) => l.trim()).length;
  return { ok: true, archived: dest, count };
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  const cwd = process.cwd();
  if (process.argv.includes('--archive')) {
    archive(cwd, new Date().toISOString().slice(0, 10)).then((res) => {
      console.log(res.archived ? `archived ${res.count} events → ${res.archived}` : 'no journal to archive');
    });
  } else {
    read(cwd).then(({ events }) => console.log(renderReport(clusterEvents(events))));
  }
}
