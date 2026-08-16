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
 * against the real 2026-08-13/14 rounds plus the live journal (real events,
 * not invented) and taken through four rounds of adversarial review
 * (forge:reviewer, forge:security ×2, forge:reviewer again) that each closed
 * a false-positive path — most recently removing brace-expansion and
 * ANSI-C/quote-spelling from the "adversarial-probe" signal entirely, because
 * both are the literal mechanism a real bypass would use to spell a dangerous
 * flag past a naive guard, not just a shape a tester happens to favour (see
 * the inline comment on the adversarial-probe check below for the reproduced
 * exploits). The plan doc carries the full, dated review history and current
 * recall numbers rather than duplicating them here, since they shift each
 * time this function does: docs/plans/2026-08-16-465-distill-blocked-edit-classification.md.
 *
 * Deliberately TWO states, not three. Absence of a guard-testing signal is not
 * proof of genuine intent — it just means this cheap text match found nothing —
 * so there is no confident "genuine" label here, only "guard-testing" (a
 * discriminator matched) and "unclassified" (none did, review the excerpt).
 * Erring toward keeping an event visible (AC.2) is the point: a false
 * "guard-testing" label is the dangerous direction — it suppresses exactly
 * the lesson distill exists to surface — a false "unclassified" one merely
 * asks a human to look.
 *
 * KNOWN LIMITATION, stated rather than hidden (adversarial security review):
 * this is a text match over a flat (already-truncated) `cmd` string, not a
 * shell parser — it cannot always tell which SEGMENT of a multi-part command
 * a discriminator match belongs to. A destructive command chained via
 * `&&`/`;` with an unrelated, genuinely guard-testing-shaped segment (e.g.
 * `<destructive> && cat <<EOF … EOF`) can still borrow that segment's label.
 * `stripComment()` closes the cheapest, most likely version of this
 * (appending `# check(this)` or similar, which costs an attacker nothing and
 * needs no real guard-testing shape at all) with no recall cost; closing the
 * compound-command case fully would need denylist.mjs's own quote-aware
 * segmentation, which is a materially bigger change than this ticket's scope
 * (its non-goal: this ticket is about how the journal is interpreted, not a
 * redesign of distill or an absorption of denylist mechanics) — tracked as a
 * disclosed, linked follow-up rather than silently dropped. AC.3's inline
 * excerpt (see `cmdExcerpt()`, sized to the same 300-char cap the journal
 * itself enforces) is the backstop: a maintainer approving a "no role-card
 * change" proposal is always looking at the same text this function did.
 */
/**
 * Strip an inert shell comment (a space/line-start-preceded `#` and
 * everything after it, per line) before any discriminator runs (adversarial
 * review finding, #465 second fix wave). Text after a bare `#` is never
 * executed — it is exactly the kind of free decoy an agent gaming this
 * classifier would reach for first (append `# check(this)` or `# /tmp/foo`
 * after an unrelated destructive command to borrow a guard-testing label
 * that command never earned). This is a heuristic, not a parser — it does
 * not know a `#` is inert only OUTSIDE quotes — but for the destructive verbs
 * this classifier ever sees (git/rm/etc., never data containing a literal
 * `#`), a bare space-preceded `#` reliably marks a real comment start in
 * every case observed in the validated data.
 */
