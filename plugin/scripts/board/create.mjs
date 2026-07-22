#!/usr/bin/env node
/**
 * board create — issue + parent sub-issue + board item + fields + assignee,
 * one command, resumable (spec §6 idempotency law; plan T2, AC-2.1).
 */
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { run, makeGh } from '../lib/exec.mjs';
import { makeBoardCtx } from '../lib/boardctx.mjs';
import { getIssueNode, addSubIssue } from '../lib/issues.mjs';
import { titleSearchQuery } from '../lib/board.mjs';

/** Defaults applied to a single ticket spec (flags or a --from JSON entry). */
export function withDefaults(spec = {}) {
  return { title: null, body: '', type: 'item', priority: 'p1', size: 'm', status: 'backlog', phase: null, area: null, parent: null, assignee: null, labels: [], milestone: null, ...spec };
}

const KNOWN_FLAGS = '--title --body --body-file --type --priority --size --status --phase --area --parent --assignee --label --milestone --from';

export function parseArgs(argv) {
  const a = withDefaults();
  a.from = null;
  a.bodyFile = null;
  a.unknownFlags = [];
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--title') a.title = argv[++i];
    else if (k === '--body') a.body = argv[++i];
    else if (k === '--body-file') a.bodyFile = argv[++i];
    else if (k === '--type') a.type = argv[++i];
    else if (k === '--priority') a.priority = argv[++i];
    else if (k === '--size') a.size = argv[++i];
    else if (k === '--status') a.status = argv[++i];
    else if (k === '--phase') a.phase = argv[++i];
    else if (k === '--area') a.area = argv[++i];
    else if (k === '--parent') a.parent = Number(argv[++i]);
    else if (k === '--assignee') a.assignee = argv[++i];
    else if (k === '--label') a.labels.push(argv[++i]);
    else if (k === '--milestone') a.milestone = argv[++i];
    else if (k === '--from') a.from = argv[++i];
    else a.unknownFlags.push(k); // #104: never silently drop — a swallowed --body-file made empty-body tickets
  }
  return a;
}

/**
 * Batch create from a list of specs (#87). Runs the same idempotent create per
 * entry, sequentially, and CONTINUES past a per-entry failure — one bad ticket
 * doesn't sink the rest. Returns a summary + per-entry results. Run it in the
 * background for large batches (it's N round-trips, one invocation).
 */
export async function runCreateBatch(ctx, specs, log = console.log) {
  if (!Array.isArray(specs) || specs.length === 0) return { ok: false, error: '--from file must be a non-empty JSON array of ticket specs' };
  const results = [];
  let created = 0; let skipped = 0; let failed = 0;
  for (const [i, raw] of specs.entries()) {
    const spec = withDefaults(raw);
    log(`[${i + 1}/${specs.length}] ${spec.title ?? '(no title)'}`);
    const r = await runCreate(ctx, spec, log);
    if (r.ok) { r.resumed ? skipped++ : created++; results.push({ ok: true, title: spec.title, number: r.number }); }
    else { failed++; results.push({ ok: false, title: spec.title, error: r.error }); log(`  ✗ ${r.error}`); }
  }
  log(`batch: ${created} created, ${skipped} resumed, ${failed} failed of ${specs.length}`);
  return { ok: failed === 0, created, skipped, failed, results };
}

