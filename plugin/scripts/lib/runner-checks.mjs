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
import { readFile } from 'node:fs/promises';
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
