#!/usr/bin/env node
/**
 * /forge:init — adopt-or-create bootstrap (spec §6, plan T5).
 * Every step is detect-before-create: re-runs resume/refresh, never duplicate.
 */
import { readFile, writeFile, readdir, mkdir } from 'node:fs/promises';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { run, makeGh } from './lib/exec.mjs';
import { loadConfig, CONFIG_RELPATH } from './lib/config.mjs';
import { mergeJson } from './lib/jsonfile.mjs';
import {
  STANDARD_STATUS, STANDARD_FIELDS, getRepoInfo, getProject, createProject,
  getProjectFields, createSingleSelectField, replaceStatusOptions,
  findIssueByTitle, createIssue, toConfigField,
} from './lib/board.mjs';
import { runDoctor } from './doctor.mjs';
import { parseBackendId } from './backends/loader.mjs';
import { ADAPTERS } from './backends/agy.mjs';

const DELIVERY_LOG_TITLE = 'Delivery log';

export function parseArgs(argv) {
  const args = { project: null, createProject: null, statusline: false, skipDoctor: false, roster: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--project') args.project = Number(argv[++i]);
    else if (a === '--create-project') args.createProject = argv[++i];
    else if (a === '--statusline') args.statusline = true;
    else if (a === '--skip-doctor') args.skipDoctor = true;
    else if (a === '--roster') args.roster = argv[++i];
  }
  return args;
}

/**
 * Scaffold a roster for the swappable search roles (spec §5): investigator +
 * librarian, the two that default to Claude and gain most from a cheap CLI
 * backend. second-opinion keeps its own default. Pinned/gate roles are never
 * scaffolded — they can't leave Claude by law.
 */
export function scaffoldRoster(backendId) {
  return { investigator: { backend: backendId }, librarian: { backend: backendId } };
}

