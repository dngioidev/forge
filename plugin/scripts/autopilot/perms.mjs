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
import { ALLOWED_COMMAND_PREFIXES } from '../lib/allowed-commands.mjs';

/**
 * The commands autopilot + its delivery subagents run unattended, derived
 * from the single-sourced prefix list (#429 AC.4) shared with the agy
 * PreToolUse hook (`plugin/hooks/agy-deny.mjs`) — extend the prefixes there,
 * not this array, so the two hosts cannot drift.
 */
export const ALLOW = ALLOWED_COMMAND_PREFIXES.map((prefix) => `Bash(${prefix}:*)`);

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
