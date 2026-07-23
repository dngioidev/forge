import { describe, it, expect } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, readdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runRunnerInit, parseArgs, ensureGitleaksAllowlist } from '../plugin/scripts/runner/init.mjs';
import { runInit, parseArgs as parseInitArgs } from '../plugin/scripts/init.mjs';
import { fakeGh } from './helpers/fakegh.mjs';

const noop = () => {};

// One repo-view call now returns isPrivate + owner + name together.
const PRIVATE = { stdout: JSON.stringify({ isPrivate: true, owner: { login: 'dngioidev' }, name: 'forge' }) };
const PUBLIC = { stdout: JSON.stringify({ isPrivate: false, owner: { login: 'dngioidev' }, name: 'forge' }) };

// #233: the current actions/runner release init pins at scaffold time. The
// published linux-x64 / win-x64 SHA-256 live between markers in the release body.
const REL_VERSION = '2.340.0';
const REL_LINUX = 'a'.repeat(64);
const REL_WIN = 'b'.repeat(64);
const RELEASE = {
  stdout: JSON.stringify({
    tag_name: `v${REL_VERSION}`,
    body: [
      `- actions-runner-linux-x64-${REL_VERSION}.tar.gz <!-- BEGIN SHA linux-x64 -->${REL_LINUX}<!-- END SHA linux-x64 -->`,
      `- actions-runner-win-x64-${REL_VERSION}.zip <!-- BEGIN SHA win-x64 -->${REL_WIN}<!-- END SHA win-x64 -->`,
    ].join('\n'),
  }),
};

function privateRoutes() {
  return [
    [(j) => j.startsWith('api repos/actions/runner/releases/latest'), RELEASE],
    [(j) => j.startsWith('repo view'), PRIVATE],
  ];
}

async function tmpCwd() {
  return mkdtemp(join(tmpdir(), 'forge-runner-'));
}

async function walkFiles(dir, base = dir, out = []) {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) await walkFiles(p, base, out);
    else out.push(p);
  }
  return out;
}

describe('runner init — arg wiring', () => {
  it('init.mjs parseArgs recognizes --runner and --label', () => {
    expect(parseInitArgs(['--runner'])).toMatchObject({ runner: true });
    expect(parseInitArgs(['--runner', '--label', 'my-box'])).toMatchObject({ runner: true, label: 'my-box' });
  });

  it('runner parseArgs defaults the label to forge-local', () => {
    expect(parseArgs([])).toMatchObject({ label: 'forge-local' });
    expect(parseArgs(['--label', 'x'])).toMatchObject({ label: 'x' });
  });

  it('runInit --runner short-circuits to the runner scaffold — no board bootstrap calls', async () => {
    const cwd = await tmpCwd();
    const { gh, calls } = fakeGh(privateRoutes());
    const res = await runInit({ gh, cwd, log: noop, args: parseInitArgs(['--runner']) });
    expect(res.ok).toBe(true);
    expect(res.placed).toBeTruthy(); // runner-mode return shape, not board bootstrap
    // the board flow (auth/project/issue) never runs
    expect(calls.some((c) => c.startsWith('auth status'))).toBe(false);
    expect(calls.some((c) => c.includes('project'))).toBe(false);
    expect(calls.some((c) => c.startsWith('issue'))).toBe(false);
    await stat(join(cwd, 'runner', 'linux', 'Dockerfile'));
  });
});