export async function runInit(ctx) {
  const { gh, cwd, log, args } = ctx;
  const actions = [];
  const say = (m) => { actions.push(m); log(m); };

  // 1. Preflight
  const auth = await gh(['auth', 'status']);
  if (!auth.ok) return { ok: false, error: 'gh is not authenticated — run: gh auth login -s project', actions };
  const [maj, min] = process.versions.node.split('.').map(Number);
  if (maj < 22 || (maj === 22 && min < 13)) {
    return { ok: false, error: `Node ${process.versions.node} < 22.13 (needed for node:sqlite later; upgrade now to avoid surprises)`, actions };
  }
  const repo = await getRepoInfo(gh);
  if (!repo.ok) return { ok: false, error: `not a GitHub repo context: ${repo.error}`, actions };

  // 2. Mode
  const existing = await loadConfig(cwd);
  const adopt = !existing.missing;
  say(adopt ? `adopt mode: refreshing existing ${CONFIG_RELPATH}` : 'fresh mode: no forge.json yet');

  // 3. Project
  let project;
  const wantedNumber = args.project ?? existing.config?.board?.projectNumber ?? null;
  if (wantedNumber != null) {
    const p = await getProject(gh, repo.owner, wantedNumber);
    if (!p.ok) return { ok: false, error: p.error, actions };
    project = p;
    say(`project: using #${p.number} "${p.title}"`);
  } else if (args.createProject != null) {
    const title = args.createProject || repo.name;
    const p = await createProject(gh, repo.owner, title);
    if (!p.ok) return { ok: false, error: p.error, actions };
    project = p;
    say(`project: created #${p.number} "${p.title}"`);
  } else {
    return { ok: false, error: 'no project specified — pass --project <number> or --create-project "<title>"', actions };
  }

  // 4. Fields
  let pf = await getProjectFields(gh, project.id);
  if (!pf.ok) return { ok: false, error: pf.error, actions };

  const statusField = pf.fields['status'];
  if (!statusField) return { ok: false, error: 'project has no Status field — unexpected for ProjectsV2', actions };
  const statusNames = (statusField.options ?? []).map((o) => o.name);
  const missingStatuses = STANDARD_STATUS.filter((s) => !statusNames.some((n) => n.toLowerCase() === s.name.toLowerCase()));
  if (missingStatuses.length > 0) {
    if (pf.itemsCount === 0) {
      // ADR-0001: replacement is safe only on empty projects
      const r = await replaceStatusOptions(gh, statusField.id, STANDARD_STATUS);
      if (!r.ok) return { ok: false, error: r.error, actions };
      say(`status: replaced options with forge standard set (project empty — ADR-0001)`);
    } else {
      say(`status: mapping existing options as-is; missing from standard set: ${missingStatuses.map((s) => s.name).join(', ')} (add via UI if wanted — ADR-0001 forbids replacing options on live boards)`);
    }
  } else {
    say('status: standard set already present');
  }

  for (const [key, defs] of Object.entries(STANDARD_FIELDS)) {
    if (!pf.fields[key]) {
      const r = await createSingleSelectField(gh, project.id, key[0].toUpperCase() + key.slice(1), defs);
      if (!r.ok) return { ok: false, error: r.error, actions };
      say(`fields: created ${key}`);
    }
  }

  // Re-discover so config reflects reality (also covers resume-after-partial-failure)
  pf = await getProjectFields(gh, project.id);
  if (!pf.ok) return { ok: false, error: pf.error, actions };

  // 5. Delivery log issue
  let deliveryLogIssue = existing.config?.board?.deliveryLogIssue ?? null;
  if (deliveryLogIssue == null) {
    const found = await findIssueByTitle(gh, DELIVERY_LOG_TITLE);
    if (!found.ok) return { ok: false, error: found.error, actions };
    if (found.issue) {
      deliveryLogIssue = found.issue.number;
      say(`delivery log: found existing #${deliveryLogIssue}`);
    } else {
      const created = await createIssue(gh, DELIVERY_LOG_TITLE, 'Pinned delivery log — one row per merged change. Managed by forge (spec §6).');
      if (!created.ok) return { ok: false, error: created.error, actions };
      deliveryLogIssue = created.number;
      say(`delivery log: created #${deliveryLogIssue}`);
    }
  }

  // 6. Write forge.json (merge — never clobber consumer customizations)
  const board = {
    projectNumber: project.number,
    projectId: project.id,
    fields: {
      status: toConfigField(pf.fields['status']),
      priority: toConfigField(pf.fields['priority']),
      size: toConfigField(pf.fields['size']),
      type: toConfigField(pf.fields['type']),
    },
    ...(deliveryLogIssue != null ? { deliveryLogIssue } : {}),
  };
  const defaults = adopt ? {} : {
    conventions: { verify: 'pnpm verify', commitFormat: 'conventional+issue-ref', specsDir: 'docs/specs', plansDir: 'docs/plans' },
    features: { graph: false, designReview: false, deploy: false, e2e: false },
    design: { source: 'code' },
    team: {
      members: [{ github: repo.owner, roles: ['maintainer'] }],
      policy: {
        approvals: { spec: ['maintainer'], merge: ['maintainer'], distill: ['maintainer'], deploy: ['maintainer'], escalation: { default: ['maintainer'] } },
        assignment: 'manual',
      },
    },
  };
  // 6b. Roster scaffold (opt-in via --roster; init.md asks). mergeJson is
  // no-clobber, so an existing roster (adopt mode) always survives.
  let roster;
  if (args.roster) {
    const parsed = parseBackendId(args.roster);
    if (!parsed) {
      say(`roster: skipped — '${args.roster}' is not a valid backend id (expected <runtime>[:<model>])`);
    } else {
      roster = scaffoldRoster(args.roster);
      say(`roster: scaffolded investigator + librarian → ${args.roster}`);
      if (parsed.runtime !== 'claude' && !ADAPTERS[parsed.runtime]) {
        say(`roster: ⚠ runtime '${parsed.runtime}' has no shipped adapter yet — the role falls back to Claude until one exists (agy is the shipped CLI backend)`);
      } else if (parsed.runtime !== 'claude') {
        say(`roster: run /forge:backends-sync to generate the CLI context + ignore files`);
      }
    }
  }

  await mergeJson(join(cwd, CONFIG_RELPATH), { ...defaults, ...(roster ? { roster } : {}), board });
  say(`config: wrote ${CONFIG_RELPATH}`);

  // 7. .gitignore
  const giPath = join(cwd, '.gitignore');
  let gi = '';
  try { gi = await readFile(giPath, 'utf8'); } catch { /* no .gitignore yet */ }
  if (!gi.split(/\r?\n/).some((l) => l.trim() === '.forge/')) {
    await writeFile(giPath, gi + (gi.endsWith('\n') || gi === '' ? '' : '\n') + '.forge/\n', 'utf8');
    say('.gitignore: added .forge/');
  }

  // 7b. Consumer CI template (spec §6; lands with SP3): install when missing
  const wfDir = join(cwd, '.github', 'workflows');
  let hasVerify = false;
  try {
    for (const f of await readdir(wfDir)) {
      if (/\.ya?ml$/.test(f) && /^name:\s*verify\b/m.test(await readFile(join(wfDir, f), 'utf8'))) { hasVerify = true; break; }
    }
  } catch { /* no workflows dir yet */ }
  if (!hasVerify) {
    try {
      const templatePath = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'templates', 'verify.yml');
      const verifyCmd = existing.config?.conventions?.verify ?? defaults.conventions?.verify ?? 'pnpm verify';
      const tpl = (await readFile(templatePath, 'utf8')).replaceAll('{{VERIFY}}', verifyCmd);
      await mkdir(wfDir, { recursive: true });
      await writeFile(join(wfDir, 'verify.yml'), tpl, 'utf8');
      say('ci: installed verify workflow template (.github/workflows/verify.yml)');
    } catch (err) {
      say(`ci: template install skipped (${err.message})`);
    }
  }

  // 8. Status line (opt-in via --statusline; the command md asks the user first).
  // Written to settings.local.json: the command embeds a machine-specific
  // absolute path, which must never land in the shared committed settings.
  if (args.statusline) {
    const scriptPath = resolve(dirname(fileURLToPath(import.meta.url)), 'statusline.mjs');
    await mergeJson(join(cwd, '.claude', 'settings.local.json'), {
      statusLine: { type: 'command', command: `node "${scriptPath}"` },
    });
    say('statusline: wired into .claude/settings.local.json');
  }

  // 9. Doctor
  let doctor = null;
  if (!args.skipDoctor) {
    doctor = await runDoctor({ gh, cwd, log });
  }
  return { ok: true, actions, board, doctor };
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  const ctx = { gh: makeGh(run), cwd: process.cwd(), log: console.log, args: parseArgs(process.argv.slice(2)) };
  runInit(ctx).then((res) => {
    if (!res.ok) { console.error(`init failed: ${res.error}`); process.exit(1); }
    process.exit(res.doctor && !res.doctor.ok ? 1 : 0);
  });
}
