#!/usr/bin/env node
/**
 * Situation gate (spec §7 — situations change what's ALLOWED; SP10 T2).
 *   --action ship    [--branch <name>]   incident: hotfix/* only · security-response: refused
 *   --action release                     incident or security-response: refused
 *   --action backend                     security-response: refused (CLI backends frozen)
 *   --action skill   --skill <name>      security-response: respond/investigate only
 * Exit 0 = proceed, 1 = refused (teaching message names the unlocking command).
 */
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { deriveSituation } from '../lib/situation.mjs';
import { parseBranch } from '../lib/ticket.mjs';

const RESPOND_SKILLS = ['respond', 'investigate'];
const UNLOCK = {
  incident: 'close it first: node plugin/scripts/care/incident.mjs close --ticket <n> --postmortem "<ref>"',
  'security-response': 'containment first; clear with: node plugin/scripts/care/incident.mjs respond-close --postmortem "<ref>"',
  paused: 'resume the machine: node control/control.mjs resume (or delete ~/.forge/control/paused — human-only clear)',
};

export function parseArgs(argv) {
  const a = { action: null, branch: '', skill: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--action') a.action = argv[++i];
    else if (argv[i] === '--branch') a.branch = argv[++i];
    else if (argv[i] === '--skill') a.skill = argv[++i];
  }
  return a;
}

/** Pure rule table: (situationKey, action, {branch, skill, paused}) -> {allowed, why}. */
export function evaluate(situationKey, action, { branch = '', skill = null, paused = false } = {}) {
  // The machine kill switch holds ship/release regardless of the care-situation (#68):
  // even a hotfix during an incident does not ship while the owner has paused the machine.
  // It does NOT freeze containment (backend/skill) — paused stops *shipping*, not response.
  if (paused && (action === 'ship' || action === 'release')) {
    return { allowed: false, why: `paused: the machine is held — ${action} waits until resumed (spec §2). ${UNLOCK.paused}` };
  }
  if (situationKey === 'security-response') {
    if (action === 'skill' && RESPOND_SKILLS.includes(skill)) return { allowed: true, why: `${skill} runs during security-response` };
    return {
      allowed: false,
      why: `security-response: deploys frozen, CLI backends disabled, only ${RESPOND_SKILLS.join('/')} run (spec §7). ${UNLOCK['security-response']}`,
    };
  }
  if (situationKey === 'incident') {
    if (action === 'ship') {
      const kind = parseBranch(branch).kind;
      if (kind === 'hotfix') return { allowed: true, why: 'hotfix branch — the incident lane' };
      return { allowed: false, why: `incident: ship/release pause for non-hotfix branches (spec §7); '${branch || '?'}' is not hotfix/*. ${UNLOCK.incident}` };
    }
    if (action === 'release') return { allowed: false, why: `incident: releases pause until the incident closes. ${UNLOCK.incident}` };
  }
  return { allowed: true, why: `situation '${situationKey}' does not restrict '${action}'` };
}

export async function runGate(cwd, args, log = console.log, { controlBase } = {}) {
  if (!['ship', 'release', 'backend', 'skill'].includes(args.action)) {
    return { ok: false, allowed: false, error: '--action must be ship|release|backend|skill' };
  }
  const s = await deriveSituation(cwd, { blocked: 0, inProgress: 0 }, { controlBase });
  const verdict = evaluate(s.key, args.action, { ...args, paused: s.paused });
  const tag = s.paused && s.key !== 'paused' ? `${s.glyph} ${s.key}+paused` : `${s.glyph} ${s.key}`;
  log(`situation-gate [${tag}] ${args.action}${args.branch ? ` (${args.branch})` : ''}${args.skill ? ` (${args.skill})` : ''}: ${verdict.allowed ? 'proceed' : 'REFUSED'} — ${verdict.why}`);
  return { ok: true, allowed: verdict.allowed, situation: s.key, paused: s.paused, why: verdict.why };
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  runGate(process.cwd(), parseArgs(process.argv.slice(2))).then((res) => {
    if (!res.ok) { console.error(res.error); process.exit(1); }
    process.exit(res.allowed ? 0 : 1);
  });
}