export async function runCreate(ctx, args, log = console.log) {
  // #104: fail-fast on unrecognized flags rather than dropping them silently.
  if (args.unknownFlags?.length) {
    return { ok: false, error: `unrecognized flag(s): ${args.unknownFlags.join(', ')} — supported: ${KNOWN_FLAGS}` };
  }
  // #104: --body-file reads the body from a file (the flag that used to be swallowed).
  if (args.bodyFile) {
    try { args = { ...args, body: await readFile(args.bodyFile, 'utf8') }; }
    catch (e) { return { ok: false, error: `--body-file: cannot read ${args.bodyFile}: ${e.message}` }; }
  }
  if (!args.title) return { ok: false, error: '--title is required' };
  // validate option keys up front so we fail before creating anything
  for (const [f, k] of [['type', args.type], ['priority', args.priority], ['size', args.size], ['status', args.status]]) {
    const r = ctx.resolveOption(f, k);
    if (!r.ok) return { ok: false, error: r.error };
  }
  // #114: optional Phase, only when the consumer configured a Phase field
  if (args.phase != null) {
    if (!ctx.fields.phase) return { ok: false, error: '--phase given but no Phase field is configured — forge:init maps it when the project has a "Phase" single-select' };
    const r = ctx.resolveOption('phase', args.phase);
    if (!r.ok) return { ok: false, error: r.error };
  }
  // #146: optional Area, same rule — only when the consumer configured an Area field
  if (args.area != null) {
    if (!ctx.fields.area) return { ok: false, error: '--area given but no Area field is configured — forge:init maps it when the project has an "Area" single-select' };
    const r = ctx.resolveOption('area', args.area);
    if (!r.ok) return { ok: false, error: r.error };
  }

  // 1. issue: find by exact title first (never duplicate). The search is a
  // coarse, quote-safe prefilter (#173 — a raw quote in the title used to break
  // it and spawn a duplicate); the exact `i.title === args.title` below is what
  // actually decides the resume.
  const found = await ctx.gh(
    ['issue', 'list', '--state', 'all', '--limit', '100', '--search', titleSearchQuery(args.title), '--json', 'number,title,url'],
    { parseJson: true },
  );
  if (!found.ok) return { ok: false, error: found.stderr || 'issue list failed' };
  let issue = found.json.find((i) => i.title === args.title) ?? null;
  const resumed = !!issue;
  if (issue) {
    log(`issue: exists #${issue.number} (resuming)`);
  } else {
    const createArgs = ['issue', 'create', '--title', args.title, '--body', args.body];
    if (args.assignee) createArgs.push('--assignee', args.assignee);
    const created = await ctx.gh(createArgs);
    if (!created.ok) return { ok: false, error: created.stderr || 'issue create failed' };
    const url = created.stdout.trim().split(/\r?\n/).pop();
    const num = Number((/\/issues\/(\d+)/.exec(url) ?? [])[1]);
    issue = { number: num, url };
    log(`issue: created #${num}`);
  }

  // 1b. #146: labels + milestone via one idempotent edit (works for both the
  // just-created and the resumed issue; --add-label + --milestone are idempotent).
  if ((args.labels && args.labels.length) || args.milestone) {
    const editArgs = ['issue', 'edit', String(issue.number)];
    for (const l of args.labels ?? []) editArgs.push('--add-label', l);
    if (args.milestone) editArgs.push('--milestone', args.milestone);
    const edited = await ctx.gh(editArgs);
    if (!edited.ok) return { ok: false, error: edited.stderr || 'issue edit (labels/milestone) failed — do the label/milestone exist in the repo?' };
    log(`meta: ${[args.labels?.length ? `label ${args.labels.join(',')}` : null, args.milestone ? `milestone ${args.milestone}` : null].filter(Boolean).join(' · ')}`);
  }

  // 2. parent sub-issue link (skip when already parented)
  if (args.parent != null) {
    const child = await getIssueNode(ctx.gh, ctx.owner, ctx.repo, issue.number);
    if (!child.ok) return { ok: false, error: child.error };
    if (child.parentNumber === args.parent) {
      log(`parent: already linked to #${args.parent}`);
    } else if (child.parentNumber != null) {
      log(`parent: linked to #${child.parentNumber}, leaving as-is (wanted #${args.parent})`);
    } else {
      const parent = await getIssueNode(ctx.gh, ctx.owner, ctx.repo, args.parent);
      if (!parent.ok) return { ok: false, error: parent.error };
      const linked = await addSubIssue(ctx.gh, parent.id, child.id);
      if (!linked.ok) return { ok: false, error: linked.error };
      log(`parent: linked #${issue.number} under #${args.parent}`);
    }
  }

  // 3. board item
  const existing = await ctx.findItemByIssue(issue.number);
  if (!existing.ok) return { ok: false, error: existing.error };
  let itemId = existing.item?.id ?? null;
  if (itemId) {
    log('board: item exists');
  } else {
    const url = issue.url ?? `https://github.com/${ctx.owner}/${ctx.repo}/issues/${issue.number}`;
    const added = await ctx.addItemByUrl(url);
    if (!added.ok) return { ok: false, error: added.error };
    itemId = added.itemId;
    log('board: item added');
  }

  // 4. fields — set only what differs (resume-friendly)
  const fieldSets = [['type', args.type], ['priority', args.priority], ['size', args.size], ['status', args.status]];
  if (args.phase != null) fieldSets.push(['phase', args.phase]);
  if (args.area != null) fieldSets.push(['area', args.area]);
  for (const [fieldKey, wanted] of fieldSets) {
    const current = existing.item ? ctx.itemFieldKey(existing.item, fieldKey) : null;
    if (current === wanted) continue;
    const set = await ctx.setSelect(itemId, fieldKey, wanted);
    if (!set.ok) return { ok: false, error: set.error };
    log(`field: ${fieldKey}=${wanted}`);
  }

  return { ok: true, number: issue.number, itemId, resumed };
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  const gh = makeGh(run);
  makeBoardCtx({ gh, cwd: process.cwd() }).then(async (ctx) => {
    if (!ctx.ok) { console.error(ctx.error); process.exit(1); }
    const args = parseArgs(process.argv.slice(2));
    if (args.from) {
      let specs;
      try { specs = JSON.parse(await readFile(args.from, 'utf8')); } catch (e) { console.error(`--from: cannot read/parse ${args.from}: ${e.message}`); process.exit(1); }
      const res = await runCreateBatch(ctx, specs);
      process.exit(res.ok ? 0 : 1); // failures already logged per-entry
    }
    const res = await runCreate(ctx, args);
    if (!res.ok) { console.error(`create failed: ${res.error}`); process.exit(1); }
    console.log(`created/verified #${res.number}`);
  });
}
