#!/usr/bin/env node
/**
 * /forge:init --runner (ADR-0005 decisions 1/3/4, AC2/AC3): scaffold the local
 * self-hosted-runner assets into a PRIVATE repo — ephemeral Linux Dockerfile +
 * compose + JIT supervisor, the native-Windows host-runner setup, and a trimmed
 * verify.yml — then wire the secret-store guards into .gitignore + gitleaks.
 *
 * REFUSES on a public repo (the fork-PR RCE guard). Never writes the PAT: it
 * prints per-OS enable-time instructions for the out-of-band ~/.forge/runner.env
 * store instead. Placement is missing-only, never overwrite (matches deploy-init).
 */
import { readdir, readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import { join, dirname, resolve, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { run, makeGh } from '../lib/exec.mjs';
import { loadConfig } from '../lib/config.mjs';

const PLUGIN_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const DEFAULT_LABEL = 'forge-local';

// .gitignore lines that keep the PAT store out of git (ADR-0005 decision 1).
const GITIGNORE_ENTRIES = ['**/.forge/', 'runner.env', '*.runner.env'];
// gitleaks allowlist path regexes marking the same store as an intentional,
// out-of-band secret file (belt-and-suspenders alongside .gitignore).
const GITLEAKS_REGEXES = [
  String.raw`(^|/)\.forge/`,
  String.raw`(^|/)runner\.env$`,
  String.raw`(^|/)[^/]*\.runner\.env$`,
];

export function parseArgs(argv) {
  const a = { label: DEFAULT_LABEL };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--label') a.label = argv[++i];
    else if (argv[i] === '--runner') { /* mode flag consumed by init.mjs */ }
  }
  return a;
}

/** Scaffold file → destination in the consumer repo. */
function destFor(rel) {
  if (rel.startsWith('workflows/')) return join('.github', rel);
  return join('runner', rel);
}

async function* walk(dir, base = dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(p, base);
    else yield relative(base, p).replaceAll('\\', '/');
  }
}

