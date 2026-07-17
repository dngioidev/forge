#!/usr/bin/env node
/**
 * forge:maintain mechanics (spec §4 item 9; SP11) — the cms #70 lesson as
 * platform law: dependencies are batched routine work, not a PR queue.
 *
 *   maintain.mjs plan [--json]     outdated scan -> batch plan + majors list
 *   maintain.mjs advisories        dependabot alerts -> SLA-stamped triage lines
 *
 * npm-family repos only (package.json); other ecosystems get a teaching error —
 * the adapter pattern (deploy stacks, graph TS-only) applies when needed.
 */
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { run, makeGh } from '../lib/exec.mjs';

export function parseSemver(v) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(v ?? '');
  return m ? { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) } : null;
}

/** patch | minor | major | null (current, downgrade, or unparseable). */
export function classifyBump(current, latest) {
  const c = parseSemver(current);
  const l = parseSemver(latest);
  if (!c || !l) return null;
  if (l.major > c.major) return 'major';
  if (l.major === c.major && l.minor > c.minor) return 'minor';
  if (l.major === c.major && l.minor === c.minor && l.patch > c.patch) return 'patch';
  return null;
}

export async function scanOutdated(cwd, fetchFn = globalThis.fetch) {
  let pkg;
  try {
    pkg = JSON.parse(await readFile(join(cwd, 'package.json'), 'utf8'));
  } catch {
    return { ok: false, error: 'no package.json — forge:maintain covers npm-family repos; other ecosystems arrive as adapters when an owner repo needs one (spec §4 item 9)' };
  }
  const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
  const results = [];
  for (const [name, range] of Object.entries(deps)) {
    const current = range.replace(/^[~^><=\s]+/, '');
    try {
      const res = await fetchFn(`https://registry.npmjs.org/${encodeURIComponent(name)}/latest`);
      if (!res.ok) { results.push({ name, current, latest: null, bump: null, note: `registry ${res.status}` }); continue; }
      const latest = (await res.json()).version ?? null;
      results.push({ name, current, latest, bump: classifyBump(current, latest) });
    } catch (e) {
      results.push({ name, current, latest: null, bump: null, note: e.message });
    }
  }
  return { ok: true, results };
}

/** The law, mechanically: patch+minor -> ONE batch; majors -> ONE coordinated ticket, never the batch. */
export function planBatch(results, date) {
  const batch = results.filter((r) => r.bump === 'patch' || r.bump === 'minor');
  const majors = results.filter((r) => r.bump === 'major');
  return {
    batch: {
      branch: `chore/dep-batch-${date}`,
      bumps: batch.map((r) => ({ name: r.name, from: r.current, to: r.latest, bump: r.bump })),
      ritual: 'one branch, all bumps, verify green, one PR through the normal ship gates',
    },
    majors: {
      bumps: majors.map((r) => ({ name: r.name, from: r.current, to: r.latest, changelog: `https://www.npmjs.com/package/${r.name}?activeTab=versions` })),
      ritual: majors.length ? 'ONE coordinated upgrade ticket via forge:triage — majors are never merged individually (spec §4 item 9)' : null,
    },
    current: results.filter((r) => r.bump === null && !r.note).length,
    unresolvable: results.filter((r) => r.note).map((r) => ({ name: r.name, note: r.note })),
  };
}

export function renderPlan(plan) {
  const lines = [];
  if (plan.batch.bumps.length) {
    lines.push(`## Batch (${plan.batch.bumps.length}) → ${plan.batch.branch}`);
    for (const b of plan.batch.bumps) lines.push(`- ${b.name} ${b.from} → ${b.to} (${b.bump})`);
    lines.push(plan.batch.ritual, '');
  }
  if (plan.majors.bumps.length) {
    lines.push(`## Majors (${plan.majors.bumps.length}) — one coordinated ticket`);
    for (const m of plan.majors.bumps) lines.push(`- ${m.name} ${m.from} → ${m.to} — ${m.changelog}`);
    lines.push(plan.majors.ritual, '');
  }
  if (!plan.batch.bumps.length && !plan.majors.bumps.length) lines.push('everything current — nothing to maintain');
  else lines.push(`${plan.current} package(s) already current`);
  if (plan.unresolvable.length) lines.push(`unresolvable: ${plan.unresolvable.map((u) => u.name).join(', ')}`);
  return lines.join('\n');
}

export const SLA_HOURS = { critical: 24, high: 72, medium: 168, low: null };
const rank = (sev) => ['critical', 'high', 'medium', 'low'].indexOf(sev) + 1 || 5;

export function triageAlerts(alerts, now = Date.now()) {
  return alerts
    .filter((a) => a.state === 'open')
    .map((a) => {
      const sev = a.security_advisory?.severity ?? 'low';
      const hours = SLA_HOURS[sev] ?? null;
      const deadline = hours ? new Date(Date.parse(a.created_at) + hours * 3_600_000).toISOString() : null;
      const overdue = deadline ? Date.parse(deadline) < now : false;
      return {
        number: a.number,
        pkg: a.dependency?.package?.name ?? 'unknown',
        severity: sev,
        summary: a.security_advisory?.summary ?? '',
        deadline,
        overdue,
        sla: hours ? `${hours}h` : 'next maintain run',
      };
    })
    .sort((x, y) => (y.overdue - x.overdue) || (rank(x.severity) - rank(y.severity)));
}

export async function fetchAlerts(gh, owner, repo) {
  const res = await gh(['api', `repos/${owner}/${repo}/dependabot/alerts?state=open&per_page=100`], { parseJson: true });
  if (!res.ok) {
    if (/dependabot alerts are disabled|403|404/i.test(res.stderr)) {
      return { ok: false, disabled: true, error: 'Dependabot alerts are not enabled — turn them on in repo Settings → Code security (spec §4 item 9 needs the feed); scan still possible via `npm audit` manually' };
    }
    return { ok: false, error: res.stderr || 'alerts query failed' };
  }
  return { ok: true, alerts: res.json };
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  const cmd = process.argv[2];
  const cwd = process.cwd();
  const fail = (msg) => { console.error(msg); process.exit(1); };
  if (cmd === 'plan') {
    scanOutdated(cwd).then((res) => {
      if (!res.ok) fail(res.error);
      const plan = planBatch(res.results, new Date().toISOString().slice(0, 10));
      console.log(process.argv.includes('--json') ? JSON.stringify(plan, null, 2) : renderPlan(plan));
    });
  } else if (cmd === 'advisories') {
    const gh = makeGh(run);
    import('../lib/board.mjs').then(async ({ getRepoInfo }) => {
      const repo = await getRepoInfo(gh);
      if (!repo.ok) fail(repo.error);
      const res = await fetchAlerts(gh, repo.owner, repo.name);
      if (!res.ok) fail(res.error);
      const triaged = triageAlerts(res.alerts);
      if (triaged.length === 0) { console.log('no open advisories'); return; }
      for (const t of triaged) {
        console.log(`${t.overdue ? '⏰ OVERDUE' : '·'} [${t.severity}] ${t.pkg} — ${t.summary} (alert #${t.number}, SLA ${t.sla}${t.deadline ? `, due ${t.deadline}` : ''})`);
      }
    });
  } else {
    fail('usage: maintain.mjs <plan [--json]|advisories>');
  }
}
