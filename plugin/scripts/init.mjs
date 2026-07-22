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
  STANDARD_STATUS, STANDARD_FIELDS, getRepoInfo, getProject, createProject, linkProject,
  getProjectFields, createSingleSelectField, replaceStatusOptions,
  findIssueByTitle, createIssue, toConfigField,
} from './lib/board.mjs';
import { runDoctor } from './doctor.mjs';

const DELIVERY_LOG_TITLE = 'Delivery log';

export function parseArgs(argv) {
  const args = { project: null, createProject: null, statusline: false, skipDoctor: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--project') args.project = Number(argv[++i]);
    else if (a === '--create-project') args.createProject = argv[++i];
    else if (a === '--statusline') args.statusline = true;
    else if (a === '--skip-doctor') args.skipDoctor = true;
  }
  return args;
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
    // #64: a freshly created board is owner-scoped and NOT repo-linked — link it so it
    // shows in the repo Projects tab. A link failure is a warning, not a fatal init error.
    const slug = `${repo.owner}/${repo.name}`;
    const link = await linkProject(gh, repo.owner, p.number, slug);
    if (link.ok) say(link.linked ? `project: linked #${p.number} to ${slug}` : `project: already linked to ${slug}`);
    else say(`project: WARNING could not link #${p.number} to ${slug} (${link.error}) — link manually: gh project link ${p.number} --owner ${repo.owner} --repo ${slug}`);
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
  const fields = {
    status: toConfigField(pf.fields['status']),
    priority: toConfigField(pf.fields['priority']),
    size: toConfigField(pf.fields['size']),
    type: toConfigField(pf.fields['type']),
  };
  // #114: map an optional consumer-defined Phase single-select when present
  // (forge never creates it — it's opt-in roadmap tracking).
  if (pf.fields['phase']) {
    fields.phase = toConfigField(pf.fields['phase']);
    say('fields: mapped optional Phase field');
  }
  // #146: map an optional consumer-defined Area single-select when present, so
  // create --area and autopilot --area work. Areas are the consumer's own
  // (frontend/api/…), so forge maps but never invents them.
  if (pf.fields['area']) {
    fields.area = toConfigField(pf.fields['area']);
    say('fields: mapped optional Area field');
  }
  const board = {
    projectNumber: project.number,
    projectId: project.id,
    fields,
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
  await mergeJson(join(cwd, CONFIG_RELPATH), { ...defaults, board });
  say(`config: wrote ${CONFIG_RELPATH}`);

  // 7. .gitignore
  const giPath = join(cwd, '.gitignore');
  let gi = '';
  try { gi = await readFile(giPath, 'utf8'); } catch { /* no .gitignore yet */ }
  if (!gi.split(/\r?\n/).some((l) => l.trim() === '.forge/')) {
    await writeFile(giPath, gi + (gi.endsWith('\n') || gi === '' ? '' : '\n') + '.forge/\n', 'utf8');
    say('.gitignore: added .forge/');
  }

  // 7b. .gitattributes — normalize line endings to LF (#109). On Windows, CRLF
  // causes git "LF will be replaced by CRLF" churn and breaks tests that compare
  // generated files byte-for-byte. No-clobber: only added when absent.
  const gaPath = join(cwd, '.gitattributes');
  let ga = '';
  try { ga = await readFile(gaPath, 'utf8'); } catch { /* no .gitattributes yet */ }
  if (!ga.split(/\r?\n/).some((l) => l.trim().startsWith('* text'))) {
    const rule = '# forge: normalize line endings to LF (avoids CRLF churn + generated-file test breakage)\n* text=auto eol=lf\n';
    await writeFile(gaPath, ga + (ga.endsWith('\n') || ga === '' ? '' : '\n') + rule, 'utf8');
    say('.gitattributes: added LF normalization (* text=auto eol=lf)');
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
  //
  // #181: wire the ABSOLUTE node binary (process.execPath), not a bare `node`.
  // Claude Code spawns the status-line command in a process that may not have
  // `node` on PATH (e.g. node installed to %LOCALAPPDATA%\node22\current) — a
  // bare `node` then dies with exit 127 and the bar renders silently blank.
  // process.execPath is the node currently running init: the portable, absolute
  // source. Both it and scriptPath are quoted to tolerate spaces in the paths.
  if (args.statusline) {
    const scriptPath = resolve(dirname(fileURLToPath(import.meta.url)), 'statusline.mjs');
    await mergeJson(join(cwd, '.claude', 'settings.local.json'), {
      statusLine: { type: 'command', command: `"${process.execPath}" "${scriptPath}"` },
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
  }).catch((err) => { console.error(`init failed: ${err.message}`); process.exit(1); });
}
