#!/usr/bin/env node
/**
 * board escalate — the halt-and-ask spine (spec §7; plan T2, AC-3.2).
 * Open: ticket → blocked + decision comment + journal + pending file.
 * Check: detect the human's reply, resolve, hand the decision back.
 */
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { writeFile, mkdir, readFile } from 'node:fs/promises';
import { run, makeGh } from '../lib/exec.mjs';
import { makeBoardCtx } from '../lib/boardctx.mjs';
import { upsertMarkedComment, listComments } from '../lib/issues.mjs';
import { append as journalAppend } from '../lib/journal.mjs';
import { pendingDecisions } from '../lib/situation.mjs';
import { runMove } from './move.mjs';
import { writeJson } from '../lib/jsonfile.mjs';

// #557 (AC-5 audit): --reason/--context are exactly the "escalation reason"
// free text the denylist literal-string caveat names (autopilot/SKILL.md
// § Literal-string caveat already instructs subagents to pass these via a
// file — a mechanism that didn't exist until this fix) — so escalate.mjs
// gets the same --*-file treatment as comment.mjs, not just an audit note.
const KNOWN_FLAGS = '--issue --reason --reason-file --options --recommend --context --context-file --check';

export function parseArgs(argv) {
  const a = { issue: null, reason: null, reasonFile: null, options: null, recommend: null, context: '', contextFile: null, check: false, unknownFlags: [] };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--issue') a.issue = Number(argv[++i]);
    else if (k === '--reason') a.reason = argv[++i];
    else if (k === '--reason-file') a.reasonFile = argv[++i];
    else if (k === '--options') a.options = argv[++i];
    else if (k === '--recommend') a.recommend = argv[++i];
    else if (k === '--context') a.context = argv[++i];
    else if (k === '--context-file') a.contextFile = argv[++i];
    else if (k === '--check') a.check = true;
    else a.unknownFlags.push(k); // #557 (AC-4-style): never silently drop, matching create.mjs (#104)
  }
  return a;
}

/** Shared fail-fast guard for both entry points (escalate + check) — same parseArgs feeds both. */
function rejectUnknownFlags(args) {
  if (args.unknownFlags?.length) {
    return { ok: false, error: `unrecognized flag(s): ${args.unknownFlags.join(', ')} — supported: ${KNOWN_FLAGS}` };
  }
  return null;
}

/**
 * #557: --reason/--context-file read the same way as comment.mjs's
 * --body-file (same error-message shape); --*-file and its inline sibling are
 * mutually exclusive (never a silent winner, mirrors comment.mjs AC-3).
 */
async function resolveFileArg(args, inlineKey, fileKey, flagName) {
  if (args[inlineKey] && args[fileKey]) {
    return { ok: false, error: `--${flagName} and --${flagName}-file are mutually exclusive — pass one, not both` };
  }
  if (args[fileKey]) {
    try { return { ok: true, value: await readFile(args[fileKey], 'utf8') }; }
    catch (e) { return { ok: false, error: `--${flagName}-file: cannot read ${args[fileKey]}: ${e.message}` }; }
  }
  return { ok: true, value: args[inlineKey] };
}

/**
 * The CLI passes a pipe-joined string (`--options "a|b|c"`); the MCP surface
 * passes a structured array. Only the string form is split on '|' — an array
 * element keeps any embedded '|' as literal text, so it cannot reconstitute
 * into extra downstream options and defeat the caller's maxItems bound (#300 AC.1).
 */
export function normalizeOptions(raw) {
  const arr = Array.isArray(raw) ? raw : String(raw ?? '').split('|');
  return arr.map((s) => String(s).trim()).filter(Boolean);
}

/**
 * Neutralize caller-supplied text before it lands in the trusted decision
 * comment (#300 AC.2). Escapes backslash + Markdown/HTML control punctuation so
 * caller text cannot forge block structure (headings, list items, a fake
 * "recommended" tag) or inject a `<!-- forge:... -->` marker. Includes both
 * setext underline chars (`-` and `=`) so an embedded-newline payload cannot
 * forge an H1/H2 heading.
 */