/** Idempotently ensure the gitleaks allowlist marks the runner.env store. */
export function ensureGitleaksAllowlist(content, regexes = GITLEAKS_REGEXES) {
  const missing = regexes.filter((r) => !content.includes(`'''${r}'''`));
  if (missing.length === 0) return { changed: false, content };
  const block = missing.map((r) => `  '''${r}''', # forge runner: out-of-band PAT store (never a real leak)`);
  const lines = content.split(/\r?\n/);
  const anchor = lines.findIndex((l) => /^\s*paths\s*=\s*\[/.test(l));
  if (anchor !== -1) {
    const line = lines[anchor];
    const openIdx = line.indexOf('[');
    const closeIdx = line.indexOf(']', openIdx);
    if (closeIdx !== -1) {
      // Single-line array `paths = [ … ]`: rewrite to multi-line so the new
      // entries land INSIDE the array (splicing after the line would put bare
      // strings outside the array — invalid TOML). Preserve existing entries.
      const prefix = line.slice(0, openIdx); // e.g. "paths = "
      const innerRaw = line.slice(openIdx + 1, closeIdx).trim().replace(/,\s*$/, '');
      const suffix = line.slice(closeIdx + 1);
      const kept = innerRaw ? [`  ${innerRaw},`] : [];
      lines.splice(anchor, 1, `${prefix}[`, ...kept, ...block, `]${suffix}`);
    } else {
      // Multi-line array: insert right after the `paths = [` line.
      lines.splice(anchor + 1, 0, ...block);
    }
    return { changed: true, content: lines.join('\n') };
  }
  // No paths array — append a scoped allowlist section.
  const appended = `${content.trimEnd()}\n\n[allowlist]\ndescription = "forge runner PAT store — out-of-band, never committed"\npaths = [\n${block.join('\n')}\n]\n`;
  return { changed: true, content: appended };
}

export async function runRunnerInit(ctx, args = parseArgs([]), log = console.log) {
  const { cwd, gh } = ctx;

  // AC2 — private-only refusal (fork-PR RCE guard). One repo-view call for
  // visibility + owner/name, resolved FIRST, before any asset is written, so a
  // public repo never gets runner wiring.
  const view = await gh(['repo', 'view', '--json', 'isPrivate,owner,name'], { parseJson: true });
  if (!view.ok) return { ok: false, error: `could not determine repo visibility (${view.stderr || 'gh repo view failed'})` };
  if (view.json?.isPrivate !== true) {
    return {
      ok: false,
      error: 'refusing to scaffold a self-hosted runner on a PUBLIC repo — forks can run untrusted code on your machine (GitHub fork-PR RCE). Runner support is private-repo only (ADR-0005).',
    };
  }
  const repo = { owner: view.json.owner?.login, name: view.json.name };
  if (!repo.owner || !repo.name) return { ok: false, error: 'could not read repo owner/name from gh repo view' };

  // verify command from forge.json when present; safe default otherwise.
  const cfg = await loadConfig(cwd);
  const verify = cfg.config?.conventions?.verify ?? 'pnpm verify';
  const label = args.label || DEFAULT_LABEL;

  const substitute = (text) => text
    .replaceAll('{{OWNER}}', repo.owner)
    .replaceAll('{{REPO}}', repo.name)
    .replaceAll('{{LABEL}}', label)
    .replaceAll('{{VERIFY}}', verify);

  const runnerTemplates = join(PLUGIN_ROOT, 'templates', 'runner');
  const CANONICAL_VERIFY = join('.github', 'workflows', 'verify.yml');
  const RUNNER_VARIANT = join('.github', 'workflows', 'verify.runner.yml');
  const RUNNER_VERIFY_MARKER = 'forge local self-hosted-runner CI';
  const placed = [];
  const skipped = [];
  const review = [];
  for await (const rel of walk(runnerTemplates)) {
    let destRel = destFor(rel);
    const body = substitute(await readFile(join(runnerTemplates, rel), 'utf8'));
    let isReview = false;
    // The trimmed verify.yml IS the repo's verify workflow — but never clobber a
    // user's existing one. If a verify.yml exists that we did NOT write (no forge
    // runner marker), drop the runner variant beside it as verify.runner.yml for
    // the operator to review + swap in. A verify.yml we already placed is ours,
    // so a re-run skips it idempotently rather than diverting.
    if (destRel === CANONICAL_VERIFY) {
      const existing = await readFile(join(cwd, destRel), 'utf8').catch(() => null);
      if (existing != null && !existing.includes(RUNNER_VERIFY_MARKER)) {
        destRel = RUNNER_VARIANT;
        isReview = true;
      }
    }
    const dest = join(cwd, destRel);
    try {
      await stat(dest);
      skipped.push(destRel);
      continue; // never overwrite (matches deploy-init)
    } catch { /* missing — place it */ }
    await mkdir(dirname(dest), { recursive: true });
    await writeFile(dest, body, 'utf8');
    placed.push(destRel);
    if (isReview) review.push(destRel);
  }

  // AC3 — .gitignore: keep the PAT store out of git.
  const giPath = join(cwd, '.gitignore');
  let gi = '';
  try { gi = await readFile(giPath, 'utf8'); } catch { /* none yet */ }
  const giLines = gi.split(/\r?\n/).map((l) => l.trim());
  const giAdds = GITIGNORE_ENTRIES.filter((e) => {
    if (giLines.includes(e)) return false;
    // `.forge/` (written by plain forge:init) already ignores .forge at any depth,
    // so don't add a redundant `**/.forge/` line when it's present.
    if (e === '**/.forge/' && giLines.includes('.forge/')) return false;
    return true;
  });
  if (giAdds.length) {
    await writeFile(giPath, gi.trimEnd() + (gi.trim() ? '\n' : '') + giAdds.join('\n') + '\n', 'utf8');
    log(`.gitignore: added ${giAdds.join(', ')}`);
  }

  // AC3 — gitleaks allowlist context (only when the repo uses gitleaks).
  const glPath = join(cwd, '.gitleaks.toml');
  try {
    const gl = await readFile(glPath, 'utf8');
    const next = ensureGitleaksAllowlist(gl);
    if (next.changed) {
      await writeFile(glPath, next.content, 'utf8');
      log('.gitleaks.toml: allowlisted the runner.env store paths');
    }
  } catch {
    log('.gitleaks.toml: not found — skipped (the .gitignore entries are the primary guard)');
  }

  for (const p of placed) log(`placed: ${p}`);
  for (const s of skipped) log(`kept existing: ${s}`);
  for (const r of review) log(`REVIEW: ${r} (an existing verify.yml was kept — compare and swap in the runner variant to move CI onto the local runner)`);

  // AC3 — print the enable-time secret setup; NEVER write the secret itself.
  log('');
  log('next (owner steps — the secret is set up BY YOU, never by forge, ADR-0005 decision 1):');
  log('  the one secret = a fine-grained PAT with ONLY "Administration: read & write", scoped to THIS private repo.');
  log('  it lives out-of-band in ~/.forge/runner.env (gitignored, chmod 600) — never forge.json, a Docker secret, setx /M, or a shell global.');
  log('');
  log('  Linux / WSL2 (containerized runner):');
  log('    mkdir -p ~/.forge && chmod 700 ~/.forge');
  log('    printf "FORGE_RUNNER_PAT=<token>\\n" > ~/.forge/runner.env && chmod 600 ~/.forge/runner.env');
  log('    register a systemd service with EnvironmentFile=%h/.forge/runner.env running runner/linux/supervisor.mjs');
  log('');
  log('  Windows (native host runner — default when a Windows box is present):');
  log('    cd runner/windows; .\\setup-runner.ps1 -Install');
  log('    register a service (e.g. NSSM) running .\\setup-runner.ps1 -Serve with AppEnvironmentExtra=FORGE_RUNNER_PAT=<token>');
  log('    (route verify.yml Windows leg to the native runner by setting runs-on: [self-hosted, windows, ' + label + '])');
  log('');
  log('  full instructions: runner/README.md');

  return { ok: true, placed, skipped, review };
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  const gh = makeGh(run);
  runRunnerInit({ gh, cwd: process.cwd() }, parseArgs(process.argv.slice(2))).then((res) => {
    if (!res.ok) { console.error(`init --runner failed: ${res.error}`); process.exit(1); }
  }).catch((err) => { console.error(`init --runner failed: ${err.message}`); process.exit(1); });
}