function stripComment(cmd) {
  return cmd.split('\n').map((line) => {
    const idx = line.search(/(?:^|\s)#/);
    return idx === -1 ? line : line.slice(0, idx);
  }).join('\n');
}

export function classifyBlockedEdit(cmd) {
  if (typeof cmd !== 'string' || !cmd) return { guardTesting: false, reasons: [] };
  const text = stripComment(cmd);
  const reasons = [];
  // Testing the guard itself: invoking check()/denylist.mjs, the agy shim's
  // toolCall envelope, or importing anything under plugin/hooks/. `\bcheck\(`
  // (word-boundary — fourth adversarial-review round, reviewer): unanchored
  // `check\(` also matches inside an unrelated identifier sharing the
  // substring (`typecheck(`, `healthcheck(`).
  if (/denylist\.mjs/.test(text) || /\bcheck\(/.test(text) || /toolCall/.test(text) || /isAllowedCommand/.test(text) || /spawnSync/.test(text) || /agy-deny\.mjs/.test(text) || /plugin\/hooks\//.test(text)) {
    reasons.push('denylist-harness');
  }
  // A throwaway or review-worktree target, never the working tree the agent
  // actually cares about (forge-security-N / forge-review-N are this repo's
  // own adversarial-review worktree naming, per #433/#437). Each marker
  // requires no `..` traversal immediately after it (fourth adversarial-review
  // round, reviewer): an unqualified `/\/tmp\//` reads `rm -rf /tmp/../
  // important-project/.git` as a safe scratch-path operation when the `..`
  // walks straight back out of the scratch dir into the real tree — the
  // marker's mere presence proves nothing once a traversal follows it.
  // `/tmp/` is anchored to a path START (preceded by whitespace, `=`, a quote,
  // or the string start), never a bare substring (fifth adversarial-review
  // round, self-review against an adversarial fixture set): unanchored, it
  // also matches `/tmp/` sitting mid-path inside a completely unrelated real
  // directory (`rm -rf /home/user/myapp/tmp/uploads --force` is a genuine
  // destructive command against an app's own "tmp" subfolder, not the system
  // scratch dir). The other markers keep a bare-substring match — they are
  // this repo's own distinctive path components (`scratchpad`, `forge-
  // security-N`), not a generic word a real project directory would also
  // happen to contain.
  const scratchMarker = /(?:^|[\s"'=])\/tmp\/|AppData[\\/]Local[\\/]Temp[\\/]|scratchpad[\\/]|\.tmp-review[\\/]|forge-(?:security|review)-\d+[\\/]/;
  const scratchEscape = /(?:\/tmp|AppData[\\/]Local[\\/]Temp|scratchpad|\.tmp-review|forge-(?:security|review)-\d+)[\\/]\.\.(?:[\\/]|$)/;
  if (scratchMarker.test(text) && !scratchEscape.test(text)) {
    reasons.push('scratch-path');
  }
  // Writing ABOUT a blocked command (PR body, heredoc doc/test fixture) rather
  // than invoking it — the literal-string caveat: the denylist matches inside
  // quoted/heredoc bodies too, so quoting a blocked string here still trips it.
  // Anchored to `$(cat …)` COMMAND SUBSTITUTION specifically — never a bare
  // `cat > file <<EOF` redirect (fifth adversarial-review round, self-review):
  // `$(cat <<EOF … EOF)` never touches the filesystem at all — it only
  // captures the heredoc as a shell STRING, typically to feed `--body`/
  // `--body-file` elsewhere in the same command — so it is safe regardless of
  // what the captured text says. A bare `cat > file <<EOF` genuinely WRITES
  // that content to `file`, which is exactly as dangerous as any other write
  // when the target is sensitive (`cat > ~/.ssh/authorized_keys <<EOF … EOF`
  // installs a real backdoor key; `cat > .git/hooks/pre-commit <<EOF … EOF`
  // installs a real malicious hook) — a prior draft anchored only to `cat`
  // itself and read both as safe "documentation". A scratch-path `cat > file`
  // (e.g. `cat > "$SCRATCH/probe.mjs" <<EOF`) still classifies as guard-testing
  // via the independent scratch-path signal above, so this costs no real
  // recall against the validated data.
  if (/--body-file/.test(text) || /\$\(\s*cat\b[^<\n]{0,40}<<\s*'?"?[A-Za-z_]{2,}'?"?/.test(text)) {
    reasons.push('doc-write');
  }
  // Adversarial-probe: ONLY the ReDoS/length-padding tail survives here after
  // a fourth adversarial-review round (reviewer) removed brace-expansion and
  // ANSI-C/quote-spelling entirely. Both were previously treated as a safe
  // "guard-testing shape" signal; both are reproducibly exploitable as the
  // literal MECHANISM a real bypass would use, not just a shape a tester
  // happens to favour:
  //   - `git branch {{a,b},-D} release-2026` (nested) bash-expands to three
  //     CLEAN standalone arguments — `a`, `b`, `-D` — a real, complete `-D`
  //     flag with no interfering garbage. Reproduced directly.
  //   - The previously-required "4+ consecutive groups" bar (meant to rule
  //     out ordinary 2-3-group Cartesian multi-target syntax) does not close
  //     this: `{--,}{r,}{f,}{,X}` is 4 non-nested groups, each with an empty
  //     branch, whose Cartesian product includes the single clean combination
  //     `--rf` alongside the empty-string/garbage combinations — the same
  //     flaw, just spread across more groups instead of nesting.
  //   - `$'-f'` cleanly, unconditionally bash-expands to the literal two-char
  //     string `-f` — no combinatorics needed at all; `git push $'-f' origin
  //     main` really does force-push if executed for real.
  // Text alone cannot distinguish "a security role spelling out a bypass to
  // prove the guard catches it" from "an attacker (or a confused agent)
  // spelling out a real one" — the command text is deliberately identical in
  // both cases, by design of these evasion techniques. That is a genuine
  // limit of what this classifier's evidence can support, disclosed rather
  // than papered over: a blocked-edit using brace-expansion or ANSI-C/quote
  // obfuscation now falls to "unclassified" and stays visible — the correct,
  // safe default per AC.2 — instead of being auto-labelled guard-testing on
  // the strength of a shape a real bypass could equally produce.
  //
  // The padding tail is different in kind, not degree: the primary command
  // sits in full, un-obscured plain text BEFORE the `;`, so whichever
  // denylist rule matched it already saw exactly what it needed to see — the
  // padding neither hides nor helps construct anything, and a real attacker
  // gains nothing from appending 30+ repeated characters. The only plausible
  // reason is deliberately stress-testing the guard's own regex engine
  // (confirmed against this run's real evidence: forge:security's own
  // `git push --force origin main ; echo yyyyy…` ReDoS probes).
  if (/;\s*echo\s+y{5,}/.test(text)) {
    reasons.push('adversarial-probe');
  }
  return { guardTesting: reasons.length > 0, reasons };
}

/**
 * One-line command excerpt for inline evidence (AC.3). `max` is 300 —
 * `denylist.mjs` already hard-caps a journaled `cmd` to 300 chars at capture
 * time, so this never truncates BELOW what `classifyBlockedEdit()` itself
 * saw. A shorter bound (a prior draft used 140) reproducibly broke the
 * report's own stated invariant — "a maintainer approving a proposal is
 * always looking at the same text this function did" — whenever the
 * matched discriminator or the dangerous verb sat past that shorter cutoff
 * in an otherwise-legitimate-looking command (adversarial security review,
 * #465 fix wave). Backticks are replaced (never left to break out of the
 * Markdown inline-code span this excerpt is always embedded in, matching
 * this codebase's own `escapeMd()` precedent in `board/escalate.mjs`).
 */
function cmdExcerpt(cmd, max = 300) {
  if (typeof cmd !== 'string' || !cmd) return null;
  const oneLine = cmd.replace(/\s+/g, ' ').replaceAll('`', "'").trim();
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
// Full descriptions keyed by reason code — proposalFor() looks up only the
// reasons that actually matched (reviewer finding, #465 fix wave: the prior
// text always printed all four category descriptions regardless of which
// reason(s) fired, reading as if every signal had matched when only one had).
const REASON_LABELS = {
  'denylist-harness': 'denylist-harness invocation',
  'scratch-path': 'scratch/review-worktree path',
  'doc-write': 'doc-write (heredoc/--body-file)',
  'adversarial-probe': 'adversarial-probe (ReDoS-padding) shape',
};

function proposalFor(c) {
  if (c.kind !== 'blocked-edit') return PROPOSALS[c.kind] ?? 'memory entry';
  const rule = c.events[0]?.rule ?? 'unknown-rule';
  const { guardTesting, reasons } = classifyBlockedEdit(c.events[0]?.cmd);
  if (guardTesting) {
    const why = reasons.map((r) => REASON_LABELS[r] ?? r).join(', ');
    return `no role-card change proposed — every event matching \`${rule}\` here carries a guard-testing signal (${why}). This reads as the guard being deliberately exercised, not an agent reaching for the action. Kept as evidence only.`;
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
    for (const c of singles) {
      // A single guard-testing blocked-edit event asserts a positive ("this
      // reads as guard-testing") with no repeat evidence to lean on — unlike a
      // repeat cluster it had no `Sample:` line at all pre-fix (reviewer
      // finding, #465 fix wave). Print the excerpt here too so that assertion
      // is never made without something a maintainer can check it against.
      const excerpt = c.kind === 'blocked-edit' ? cmdExcerpt(c.events[0]?.cmd) : null;
      lines.push(excerpt ? `- ${c.kind}: ${c.signature} — \`${excerpt}\`` : `- ${c.kind}: ${c.signature}`);
    }
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
