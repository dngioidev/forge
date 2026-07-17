#!/usr/bin/env node
/**
 * Incident + security-response mechanics (spec §4 items 8/18, §7, §8; SP10 T1).
 * The journal is the source of truth — these commands write the events
 * `deriveSituation` consumes; nothing sets a situation by hand.
 *
 *   incident.mjs open --ticket <n> --summary "…"        -> situation: incident
 *   incident.mjs close --ticket <n> --postmortem "<ref>" -> cleared
 *   incident.mjs respond-open --reason "…"               -> security-response
 *   incident.mjs respond-close --postmortem "<ref>"      -> cleared
 *
 * close/respond-close REQUIRE a postmortem ref — the mandatory-postmortem law
 * is enforced where the state clears, not requested in prose.
 */
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { append as journalAppend } from '../lib/journal.mjs';
import { deriveSituation } from '../lib/situation.mjs';

export function parseArgs(argv) {
  const a = { cmd: argv[0] ?? null, ticket: null, summary: null, postmortem: null, reason: null };
  for (let i = 1; i < argv.length; i++) {
    if (argv[i] === '--ticket') a.ticket = Number(argv[++i]);
    else if (argv[i] === '--summary') a.summary = argv[++i];
    else if (argv[i] === '--postmortem') a.postmortem = argv[++i];
    else if (argv[i] === '--reason') a.reason = argv[++i];
  }
  return a;
}

export async function runIncident(cwd, args, log = console.log) {
  switch (args.cmd) {
    case 'open': {
      if (!Number.isInteger(args.ticket) || !args.summary) return { ok: false, error: 'open needs --ticket <n> and --summary "…"' };
      await journalAppend(cwd, 'incident', { phase: 'open', ticket: `#${args.ticket}`, summary: args.summary });
      break;
    }
    case 'close': {
      if (!Number.isInteger(args.ticket) || !args.postmortem) {
        return { ok: false, error: 'close needs --ticket <n> and --postmortem "<ticket/link>" — an incident without a postmortem never happened as far as learning is concerned (spec §4 item 8)' };
      }
      await journalAppend(cwd, 'incident', { phase: 'closed', ticket: `#${args.ticket}`, postmortem: args.postmortem });
      break;
    }
    case 'respond-open': {
      if (!args.reason) return { ok: false, error: 'respond-open needs --reason "…"' };
      await journalAppend(cwd, 'respond-open', { reason: args.reason });
      break;
    }
    case 'respond-close': {
      if (!args.postmortem) {
        return { ok: false, error: 'respond-close needs --postmortem "<ticket/link>" — containment is done only when the postmortem is filed (spec §4 item 18)' };
      }
      await journalAppend(cwd, 'respond-close', { postmortem: args.postmortem });
      break;
    }
    default:
      return { ok: false, error: 'usage: incident.mjs <open|close|respond-open|respond-close> …' };
  }
  const s = await deriveSituation(cwd);
  log(`${args.cmd}: situation is now ${s.glyph} ${s.key}`);
  return { ok: true, situation: s.key };
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  runIncident(process.cwd(), parseArgs(process.argv.slice(2))).then((res) => {
    if (!res.ok) { console.error(res.error); process.exit(1); }
  });
}
