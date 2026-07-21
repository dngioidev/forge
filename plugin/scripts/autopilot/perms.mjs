#!/usr/bin/env node
/**
 * autopilot perms (#156) — print the `.claude/settings.local.json` permission
 * allowlist autopilot needs to run CONTINUOUSLY. Autopilot is an autonomous mode:
 * without these, every outward command (gh pr merge, git push, gh issue close…)
 * prompts and stalls the loop. This script only PRINTS the block — it never
 * writes it. Granting auto-merge/push authority is the human's call to make.
 */
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

/** The commands autopilot + its delivery subagents run unattended. */
export const ALLOW = [
  'Bash(gh pr create:*)',
  'Bash(gh pr merge:*)',
  'Bash(gh pr view:*)',
  'Bash(gh pr checks:*)',
  'Bash(gh issue create:*)',
  'Bash(gh issue edit:*)',
  'Bash(gh issue close:*)',
  'Bash(gh issue comment:*)',
  'Bash(gh issue view:*)',
  'Bash(git push:*)',
  'Bash(git commit:*)',
  'Bash(git checkout:*)',
  'Bash(git rebase:*)',
  'Bash(node:*)',
];

/** The exact object to merge into .claude/settings.local.json. */
export function permsBlock(allow = ALLOW) {
  return { permissions: { allow: [...allow] } };
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  console.log('# Merge this into .claude/settings.local.json to let forge:autopilot run continuously.');
  console.log('# It grants unattended auto-merge / push authority — review before adding.');
  console.log(JSON.stringify(permsBlock(), null, 2));
}
