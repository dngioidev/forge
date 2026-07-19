#!/usr/bin/env node
/**
 * Claude Code status line v2 (#43): one glanceable strip —
 *   <glyph> <project> · #<ticket> <branch> · ▓▓▓░░░░░ 42% · <model> · $0.42
 * Glyph is ALWAYS present (· idle, ▶ work in progress, 🚩n decisions,
 * 🔥 incident, 🔒 security-response). Segments the payload can't provide are
 * omitted silently — payload shapes vary across Claude Code versions.
 * A status line must never break a session: any error prints nothing (or a
 * partial line) and exits 0.
 */
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { run } from './lib/exec.mjs';
import { parseBranch } from './lib/ticket.mjs';
import { deriveSituation } from './lib/situation.mjs';
import { appendQuotaSample } from './lib/quota.mjs';

/** Context usage across known payload shapes -> {used, max} or null. */
export function extractContext(payload) {
  const cands = [
    payload?.context_window, payload?.context, payload?.usage,
    payload?.cost?.context_window, payload?.model?.context_window,
  ];
  for (const c of cands) {
    if (!c || typeof c !== 'object') continue;
    // real Claude Code shape (docs): total_input_tokens + context_window_size (+ used_percentage)
    const used = [c.total_input_tokens, c.used_tokens, c.used, c.input_tokens, c.tokens_used].find((v) => typeof v === 'number');
    const max = [c.context_window_size, c.max_tokens, c.max, c.limit].find((v) => typeof v === 'number');
    if (typeof used === 'number' && typeof max === 'number' && max > 0) return { used, max };
    if (typeof c.used_percentage === 'number') return { used: c.used_percentage, max: 100 };
  }
  return null;
}

export function renderBar({ used, max }, cells = 8) {
  const ratio = Math.min(1, Math.max(0, used / max));
  const fill = Math.round(ratio * cells);
  return `${'▓'.repeat(fill)}${'░'.repeat(cells - fill)} ${Math.round(ratio * 100)}%`;
}

/** Pure composition — everything optional except the branch. */
/** rate_limits -> '5h 24% / 7d 41%' (either window optional). */
export function renderLimits(rl) {
  const parts = [
    typeof rl?.five_hour?.used_percentage === 'number' ? `5h ${Math.round(rl.five_hour.used_percentage)}%` : null,
    typeof rl?.seven_day?.used_percentage === 'number' ? `7d ${Math.round(rl.seven_day.used_percentage)}%` : null,
  ].filter(Boolean);
  return parts.length ? parts.join(' / ') : null;
}

export function composeLine({ situation, pendingCount, project, branch, ticket, context, model, costUsd, effort, rateLimits }) {
  const glyph =
    situation === 'security-response' ? '🔒' :
    situation === 'incident' ? '🔥' :
    situation === 'awaiting-decision' ? `🚩${pendingCount || ''}` :
    parseBranch(branch ?? '').kind === 'work' || parseBranch(branch ?? '').kind === 'hotfix' ? '▶' : '·';
  const segments = [
    `${glyph} ${project ?? 'forge'}`,
    branch ? (ticket != null ? `#${ticket} ${branch}` : branch) : null,
    context ? renderBar(context) : null,
    model || null,
    effort ? `effort:${effort}` : null,
    renderLimits(rateLimits),
    typeof costUsd === 'number' ? `$${costUsd.toFixed(2)}` : null,
  ];
  return segments.filter(Boolean).join(' · ');
}

async function readStdin() {
  let data = '';
  for await (const chunk of process.stdin) data += chunk;
  return data;
}

async function main() {
  let payload = null;
  try { payload = JSON.parse(await readStdin()); } catch { /* fall back below */ }
  const cwd = payload?.workspace?.current_dir || payload?.cwd || process.cwd();

  const res = await run('git', ['-C', cwd, 'rev-parse', '--abbrev-ref', 'HEAD']);
  if (!res.ok) return; // not a repo — print nothing
  const branch = res.stdout.trim();

  let situation = null;
  let pendingCount = 0;
  try {
    const s = await deriveSituation(cwd, { blocked: 0, inProgress: 0 });
    situation = s.key;
    pendingCount = s.pendingCount;
  } catch { /* glyph degrades to branch inference */ }

  const projectDir = payload?.workspace?.project_dir || payload?.workspace?.current_dir || cwd;
  const rateLimits = payload?.rate_limits || null;
  const costUsd = typeof payload?.cost?.total_cost_usd === 'number' ? payload.cost.total_cost_usd : null;
  process.stdout.write(composeLine({
    situation, pendingCount,
    project: String(projectDir).split(/[\\/]/).filter(Boolean).pop(),
    branch, ticket: parseBranch(branch).ticket,
    context: extractContext(payload),
    model: payload?.model?.display_name || null,
    effort: payload?.effort?.level || null,
    rateLimits,
    costUsd,
  }));

  // C8 (#79): opt-in quota capture — numeric-only, marker-gated, never breaks the strip.
  await appendQuotaSample(cwd, {
    fiveHour: rateLimits?.five_hour?.used_percentage,
    sevenDay: rateLimits?.seven_day?.used_percentage,
    cost: costUsd ?? undefined,
  }).catch(() => {});
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  try { await main(); } catch { /* silent by design */ }
  process.exit(0);
}
