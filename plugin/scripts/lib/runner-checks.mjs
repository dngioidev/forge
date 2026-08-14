/**
 * Shared local self-hosted-runner checks (ADR-0005). Single source of truth for
 * the runner-health building blocks used by BOTH `forge:doctor` (the one-line
 * runner-health summary, #225/#233) and `forge:runner-check` (the end-to-end
 * adoption-readiness preflight, #245) — so the private-repo guard, the runner
 * registration probe, the secret-store assertion, and the version-staleness check
 * live in exactly one place rather than being copy-pasted between commands.
 *
 * Every function is argv-only (no shell), degrades to a warn (never a crash) when
 * a gh/git call fails, and NEVER echoes a discovered secret's value.
 */
import { join } from 'node:path';
import { readFile, readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { run } from './exec.mjs';
import { fetchRunnerPin, parsePinnedVersion, compareVersions } from './runner-release.mjs';

// Result constructors — one shape shared by every check ({name, level, msg, hint?}).
export const ok = (name, msg) => ({ name, level: 'ok', msg });
export const warn = (name, msg, hint) => ({ name, level: 'warn', msg, hint });
export const fail = (name, msg, hint) => ({ name, level: 'fail', msg, hint });
export const skip = (name, msg) => ({ name, level: 'skip', msg }); // not applicable — never a failure (#89)

export const firstLine = (s) => String(s ?? '').split(/\r?\n/).find((l) => l.trim()) ?? '';

// PAT shapes for the secret-store scan (ADR-0005 decision 1): classic gh{p,o,s,u}_
// + 36 chars, and fine-grained github_pat_ tokens. Assembled from parts so this
// literal never itself matches (no self-flagging in a git grep).
export const RUNNER_PAT_RE = ['gh', '[opsu]_', '[A-Za-z0-9]{36}', '|', 'github', '_pat_', '[A-Za-z0-9_]{22,}'].join('');

/**
 * Resolve repo visibility + owner/name in one `gh repo view` call. Returns
 * `{ ok:false, stderr }` when gh fails (caller degrades to a warn), else
 * `{ ok:true, isPrivate, owner, name }`.
 */
export async function fetchRepoVisibility(gh) {
  const view = await gh(['repo', 'view', '--json', 'isPrivate,owner,name'], { parseJson: true });
  if (!view.ok) return { ok: false, stderr: firstLine(view.stderr) || 'gh repo view failed' };
  return {
    ok: true,
    isPrivate: view.json?.isPrivate === true,
    owner: view.json?.owner?.login,
    name: view.json?.name,
  };
}

/**
 * The registration + online probe (ADR-0005 decision 3 label routing). Queries the
 * repo runners endpoint by default, the org endpoint when `runner.sharing==='org'`
 * (decision 2), and matches the configured `labels` case-insensitively (GitHub does
 * too). per_page=100 so a box with many registrations isn't truncated to a false
 * "not registered". Returns a single result object with the given `checkName`.
 *
 * `labels` overrides `runner.labels` (the Windows leg passes its windows label set
 * when `runner.windows==='native'`). `offlineLevel` sets the severity when the API
 * responds but no matching runner is online — 'warn' for doctor's advisory health
 * line, 'fail' for the adoption-readiness gate (#245). A gh-api FAILURE always
 * degrades to a warn regardless (graceful degradation, never a hard fail on a
 * transient gh/scope error).
 */
export async function probeRunnerOnline({ gh, owner, name, runner, checkName = 'runner', labels = runner.labels, legNote = '', offlineLevel = 'warn' }) {
  const notReady = offlineLevel === 'fail' ? fail : warn;
  const isOrg = runner.sharing === 'org';
  const base = isOrg ? `orgs/${owner}/actions/runners` : `repos/${owner}/${name}/actions/runners`;
  const api = await gh(['api', `${base}?per_page=100`], { parseJson: true });
  const wanted = labels.map((l) => l.toLowerCase());
  const suffix = legNote ? ` ${legNote}` : '';
  if (!api.ok) {
    return warn(checkName, `could not query ${isOrg ? 'org' : 'repo'} runners${suffix} (${firstLine(api.stderr) || 'gh api failed'})`, "grant the token repo/admin:org scope, or confirm the runner is registered");
  }
  const list = Array.isArray(api.json?.runners) ? api.json.runners : [];
  const labelNames = (r) => new Set((r.labels ?? []).map((l) => (typeof l === 'string' ? l : l?.name)).filter(Boolean).map((s) => s.toLowerCase()));
  const matches = list.filter((r) => { const ns = labelNames(r); return wanted.every((w) => ns.has(w)); });
  if (matches.length === 0) {
    return notReady(checkName, `no self-hosted runner registered with labels [${labels.join(', ')}]${suffix}`, 'register the local runner (/forge:init --runner, then the printed enable steps)');
  }
  if (matches.some((r) => r.status === 'online')) {
    const online = matches.filter((r) => r.status === 'online').length;
    return ok(checkName, `registered + online (${online}/${matches.length} matching runner${matches.length === 1 ? '' : 's'} online)${suffix}`);
  }
  return notReady(checkName, `runner registered but offline (labels [${labels.join(', ')}])${suffix}`, 'start the runner service on the host');
}

/**
 * Windows-leg label set for a native Windows runner: the configured labels with
 * `linux` swapped for `windows` (a native Windows runner registers with the windows
 * label, not linux). Idempotent when no `linux` label is present.
 */
export function windowsLabels(labels) {
  const out = labels.map((l) => (l.toLowerCase() === 'linux' ? 'windows' : l));
  if (!out.some((l) => l.toLowerCase() === 'windows')) out.push('windows');
  return out;
}

/**
 * Secret-store assertion (ADR-0005 decision 1): the ~/.forge/runner.env PAT store
 * must be gitignored + untracked, and no PAT may sit in a committed file. gh-free
 * (git-only) so it runs regardless of the registration probe's outcome. All calls
 * are argv-only; a non-git cwd simply degrades to a warn, never a throw. Only file
 * NAMES are ever surfaced — a discovered secret's value is never echoed. Returns a
 * single result object with the given `checkName` (doctor uses 'runner-secret').
 */
export async function checkRunnerSecretStore({ cwd, checkName = 'runner-secret' }) {
  const trackedRes = await run('git', ['-C', cwd, 'ls-files']);
  const tracked = (trackedRes.stdout || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const storeTracked = tracked.filter((p) => /(^|\/)runner\.env$/.test(p) || /(^|\/)[^/]*\.runner\.env$/.test(p) || /(^|\/)\.forge\//.test(p));
  const grep = await run('git', ['-C', cwd, 'grep', '-I', '-l', '-E', RUNNER_PAT_RE]);
  // git grep: exit 0 = matches, 1 = clean (no match), anything else = real error.
  const patHits = grep.code === 0 ? (grep.stdout || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean) : [];
  const ignored = await run('git', ['-C', cwd, 'check-ignore', '-q', 'runner.env']);

  if (storeTracked.length) {
    return fail(checkName, `runner secret store is tracked in git: ${storeTracked.slice(0, 3).join(', ')}`, 'git rm --cached it; the PAT belongs only in ~/.forge/runner.env (ADR-0005 decision 1)');
  }
  if (patHits.length) {
    return fail(checkName, `PAT-looking secret found in committed file(s): ${patHits.slice(0, 3).join(', ')}`, 'rotate the token and purge it from git history (never commit a PAT)');
  }
  if (!ignored.ok) {
    return warn(checkName, 'runner.env is not gitignored', 'add runner.env / **/.forge/ to .gitignore (/forge:init --runner does this)');
  }
  return ok(checkName, 'runner.env gitignored + untracked; no PAT in committed files');
}

/**
 * Repo-derived local runner service/unit name (#260): forge-runner-<owner>-<repo>,
 * each token sanitized to a valid service/unit name (lowercase, every run of
 * non-alphanumerics -> a single '-', edge dashes trimmed). Kept in lockstep with the
 * scaffold's ConvertTo-ServiceSlug / slugify so doctor can predict the default name.
 * A second repo derives a DISTINCT name, so its install can't clobber the first's.
 */
export function deriveServiceName(owner, repo) {
  const slug = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  const parts = ['forge-runner'];
  const o = slug(owner);
  const r = slug(repo);
  if (o) parts.push(o);
  if (r) parts.push(r);
  return parts.join('-');
}

/** Extract a service's resolved target (owner/repo) from a service-env blob. Only
 *  FORGE_RUNNER_OWNER/REPO are read; a PAT in the same blob is never surfaced. */
function extractServiceTarget(blob) {
  const s = String(blob ?? '');
  const owner = (s.match(/FORGE_RUNNER_OWNER=([^\s;"']+)/) || [])[1] || null;
  const repo = (s.match(/FORGE_RUNNER_REPO=([^\s;"']+)/) || [])[1] || null;
  return { owner, repo };
}

/**
 * Best-effort discovery of the local runner service(s) and their RESOLVED target
 * owner/repo (#260 AC5) — the signal that makes a mis-targeted, JIT-ephemeral runner
 * diagnosable (nothing shows at rest in the intended repo). Cross-platform-tolerant:
 *   - Windows: enumerate services named forge-runner* (`sc query`), then read each
 *     service's target from its NSSM AppEnvironmentExtra.
 *   - Linux: read forge-runner*.service units under the systemd --user dir and parse
 *     their Environment=.
 * Every call is argv-only; ANY failure (no sc/nssm, non-systemd host, unreadable
 * unit) degrades to []. Never throws, never echoes the PAT. `exec` is injectable so
 * doctor/runner-check (and tests) can drive it deterministically.
 */
export async function detectRunnerServices({ exec = run, platform = process.platform, home = homedir() } = {}) {
  try {
    if (platform === 'win32') {
      const q = await exec('sc', ['query', 'type=', 'service', 'state=', 'all']);
      if (!q.ok) return [];
      const names = String(q.stdout || '').split(/\r?\n/)
        .map((l) => (l.match(/^\s*SERVICE_NAME:\s*(\S+)/) || [])[1])
        .filter((n) => n && /^forge-runner/i.test(n));
      const out = [];
      for (const name of names) {
        const env = await exec('nssm', ['get', name, 'AppEnvironmentExtra']);
        out.push({ name, ...extractServiceTarget(env.ok ? env.stdout : '') });
      }
      return out;
    }
    const dir = join(home, '.config', 'systemd', 'user');
    let files;
    try { files = await readdir(dir); } catch { return []; }
    const out = [];
    for (const f of files) {
      if (!/^forge-runner.*\.service$/i.test(f)) continue;
      const blob = await readFile(join(dir, f), 'utf8').catch(() => '');
      out.push({ name: f.replace(/\.service$/i, ''), ...extractServiceTarget(blob) });
    }
    return out;
  } catch {
    return []; // diagnosis is strictly best-effort — never a crash
  }
}

/**
 * Turn detected runner service(s) into a result (#260 AC5). Surfaces each service's
 * RESOLVED owner/repo; and when a service is present but the CONFIGURED repo shows 0
 * online matching runners (`hasOnline` false), WARNS that the service may be targeting
 * a different repo — the symptom JIT-ephemeral otherwise hides. Returns [] when no
 * service is detected (silent skip). Pure given `services` (easy to unit-test).
 */
export function serviceTargetResults({ services, hasOnline, configuredOwner, configuredName, checkName = 'runner-service' }) {
  if (!Array.isArray(services) || services.length === 0) return [];
  const configured = configuredOwner && configuredName ? `${configuredOwner}/${configuredName}` : null;
  const targets = services.map((s) => (s.owner && s.repo ? `${s.owner}/${s.repo}` : `${s.name} (target unknown)`));
  if (hasOnline) {
    return [ok(checkName, `local runner service detected, targeting ${targets.join(', ')}`)];
  }
  return [warn(checkName,
    `a runner service is present (targeting ${targets.join(', ')}) but ${configured ?? 'this repo'} has 0 online matching runners - the service may be targeting a different repo (JIT-ephemeral hides this)`,
    configured ? `confirm the service targets ${configured}, or run /forge:init --runner and enable a repo-scoped service` : 'confirm the service targets this repo')];
}

/**
 * Fork-PR execution-surface check (#489 AC.2). A self-hosted runner registered
 * to a PUBLIC repo is a fork-PR code-execution surface: for `pull_request`
 * events GitHub runs the workflow definition from the merge commit, which
 * INCLUDES the fork's own changes, so a fork PR can target the runner's label
 * and execute attacker-authored code on the host — ephemerality (ADR-0005)
 * bounds credential lifetime and cross-job residue, it does not prevent that
 * execution. GitHub's own mitigation is the fork-PR workflow-approval policy
 * (`actions/permissions/fork-pr-contributor-approval`); only the strictest
 * value (`all_external_contributors`) closes the gap for every fork PR — the
 * `first_time_contributors*` values still let a contributor who already has
 * one approved PR push a later, unapproved malicious PR that runs unreviewed.
 *
 * Deliberately runs INDEPENDENT of this repo's own `runner.enabled` config —
 * the exposure is whatever is actually registered on GitHub right now, not
 * what forge.json currently says. That config/reality drift (a runner left
 * registered after `runner.enabled` was flipped off) is exactly what #489 was
 * filed over, so this check is NOT nested inside the `runner.enabled`-gated
 * block the other checks in this file share.
 *
 * Read-only: only ever calls GET endpoints, never writes/flips the policy —
 * changing repo-settings posture is the owner's call (#489), this is the
 * verification the owner's decision gets checked against. Never a false
 * green: a gh-api failure OR an unexpected/malformed response shape on
 * EITHER call degrades to `warn` naming the documented manual-verification
 * fallback (Settings → Actions → General → "Fork pull request workflows
 * from outside collaborators") and #490 (which owns the general
 * live-registration reconciliation this assertion rides on) — it never
 * silently reports `ok` when the live state couldn't be confidently read.
 *
 * Scope note: only queries the REPO-scoped runners endpoint
 * (`repos/{owner}/{repo}/actions/runners`), not an org-level one — an
 * org-shared runner group (a mode `probeRunnerOnline` above DOES model via
 * `runner.sharing==='org'`) would not appear here. Deliberately out of scope
 * for this repo-scoped check: a personal-account repo (this ticket's own
 * target) has no org to query in the first place, and reconciling org-level
 * sharing against a given repo's exposure is broader work that belongs to
 * #490, not this AC.2 slice. The `ok`/`fail` messages below say "registered
 * to this repo" rather than an unqualified "no exposure" for exactly this
 * reason — never overclaim coverage this check doesn't have.
 */
export async function checkForkPrExposure({ gh, owner, name, isPrivate, checkName = 'fork-pr-exposure' }) {
  if (isPrivate) return skip(checkName, 'private repo — no fork-PR execution surface for a self-hosted runner');

  const runnersRes = await gh(['api', `repos/${owner}/${name}/actions/runners?per_page=100`], { parseJson: true });
  if (!runnersRes.ok) {
    return warn(checkName,
      `public repo, but could not query registered self-hosted runners (${firstLine(runnersRes.stderr) || 'gh api failed'})`,
      'manually confirm via `gh api repos/<owner>/<repo>/actions/runners` that zero are registered, or grant the token repo scope (#490)');
  }
  if (!Array.isArray(runnersRes.json?.runners)) {
    return warn(checkName,
      'public repo, but the registered-runners API response had an unexpected shape (could not confirm zero are registered)',
      'manually confirm via `gh api repos/<owner>/<repo>/actions/runners` that zero are registered (#490)');
  }
  const runners = runnersRes.json.runners;
  if (runners.length === 0) {
    return ok(checkName, 'public repo, no self-hosted runners registered to this repo — no fork-PR execution surface via a repo-level registration');
  }
  const names = runners.map((r) => r.name).slice(0, 3).join(', ');

  const approvalRes = await gh(['api', `repos/${owner}/${name}/actions/permissions/fork-pr-contributor-approval`], { parseJson: true });
  if (!approvalRes.ok) {
    return warn(checkName,
      `public repo with ${runners.length} self-hosted runner(s) registered to this repo (${names}) and the fork-PR workflow-approval policy could not be read via the API (${firstLine(approvalRes.stderr) || 'gh api failed'})`,
      'manually verify Settings → Actions → General → "Fork pull request workflows from outside collaborators" requires approval for ALL outside collaborators while any self-hosted runner remains registered — #490 tracks reconciling this automatically');
  }
  const policy = approvalRes.json?.approval_policy;
  if (policy === 'all_external_contributors') {
    return ok(checkName, `public repo with ${runners.length} self-hosted runner(s) registered to this repo (${names}), but fork-PR workflows require approval for ALL external contributors — the execution surface is gated`);
  }
  return fail(checkName,
    `public repo with ${runners.length} self-hosted runner(s) registered to this repo (${names}) and the fork-PR approval policy is "${policy ?? 'unknown'}" — a contributor with one prior approved PR could push a later malicious PR that runs on this host WITHOUT approval`,
    'tighten Settings → Actions → General → "Fork pull request workflows from outside collaborators" to "Require approval for all outside collaborators", or remove the self-hosted runner registration(s) (#489/#490)');
}

/**
 * Runner staleness (#233): GitHub DEPRECATES old actions/runner versions and the
 * ephemeral/JIT runner can't auto-update, so a fixed pin silently stops receiving
 * jobs. Parse the scaffolded RUNNER_VERSION (Dockerfile, then setup-runner.ps1) and
 * WARN when it is behind the latest release. Returns null (a SILENT skip) when the
 * runner files are absent (nothing scaffolded yet) or the gh lookup fails (can't
 * determine latest) — never a crash, never a fail. Returns a single result object
 * with the given `checkName` (doctor uses 'runner-version') otherwise.
 */
export async function checkRunnerVersion({ gh, cwd, checkName = 'runner-version' }) {
  const dockerfile = await readFile(join(cwd, 'runner', 'linux', 'Dockerfile'), 'utf8').catch(() => null);
  const ps1 = await readFile(join(cwd, 'runner', 'windows', 'setup-runner.ps1'), 'utf8').catch(() => null);
  const pinned = parsePinnedVersion(dockerfile) ?? parsePinnedVersion(ps1);
  if (!pinned) return null; // no scaffolded runner files → silent skip

  const latest = await fetchRunnerPin(gh); // no log — callers are read-only/quiet here
  if (latest.source !== 'live') return null; // gh unreachable → can't judge staleness → silent skip

  if (compareVersions(pinned, latest.version) < 0) {
    return warn(checkName,
      `pinned actions-runner v${pinned} is behind the latest v${latest.version} — GitHub deprecates old runners; the ephemeral runner will stop receiving jobs`,
      're-run /forge:init --runner (or bump RUNNER_VERSION + SHA-256 in runner/linux/Dockerfile and runner/windows/setup-runner.ps1)');
  }
  return ok(checkName, `pinned actions-runner v${pinned} is current`);
}
