#!/usr/bin/env node
/**
 * board reparent — move a sub-issue to a different parent epic (#87).
 * Restructuring the tree previously meant hand-written GraphQL `addSubIssue`
 * with `replaceParent`; this wraps it.
 *
 *   reparent.mjs --issue <n> --parent <m>
 *
 * Uses addSubIssue({replaceParent:true}) so a child that already has a parent is
 * moved, not rejected. Idempotent: if it's already under <m>, it's a no-op.
 */
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { run, makeGh } from '../lib/exec.mjs';
import { getRepoInfo } from '../lib/board.mjs';
import { getIssueNode, addSubIssue } from '../lib/issues.mjs';

export function parseArgs(argv) {
  const a = { issue: null, parent: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--issue') a.issue = Number(argv[++i]);
    else if (argv[i] === '--parent') a.parent = Number(argv[++i]);
  }
  return a;
}

export async function runReparent(gh, owner, repo, args, log = console.log) {
  if (!Number.isInteger(args.issue) || !Number.isInteger(args.parent)) {
    return { ok: false, error: '--issue <n> and --parent <m> are both required' };
  }
  if (args.issue === args.parent) return { ok: false, error: 'an issue cannot be its own parent' };

  const child = await getIssueNode(gh, owner, repo, args.issue);
  if (!child.ok) return { ok: false, error: child.error };
  if (child.parentNumber === args.parent) {
    log(`reparent: #${args.issue} already under #${args.parent} — no-op`);
    return { ok: true, moved: false };
  }
  const parent = await getIssueNode(gh, owner, repo, args.parent);
  if (!parent.ok) return { ok: false, error: parent.error };

  const r = await addSubIssue(gh, parent.id, child.id, { replaceParent: true });
  if (!r.ok) return { ok: false, error: r.error };
  log(`reparent: #${args.issue} moved${child.parentNumber ? ` from #${child.parentNumber}` : ''} to #${args.parent}`);
  return { ok: true, moved: true, from: child.parentNumber ?? null, to: args.parent };
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  const gh = makeGh(run);
  getRepoInfo(gh).then(async (repo) => {
    if (!repo.ok) { console.error(repo.error); process.exit(1); }
    const res = await runReparent(gh, repo.owner, repo.name, parseArgs(process.argv.slice(2)));
    if (!res.ok) { console.error(`reparent failed: ${res.error}`); process.exit(1); }
  });
}
