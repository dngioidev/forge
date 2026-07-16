#!/usr/bin/env node
/**
 * board create — issue + parent sub-issue + board item + fields + assignee,
 * one command, resumable (spec §6 idempotency law; plan T2, AC-2.1).
 */
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { run, makeGh } from '../lib/exec.mjs';
import { makeBoardCtx } from '../lib/boardctx.mjs';
import { getIssueNode, addSubIssue } from '../lib/issues.mjs';

export function parseArgs(argv) {
  const a = { title: null, body: '', type: 'item', priority: 'p1', size: 'm', status: 'backlog', parent: null, assignee: null };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--title') a.title = argv[++i];
    else if (k === '--body') a.body = argv[++i];
    else if (k === '--type') a.type = argv[++i];
    else if (k === '--priority') a.priority = argv[++i];
    else if (k === '--size') a.size = argv[++i];
    else if (k === '--status') a.status = argv[++i];
    else if (k === '--parent') a.parent = Number(argv[++i]);
    else if (k === '--assignee') a.assignee = argv[++i];
  }
  return a;
}

export async function runCreate(ctx, args, log = console.log) {
  if (!args.title) return { ok: false, error: '--title is required' };
  // validate option keys up front so we fail before creating anything
  for (const [f, k] of [['type', args.type], ['priority', args.priority], ['size', args.size], ['status', args.status]]) {
    const r = ctx.resolveOption(f, k);
    if (!r.ok) return { ok: false, error: r.error };
  }

  // 1. issue: find by exact title first (never duplicate)
  const found = await ctx.gh(
    ['issue', 'list', '--state', 'all', '--limit', '100', '--search', `"${args.title}" in:title`, '--json', 'number,title,url'],
    { parseJson: true },
  );
  if (!found.ok) return { ok: false, error: found.stderr || 'issue list failed' };
  let issue = found.json.find((i) => i.title === args.title) ?? null;
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
  for (const [fieldKey, wanted] of [['type', args.type], ['priority', args.priority], ['size', args.size], ['status', args.status]]) {
    const current = existing.item ? ctx.itemFieldKey(existing.item, fieldKey) : null;
    if (current === wanted) continue;
    const set = await ctx.setSelect(itemId, fieldKey, wanted);
    if (!set.ok) return { ok: false, error: set.error };
    log(`field: ${fieldKey}=${wanted}`);
  }

  return { ok: true, number: issue.number, itemId };
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  const gh = makeGh(run);
  makeBoardCtx({ gh, cwd: process.cwd() }).then(async (ctx) => {
    if (!ctx.ok) { console.error(ctx.error); process.exit(1); }
    const res = await runCreate(ctx, parseArgs(process.argv.slice(2)));
    if (!res.ok) { console.error(`create failed: ${res.error}`); process.exit(1); }
    console.log(`created/verified #${res.number}`);
  });
}