export function escapeMd(s) {
  return String(s ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/([`*_{}\[\]()#+.<>|~=-])/g, '\\$1');
}

export async function runEscalate(ctx, args, log = console.log) {
  const unknown = rejectUnknownFlags(args);
  if (unknown) return unknown;
  if (!Number.isInteger(args.issue)) return { ok: false, error: '--issue <number> is required' };
  const reasonResolved = await resolveFileArg(args, 'reason', 'reasonFile', 'reason');
  if (!reasonResolved.ok) return reasonResolved;
  const contextResolved = await resolveFileArg(args, 'context', 'contextFile', 'context');
  if (!contextResolved.ok) return contextResolved;
  args = { ...args, reason: reasonResolved.value, context: contextResolved.value ?? '' };
  if (!args.reason) return { ok: false, error: '--reason or --reason-file is required' };
  const options = normalizeOptions(args.options);
  if (options.length < 2) return { ok: false, error: '--options "a|b[|c…]" needs at least two options' };

  const id = `esc-${args.issue}-${Date.now().toString(36)}`;

  // Adopted boards may not map 'blocked' — degrade gracefully (spec §5): the
  // decision comment is the escalation; the column is only its shadow.
  let boardNote = 'board → blocked';
  if (ctx.fields?.status?.options?.blocked) {
    const moved = await runMove(ctx, { issue: args.issue, status: 'blocked' }, () => {});
    if (!moved.ok) return moved;
  } else {
    boardNote = "board unchanged (no 'blocked' status option mapped — add one in the project UI and re-run /forge:init to enable it)";
  }

  const lines = [
    `🚩 **Decision needed** (\`${id}\`)`,
    '',
    `**Why halted:** ${escapeMd(args.reason)}`,
    ...(args.context ? ['', escapeMd(args.context)] : []),
    '',
    '**Options:**',
    ...options.map((o, i) => `${i + 1}. ${escapeMd(o)}${args.recommend === o || args.recommend === String(i + 1) ? ' ← **recommended**' : ''}`),
    '',
    '_Reply in this thread with your choice (number or text). The pipeline is halted until then (spec §7)._',
  ];
  const comment = await upsertMarkedComment(ctx.gh, ctx.owner, ctx.repo, args.issue, `decision:${id}`, lines.join('\n'));
  if (!comment.ok) return comment;

  await journalAppend(ctx.cwd, 'escalation', { issue: args.issue, id, reason: args.reason, options });

  await mkdir(join(ctx.cwd, '.forge', 'decisions'), { recursive: true });
  await writeJson(join(ctx.cwd, '.forge', 'decisions', `${id}.json`), {
    id, issue: args.issue, reason: args.reason, options, recommend: args.recommend ?? null,
    commentId: comment.id, status: 'pending', createdAt: new Date().toISOString(),
  });

  log(`escalated #${args.issue} (${id}) — ${boardNote}, decision comment posted`);
  // pending is always true on a fresh open — a pending decision file was just
  // written and the pipeline is halted until the human replies (spec §7).
  return { ok: true, id, boardNote, pending: true };
}

// #499 AC-499.5 fix-wave (adversarial `forge:security`, ROUND 2): round 1's fix
// gated only the board MOVE on trust and left decision-file resolution itself
// unconditional — but resolution alone is enough to defeat AC-499.1's
// protection (select.mjs's `pendingIssues` excludes a ticket purely by reading
// `status === 'pending'` off the decision file), on any board with no
// `blocked` option mapped or once status has drifted off `blocked`. So the
// WHOLE resolve — not just the move — is gated: an untrusted reply is treated
// as noise, not an answer, and the decision stays pending until a genuinely
// trusted one lands. GitHub's own `author_association` on each comment (never
// derived from caller-controlled comment text) tells us whether the replier
// has write-ish access; OWNER/MEMBER/COLLABORATOR are the only associations
// that can legitimately answer an escalation for a repo this size.
const TRUSTED_REPLY_ASSOCIATIONS = new Set(['OWNER', 'MEMBER', 'COLLABORATOR']);

/** Scan pending decisions for a TRUSTED human reply (a later, non-forge-marked comment from someone with write access). */
export async function runCheck(ctx, args, log = console.log) {
  const unknown = rejectUnknownFlags(args);
  if (unknown) return unknown;
  const pending = await pendingDecisions(ctx.cwd);
  const targets = args.issue ? pending.filter((d) => d.issue === args.issue) : pending;
  if (targets.length === 0) {
    log('no pending decisions');
    return { ok: true, resolved: [] };
  }
  const resolved = [];
  for (const d of targets) {
    const list = await listComments(ctx.gh, ctx.owner, ctx.repo, d.issue);
    if (!list.ok) return list;
    const decisionIdx = list.comments.findIndex((c) => c.body?.includes(`forge:decision:${d.id}`));
    const candidates = list.comments.slice(decisionIdx + 1).filter((c) => !c.body?.includes('<!-- forge:'));
    const reply = candidates.find((c) => TRUSTED_REPLY_ASSOCIATIONS.has(c.author_association));
    if (!reply) {
      if (candidates.length > 0) {
        log(`decision ${d.id} (#${d.issue}): ${candidates.length} reply/replies seen but none from a trusted author (write access) — still pending`);
      }
      continue;
    }
    const answer = reply.body.trim();
    await journalAppend(ctx.cwd, 'escalation-resolved', { issue: d.issue, id: d.id, answer });
    await writeJson(join(ctx.cwd, '.forge', 'decisions', `${d.id}.json`), { ...d, status: 'resolved', answer, resolvedAt: new Date().toISOString() });
    // #499 AC-499.5: `blocked` is a hard TIER exclusion in selectNext (select.mjs)
    // with no code path off it, so a resolved decision left there is stranded
    // forever. Clear it — but ONLY when the ticket is genuinely sitting at
    // `blocked` right now (adversarial `forge:reviewer` fix-wave): blindly
    // forcing every resolved ticket to `backlog` would demote one that's
    // actually in-flight (`inProgress`/`inReview`) or was never moved off its
    // original status at all (a board with no `blocked` option mapped, #27) —
    // losing real progress state for no reason. `pendingIssues` (this same
    // ticket's other half, in select.mjs/server.mjs) already keeps a pending
    // ticket out of the queue independent of board status, so this move is a
    // courtesy unblock, not the safety mechanism.
    const found = await ctx.findItemByIssue(d.issue);
    const currentStatus = found.ok && found.item ? ctx.itemFieldKey(found.item, 'status') : null;
    let cleared = false;
    if (currentStatus === 'blocked') {
      const moveRes = await runMove(ctx, { issue: d.issue, status: 'backlog' }, log);
      if (!moveRes.ok) log(`decision ${d.id} (#${d.issue}) resolved but board move to backlog failed: ${moveRes.error} — move #${d.issue} by hand`);
      cleared = moveRes.ok;
    } else if (found.ok && found.item) {
      cleared = true; // already off `blocked` (drifted, or never mapped there) — nothing to correct
    } else if (found.ok) {
      // found.ok but item is null: the issue isn't on the board at all — nothing to move,
      // but unlike the genuinely-confirmed-not-blocked case above, this was never actually
      // verified, so it gets its own (still non-fatal) note rather than silent success.
      log(`decision ${d.id} (#${d.issue}) resolved — issue not found on the board, nothing to move`);
      cleared = true;
    } else {
      log(`decision ${d.id} (#${d.issue}) resolved but board status couldn't be confirmed (${found.error}) — not auto-moving (would risk demoting an in-flight ticket); verify #${d.issue} by hand`);
    }
    resolved.push({ id: d.id, issue: d.issue, answer, moved: cleared });
    log(`decision ${d.id} (#${d.issue}) resolved: ${answer.split(/\r?\n/)[0]}`);
  }
  if (resolved.length === 0) log(`${targets.length} decision(s) still pending`);
  return { ok: true, resolved };
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  const gh = makeGh(run);
  makeBoardCtx({ gh, cwd: process.cwd() }).then(async (ctx) => {
    if (!ctx.ok) { console.error(ctx.error); process.exit(1); }
    const args = parseArgs(process.argv.slice(2));
    const res = args.check ? await runCheck(ctx, args) : await runEscalate(ctx, args);
    if (!res.ok) { console.error(`escalate failed: ${res.error}`); process.exit(1); }
  });
}