describe('AC2 — private-repo scaffold', () => {
  it('places the ephemeral Linux runner, Windows setup, and trimmed verify.yml with substitutions', async () => {
    const cwd = await tmpCwd();
    const { gh } = fakeGh(privateRoutes());
    const res = await runRunnerInit({ gh, cwd }, parseArgs([]), noop);
    expect(res.ok).toBe(true);

    // ephemeral Linux container runner assets
    const dockerfile = await readFile(join(cwd, 'runner', 'linux', 'Dockerfile'), 'utf8');
    expect(dockerfile).toContain('actions-runner'); // runner baked in
    expect(dockerfile).toContain('corepack enable'); // pnpm
    expect(dockerfile).toContain('gh'); // gh baked in
    expect(dockerfile).toContain('sha256sum -c'); // checksum-verified download (supply chain)
    // #233: version + SHA auto-pinned to the current release — no placeholder left.
    expect(dockerfile).toContain(`ARG RUNNER_VERSION=${REL_VERSION}`);
    expect(dockerfile).toContain(`ARG RUNNER_SHA256=${REL_LINUX}`);
    expect(dockerfile).not.toContain('REPLACE-ME');
    expect(dockerfile).not.toContain('{{RUNNER_VERSION}}');
    expect(dockerfile).not.toContain('{{RUNNER_SHA256_LINUX}}');
    expect(dockerfile).toMatch(/ARG RUNNER_SHA256=[0-9a-f]{64}\b/); // real 64-hex SHA

    const compose = await readFile(join(cwd, 'runner', 'linux', 'docker-compose.yml'), 'utf8');
    expect(compose).toContain('/var/run/docker.sock:/var/run/docker.sock'); // socket mount for actionlint
    expect(compose).toContain('ENCODED_JIT_CONFIG'); // JIT config injected per job
    expect(compose).not.toContain('FORGE_RUNNER_PAT'); // no PAT in compose
    expect(compose).not.toMatch(/^\s*secrets:/m); // no compose secrets block
    // #232: build-safe — the `:?` required-variable form trips `docker compose
    // build`/`config` on a fresh scaffold (no JIT config yet). Must use the
    // default form (`:-`) so build/config parse; the run-time guard moves to
    // entrypoint.sh.
    expect(compose).not.toMatch(/ENCODED_JIT_CONFIG:\?/); // no required-var guard in compose
    expect(compose).toContain('${ENCODED_JIT_CONFIG:-}'); // build-safe default

    // #232: the hard "must be injected" guarantee is enforced at RUN time in the
    // entrypoint — fail fast (non-zero exit) if the config is empty when a job
    // starts, without echoing the secret value.
    const entrypoint = await readFile(join(cwd, 'runner', 'linux', 'entrypoint.sh'), 'utf8');
    expect(entrypoint).toMatch(/-z\s+"\$\{ENCODED_JIT_CONFIG:-\}"/); // empty-check guard
    expect(entrypoint).toContain('exit 1'); // fail fast on empty config

    const supervisor = await readFile(join(cwd, 'runner', 'linux', 'supervisor.mjs'), 'utf8');
    expect(supervisor).toContain('generate-jitconfig'); // mints 1h JIT per job
    expect(supervisor).toContain("'--rm'"); // single-use container
    expect(supervisor).toContain('dngioidev'); // owner substituted
    expect(supervisor).toContain('forge-local'); // label substituted

    // #254: the durable systemd --user installer is scaffolded alongside the supervisor.
    const installSh = await readFile(join(cwd, 'runner', 'linux', 'install-service.sh'), 'utf8');
    expect(installSh).toContain('EnvironmentFile=%h/.forge/runner.env');
    expect(installSh).toContain('WantedBy=default.target');

    await stat(join(cwd, 'runner', 'linux', 'entrypoint.sh'));
    const ps1 = await readFile(join(cwd, 'runner', 'windows', 'setup-runner.ps1'), 'utf8');
    expect(ps1).toContain('Get-FileHash'); // checksum-verified windows runner download
    expect(ps1).toContain('forge-local');
    // #254: the NSSM service registration flags are scaffolded into the same script.
    expect(ps1).toContain('[switch]$InstallService');
    expect(ps1).toContain('[switch]$UninstallService');
    // #233: win-x64 version + SHA auto-pinned; no placeholder left.
    expect(ps1).toContain(`$RunnerVersion = '${REL_VERSION}'`);
    expect(ps1).toContain(`$RunnerSha256 = '${REL_WIN}'`);
    expect(ps1).not.toContain('REPLACE-ME');
    expect(ps1).not.toContain('{{RUNNER_VERSION}}');
    expect(ps1).not.toContain('{{RUNNER_SHA256_WIN}}');
    expect(ps1).toMatch(/\$RunnerSha256 = '[0-9a-f]{64}'/); // real 64-hex SHA
    // #240: the generated .ps1 must be ASCII-only — Windows PowerShell 5.1 reads
    // BOM-less scripts as ANSI, so a non-ASCII char (e.g. an em-dash) mojibakes and
    // breaks parsing. Guard against reintroducing one.
    expect(/^[\x00-\x7F]*$/.test(ps1)).toBe(true);

    await stat(join(cwd, 'runner', 'README.md'));

    // verify.yml — Linux on forge-local; Windows a normal per-PR check on hosted
    const verify = await readFile(join(cwd, '.github', 'workflows', 'verify.yml'), 'utf8');
    expect(verify).toContain('self-hosted, linux, forge-local');
    expect(verify).not.toContain("if: github.event_name != 'pull_request'"); // windows runs per-PR, no gate
    expect(verify).toContain('windows-latest'); // hosted per-PR check
    expect(verify).not.toContain('schedule:'); // no nightly cron — Windows runs per-PR now
    expect(verify).not.toContain('cron:');
    expect(verify).toContain('pnpm verify'); // {{VERIFY}} substituted
    // #236: distinct concurrency group so the runner variant never collides with
    // an incumbent `name: verify` workflow (both would share the bare
    // `${{ github.workflow }}-${{ github.ref }}` group and cancel each other).
    expect(verify).toContain('group: verify-runner-${{ github.ref }}');
    expect(verify).not.toContain('group: ${{ github.workflow }}-${{ github.ref }}');
    expect(verify).toContain('cancel-in-progress: true'); // still self-cancels stale runs per ref
    for (const token of ['{{OWNER}}', '{{REPO}}', '{{LABEL}}', '{{VERIFY}}']) {
      expect(verify).not.toContain(token);
    }
    // actionlint runs as a pinned, checksum-verified BINARY — never a docker://
    // container action (#238: nested bind-mount breaks the workspace on the runner).
    expect(verify).not.toContain('uses: docker://'); // no container action
    expect(verify).toContain('version=1.7.7'); // pinned v1.7.7 binary
    expect(verify).toContain('actionlint_${version}_linux_amd64.tar.gz');
    expect(verify).toContain('023070a287cd8cccd71515fedc843f1985bf96c436b7effaecce67290e7e0757'); // SHA-256 pin
    expect(verify).toContain('sha256sum -c'); // checksum-verified download (supply chain)
    expect(verify).toContain('./actionlint -color'); // binary run

    // actionlint runner-label declared so the self-hosted `runs-on` doesn't trip
    // actionlint's runner-label check (label substituted, no placeholder left).
    const actionlintCfg = await readFile(join(cwd, '.github', 'actionlint.yaml'), 'utf8');
    expect(actionlintCfg).toContain('self-hosted-runner:');
    expect(actionlintCfg).toContain('forge-local');
    expect(actionlintCfg).not.toContain('{{LABEL}}');
  });

  it('uses conventions.verify from forge.json and a custom --label', async () => {
    const cwd = await tmpCwd();
    await mkdir(join(cwd, '.claude'), { recursive: true });
    await writeFile(join(cwd, '.claude', 'forge.json'), JSON.stringify({
      board: { projectNumber: 8, projectId: 'PVT_x', fields: {
        status: { id: 'PVTSSF_1', options: { backlog: 'a' } }, priority: { id: 'PVTSSF_2', options: { p0: 'b' } },
        size: { id: 'PVTSSF_3', options: { s: 'c' } }, type: { id: 'PVTSSF_4', options: { epic: 'd' } },
      } }, conventions: { verify: 'npm test' },
    }), 'utf8');
    const { gh } = fakeGh(privateRoutes());
    await runRunnerInit({ gh, cwd }, parseArgs(['--label', 'my-box']), noop);
    const verify = await readFile(join(cwd, '.github', 'workflows', 'verify.yml'), 'utf8');
    expect(verify).toContain('self-hosted, linux, my-box');
    expect(verify).toContain('npm test');
    expect(verify).not.toContain('forge-local');
  });

  it('never overwrites an existing verify.yml — drops verify.runner.yml for review', async () => {
    const cwd = await tmpCwd();
    await mkdir(join(cwd, '.github', 'workflows'), { recursive: true });
    await writeFile(join(cwd, '.github', 'workflows', 'verify.yml'), '# user CI\n', 'utf8');
    const { gh } = fakeGh(privateRoutes());
    const logs = [];
    const res = await runRunnerInit({ gh, cwd }, parseArgs([]), (m) => logs.push(String(m)));
    expect(res.ok).toBe(true);
    expect(await readFile(join(cwd, '.github', 'workflows', 'verify.yml'), 'utf8')).toBe('# user CI\n');
    const variant = await readFile(join(cwd, '.github', 'workflows', 'verify.runner.yml'), 'utf8');
    expect(variant).toContain('self-hosted, linux, forge-local');
    // #236: the review variant carries a distinct concurrency group so committing
    // it beside the incumbent verify.yml won't silently cancel the runner jobs.
    expect(variant).toContain('group: verify-runner-${{ github.ref }}');
    expect(variant).not.toContain('group: ${{ github.workflow }}-${{ github.ref }}');
    expect(res.review).toContain(join('.github', 'workflows', 'verify.runner.yml'));
    // #236: init logs a clear collision note explaining the two "verify" checks
    // coexist until the operator swaps.
    const blob = logs.join('\n');
    expect(blob).toMatch(/verify\.runner\.yml/);
    expect(blob).toMatch(/concurrency group/i);
    expect(blob).toMatch(/#236/);
  });

  it('#233: degrades to a real pinned fallback (no REPLACE-ME / placeholder) when the release lookup fails', async () => {
    const cwd = await tmpCwd();
    const logs = [];
    // release endpoint errors; repo view still private → scaffold proceeds with fallback pin
    const { gh } = fakeGh([
      [(j) => j.startsWith('api repos/actions/runner/releases/latest'), { ok: false, stderr: 'network is unreachable' }],
      [(j) => j.startsWith('repo view'), PRIVATE],
    ]);
    const res = await runRunnerInit({ gh, cwd }, parseArgs([]), (m) => logs.push(String(m)));
    expect(res.ok).toBe(true);
    const dockerfile = await readFile(join(cwd, 'runner', 'linux', 'Dockerfile'), 'utf8');
    const ps1 = await readFile(join(cwd, 'runner', 'windows', 'setup-runner.ps1'), 'utf8');
    for (const body of [dockerfile, ps1]) {
      expect(body).not.toContain('REPLACE-ME');
      expect(body).not.toMatch(/\{\{RUNNER_/); // no placeholder left
    }
    expect(dockerfile).toMatch(/ARG RUNNER_SHA256=[0-9a-f]{64}\b/); // real fallback SHA
    expect(ps1).toMatch(/\$RunnerSha256 = '[0-9a-f]{64}'/);
    expect(logs.join('\n')).toMatch(/warning: could not resolve the current actions\/runner release/);
  });

  it('re-run is a no-op — all assets kept, none re-placed', async () => {
    const cwd = await tmpCwd();
    const { gh } = fakeGh(privateRoutes());
    await runRunnerInit({ gh, cwd }, parseArgs([]), noop);
    const second = await runRunnerInit({ gh: fakeGh(privateRoutes()).gh, cwd }, parseArgs([]), noop);
    expect(second.ok).toBe(true);
    expect(second.placed).toEqual([]);
  });
});

describe('AC2 — public-repo refusal (fork-PR RCE guard)', () => {
  it('refuses on a public repo with a clear message and writes nothing', async () => {
    const cwd = await tmpCwd();
    const { gh } = fakeGh([[(j) => j.startsWith('repo view'), PUBLIC]]);
    const res = await runRunnerInit({ gh, cwd }, parseArgs([]), noop);
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/public repo/i);
    expect(res.error).toMatch(/private-repo only|fork/i);
    // no assets written
    await expect(stat(join(cwd, 'runner'))).rejects.toBeTruthy();
    await expect(stat(join(cwd, '.github'))).rejects.toBeTruthy();
  });

  it('errors when visibility cannot be determined', async () => {
    const cwd = await tmpCwd();
    const { gh } = fakeGh([[(j) => j.startsWith('repo view'), { ok: false, stderr: 'boom' }]]);
    const res = await runRunnerInit({ gh, cwd }, parseArgs([]), noop);
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/visibility/i);
  });
});

describe('AC3 — secret-store guards, no secret committed', () => {
  it('adds the runner.env store to .gitignore (idempotent)', async () => {
    const cwd = await tmpCwd();
    await writeFile(join(cwd, '.gitignore'), 'node_modules/\n', 'utf8');
    const { gh } = fakeGh(privateRoutes());
    await runRunnerInit({ gh, cwd }, parseArgs([]), noop);
    let gi = await readFile(join(cwd, '.gitignore'), 'utf8');
    for (const e of ['**/.forge/', 'runner.env', '*.runner.env']) expect(gi).toContain(e);
    expect(gi).toContain('node_modules/'); // preserved

    // re-run does not duplicate
    await runRunnerInit({ gh: fakeGh(privateRoutes()).gh, cwd }, parseArgs([]), noop);
    gi = await readFile(join(cwd, '.gitignore'), 'utf8');
    expect(gi.match(/^runner\.env$/gm).length).toBe(1);
  });

  it('adds the store paths to an existing gitleaks allowlist (idempotent)', async () => {
    const cwd = await tmpCwd();
    await writeFile(join(cwd, '.gitleaks.toml'), '[extend]\nuseDefault = true\n\n[allowlist]\ndescription = "x"\npaths = [\n  \'\'\'AKIAEXAMPLE\'\'\',\n]\n', 'utf8');
    const { gh } = fakeGh(privateRoutes());
    await runRunnerInit({ gh, cwd }, parseArgs([]), noop);
    const gl = await readFile(join(cwd, '.gitleaks.toml'), 'utf8');
    expect(gl).toContain('runner\\.env$');
    expect(gl).toContain('.forge/');

    // ensureGitleaksAllowlist is idempotent
    const again = ensureGitleaksAllowlist(gl);
    expect(again.changed).toBe(false);
  });

  it('ensureGitleaksAllowlist appends an allowlist when no paths array exists', () => {
    const { changed, content } = ensureGitleaksAllowlist('title = "cfg"\n[extend]\nuseDefault = true\n');
    expect(changed).toBe(true);
    expect(content).toMatch(/\[allowlist\]/);
    expect(content).toContain('runner\\.env$');
  });

  it('ensureGitleaksAllowlist handles a SINGLE-LINE paths array without corrupting TOML', () => {
    const { changed, content } = ensureGitleaksAllowlist('[allowlist]\npaths = ["AKIAEXAMPLE"]\n');
    expect(changed).toBe(true);
    // rewritten to a valid multi-line array: existing entry kept INSIDE the array,
    // new entries before the closing bracket (no bare strings outside the array).
    expect(content).toContain('runner\\.env$');
    const open = content.indexOf('paths = [');
    const close = content.indexOf(']', open);
    const inner = content.slice(open, close);
    expect(inner).toContain('AKIAEXAMPLE'); // kept
    expect(inner).toContain('runner\\.env$'); // new entry is inside the array
    // idempotent on the rewritten form
    expect(ensureGitleaksAllowlist(content).changed).toBe(false);
  });

  it('gitleaks step is skipped gracefully when the repo has no .gitleaks.toml', async () => {
    const cwd = await tmpCwd();
    const { gh } = fakeGh(privateRoutes());
    const res = await runRunnerInit({ gh, cwd }, parseArgs([]), noop);
    expect(res.ok).toBe(true);
    await expect(stat(join(cwd, '.gitleaks.toml'))).rejects.toBeTruthy(); // not created
  });

  it('writes NO secret: no runner.env created, no PAT-shaped token in any placed file', async () => {
    const cwd = await tmpCwd();
    const { gh } = fakeGh(privateRoutes());
    await runRunnerInit({ gh, cwd }, parseArgs([]), noop);
    // init never writes the secret store itself
    await expect(stat(join(cwd, '.forge', 'runner.env'))).rejects.toBeTruthy();
    await expect(stat(join(cwd, 'runner.env'))).rejects.toBeTruthy();
    // no committed file carries a real PAT-shaped token value
    const files = await walkFiles(cwd);
    for (const f of files) {
      const body = await readFile(f, 'utf8');
      expect(body).not.toMatch(/github_pat_[A-Za-z0-9_]{20,}/);
      expect(body).not.toMatch(/ghp_[A-Za-z0-9]{30,}/);
    }
  });
});

describe('#254 — service install tooling (structural)', () => {
  const tpl = (p) => fileURLToPath(new URL(`../plugin/templates/runner/${p}`, import.meta.url));

  it('linux install-service.sh writes a systemd --user unit, PAT via EnvironmentFile only', async () => {
    const sh = await readFile(tpl('linux/install-service.sh'), 'utf8');
    // secret model: PAT loaded from the out-of-band store, never inlined into the unit
    expect(sh).toContain('EnvironmentFile=%h/.forge/runner.env');
    expect(sh).toContain('Environment=FORGE_RUNNER_CONCURRENCY=1');
    expect(sh).toContain('Restart=on-failure');
    expect(sh).toContain('RestartSec=10');
    expect(sh).toContain('WantedBy=default.target');
    // ExecStart runs node against the resolved supervisor path
    expect(sh).toMatch(/ExecStart=\/usr\/bin\/env node /);
    // install lifecycle: reload + enable --now + boot persistence
    expect(sh).toContain('systemctl --user daemon-reload');
    expect(sh).toContain('systemctl --user enable --now');
    expect(sh).toContain('loginctl enable-linger');
    // uninstall counterpart
    expect(sh).toContain('--uninstall');
    expect(sh).toContain('disable --now');
    // status/logs guidance
    expect(sh).toContain('systemctl --user status');
    expect(sh).toContain('journalctl --user -u');
    // no hardcoded PAT anywhere
    expect(sh).not.toMatch(/github_pat_[A-Za-z0-9_]{20,}/);
    expect(sh).not.toMatch(/ghp_[A-Za-z0-9]{30,}/);
  });

  it('linux install-service.sh is ASCII-only', async () => {
    const sh = await readFile(tpl('linux/install-service.sh'), 'utf8');
    expect(/^[\x00-\x7F]*$/.test(sh)).toBe(true);
  });

  it('windows -InstallService uses AppEnvironmentExtra from env, never a literal or a file', async () => {
    const ps1 = await readFile(tpl('windows/setup-runner.ps1'), 'utf8');
    expect(ps1).toContain('[switch]$InstallService');
    expect(ps1).toContain('[switch]$UninstallService');
    // PAT sourced from THIS session env, handed to the service via AppEnvironmentExtra
    expect(ps1).toContain('AppEnvironmentExtra');
    expect(ps1).toContain('FORGE_RUNNER_PAT=$env:FORGE_RUNNER_PAT');
    // errors clearly when the session PAT is unset
    expect(ps1).toMatch(/if \(-not \$env:FORGE_RUNNER_PAT\)/);
    // requires elevation + NSSM (graceful hints)
    expect(ps1).toContain('Assert-Admin');
    expect(ps1).toMatch(/nssm/i);
    // service config: auto-start + restart-on-exit, args run -Serve
    expect(ps1).toContain('SERVICE_AUTO_START');
    expect(ps1).toContain('AppExit Default Restart');
    expect(ps1).toMatch(/'-File'[^\n]*'-Serve'/);
    // never persists the PAT to a file (no Out-File/Set-Content/Add-Content carrying it)
    expect(ps1).not.toMatch(/FORGE_RUNNER_PAT[^\n]*(Out-File|Set-Content|Add-Content)/);
    // no literal PAT
    expect(ps1).not.toMatch(/github_pat_[A-Za-z0-9_]{20,}/);
    // #256: fresh install must NOT run `nssm stop` on a missing service (its stderr
    // terminates under ErrorActionPreference=Stop). Pre-clean is guarded by a
    // Get-Service existence check, and the nssm calls run non-terminating.
    expect(ps1).toMatch(/if \(Get-Service \$ServiceName -ErrorAction SilentlyContinue\)/);
    expect(ps1).toContain("$ErrorActionPreference = 'Continue'");
    expect(ps1).not.toMatch(/nssm[^\n]*stop[^\n]*2>\$null/i); // the old terminating pattern is gone
    // #258: the LocalSystem service needs gh on its PATH (user-scoped gh is invisible
    // to LocalSystem), carried via AppEnvironmentExtra PATH; and its output is logged.
    expect(ps1).toMatch(/Get-Command gh/);
    expect(ps1).toContain('PATH=$svcPath');
    expect(ps1).toMatch(/AppStderr/);
  });

  it('windows setup-runner.ps1 stays ASCII-only with the new service code (#240 guard)', async () => {
    const ps1 = await readFile(tpl('windows/setup-runner.ps1'), 'utf8');
    expect(/^[\x00-\x7F]*$/.test(ps1)).toBe(true);
  });
});
