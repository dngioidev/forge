import { describe, it, expect } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, readdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runRunnerInit, parseArgs, ensureGitleaksAllowlist } from '../plugin/scripts/runner/init.mjs';
import { runInit, parseArgs as parseInitArgs } from '../plugin/scripts/init.mjs';
import { fakeGh } from './helpers/fakegh.mjs';

const noop = () => {};

// One repo-view call now returns isPrivate + owner + name together.
const PRIVATE = { stdout: JSON.stringify({ isPrivate: true, owner: { login: 'dngioidev' }, name: 'forge' }) };
const PUBLIC = { stdout: JSON.stringify({ isPrivate: false, owner: { login: 'dngioidev' }, name: 'forge' }) };

function privateRoutes() {
  return [[(j) => j.startsWith('repo view'), PRIVATE]];
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

    const compose = await readFile(join(cwd, 'runner', 'linux', 'docker-compose.yml'), 'utf8');
    expect(compose).toContain('/var/run/docker.sock:/var/run/docker.sock'); // socket mount for actionlint
    expect(compose).toContain('ENCODED_JIT_CONFIG'); // JIT config injected per job
    expect(compose).not.toContain('FORGE_RUNNER_PAT'); // no PAT in compose
    expect(compose).not.toMatch(/^\s*secrets:/m); // no compose secrets block

    const supervisor = await readFile(join(cwd, 'runner', 'linux', 'supervisor.mjs'), 'utf8');
    expect(supervisor).toContain('generate-jitconfig'); // mints 1h JIT per job
    expect(supervisor).toContain("'--rm'"); // single-use container
    expect(supervisor).toContain('dngioidev'); // owner substituted
    expect(supervisor).toContain('forge-local'); // label substituted

    await stat(join(cwd, 'runner', 'linux', 'entrypoint.sh'));
    const ps1 = await readFile(join(cwd, 'runner', 'windows', 'setup-runner.ps1'), 'utf8');
    expect(ps1).toContain('Get-FileHash'); // checksum-verified windows runner download
    expect(ps1).toContain('forge-local');

    await stat(join(cwd, 'runner', 'README.md'));

    // verify.yml — Linux on forge-local; Windows a normal per-PR check on hosted
    const verify = await readFile(join(cwd, '.github', 'workflows', 'verify.yml'), 'utf8');
    expect(verify).toContain('self-hosted, linux, forge-local');
    expect(verify).not.toContain("if: github.event_name != 'pull_request'"); // windows runs per-PR, no gate
    expect(verify).toContain('windows-latest'); // hosted per-PR check
    expect(verify).not.toContain('schedule:'); // no nightly cron — Windows runs per-PR now
    expect(verify).not.toContain('cron:');
    expect(verify).toContain('pnpm verify'); // {{VERIFY}} substituted
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
    const res = await runRunnerInit({ gh, cwd }, parseArgs([]), noop);
    expect(res.ok).toBe(true);
    expect(await readFile(join(cwd, '.github', 'workflows', 'verify.yml'), 'utf8')).toBe('# user CI\n');
    const variant = await readFile(join(cwd, '.github', 'workflows', 'verify.runner.yml'), 'utf8');
    expect(variant).toContain('self-hosted, linux, forge-local');
    expect(res.review).toContain(join('.github', 'workflows', 'verify.runner.yml'));
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
