import { describe, it, expect } from 'vitest';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  deriveServiceName, detectRunnerServices, serviceTargetResults,
} from '../plugin/scripts/lib/runner-checks.mjs';

// #260 AC2 — the repo-derived service/unit name, sanitized to a valid name. Kept in
// lockstep with the scaffold's PowerShell ConvertTo-ServiceSlug / bash slugify.
describe('deriveServiceName (#260)', () => {
  it('derives forge-runner-<owner>-<repo>', () => {
    expect(deriveServiceName('dngioidev', 'forge')).toBe('forge-runner-dngioidev-forge');
  });
  it('sanitizes non-alphanumerics to single dashes, lowercased, trimmed', () => {
    expect(deriveServiceName('My.Org', 'Some_Repo')).toBe('forge-runner-my-org-some-repo');
    expect(deriveServiceName('--A--', '__b__')).toBe('forge-runner-a-b');
  });
  it('falls back to a bare forge-runner when neither resolves', () => {
    expect(deriveServiceName('', '')).toBe('forge-runner');
    expect(deriveServiceName(undefined, undefined)).toBe('forge-runner');
  });
  it('a second repo derives a DISTINCT name (no clobber)', () => {
    expect(deriveServiceName('dngioidev', 'forge')).not.toBe(deriveServiceName('dngioidev', 'iomanage'));
  });
});

// #260 AC5 — surface the service's RESOLVED owner/repo, and warn on the mis-target
// (0 online matching runners while a service is present).
describe('serviceTargetResults (#260 AC5)', () => {
  const svc = [{ name: 'forge-runner-dngioidev-forge', owner: 'dngioidev', repo: 'forge' }];

  it('no service detected → silent skip (no result)', () => {
    expect(serviceTargetResults({ services: [], hasOnline: false, configuredOwner: 'o', configuredName: 'n' })).toEqual([]);
  });

  it('service present + online → ok surfacing the resolved target', () => {
    const [r] = serviceTargetResults({ services: svc, hasOnline: true, configuredOwner: 'dngioidev', configuredName: 'forge' });
    expect(r.level).toBe('ok');
    expect(r.msg).toMatch(/dngioidev\/forge/);
  });

  it('service present + 0 online matching → WARN mis-target hint (JIT-ephemeral)', () => {
    const [r] = serviceTargetResults({ services: svc, hasOnline: false, configuredOwner: 'dngioidev', configuredName: 'iomanage' });
    expect(r.level).toBe('warn');
    expect(r.msg).toMatch(/different repo/i);
    expect(r.msg).toMatch(/JIT-ephemeral/i);
    expect(r.msg).toMatch(/dngioidev\/forge/); // the service's resolved target is surfaced
    expect(r.hint).toMatch(/dngioidev\/iomanage/); // the configured repo it should target
  });

  it('unresolved target renders as "target unknown", never crashes', () => {
    const [r] = serviceTargetResults({ services: [{ name: 'forge-runner', owner: null, repo: null }], hasOnline: false });
    expect(r.level).toBe('warn');
    expect(r.msg).toMatch(/target unknown/);
  });
});

// #260 AC5 — best-effort cross-platform service discovery (argv-only, never throws).
describe('detectRunnerServices (#260 AC5)', () => {
  it('windows: enumerates forge-runner* services and reads NSSM env target', async () => {
    const exec = async (cmd, args) => {
      if (cmd === 'sc') {
        return { ok: true, code: 0, stdout: 'SERVICE_NAME: forge-runner-dngioidev-iomanage\nDISPLAY_NAME: x\nSERVICE_NAME: unrelated-svc\n', stderr: '' };
      }
      if (cmd === 'nssm') {
        // NSSM env blob also carries the PAT — the detector must extract ONLY owner/repo.
        return { ok: true, code: 0, stdout: 'FORGE_RUNNER_PAT=ghp_secretsecretsecretsecretsecretsecx\nFORGE_RUNNER_OWNER=dngioidev\nFORGE_RUNNER_REPO=iomanage\nPATH=c:\\gh', stderr: '' };
      }
      return { ok: false, code: 1, stdout: '', stderr: 'not found' };
    };
    const services = await detectRunnerServices({ exec, platform: 'win32' });
    expect(services).toEqual([{ name: 'forge-runner-dngioidev-iomanage', owner: 'dngioidev', repo: 'iomanage' }]);
    // never surface the PAT
    for (const s of services) expect(JSON.stringify(s)).not.toMatch(/ghp_/);
  });

  it('windows: sc query failing → [] (graceful, no throw)', async () => {
    const exec = async () => ({ ok: false, code: 1, stdout: '', stderr: 'x' });
    expect(await detectRunnerServices({ exec, platform: 'win32' })).toEqual([]);
  });

  it('linux: reads forge-runner*.service units and parses Environment= target', async () => {
    const home = await mkdtemp(join(tmpdir(), 'forge-svc-'));
    const unitDir = join(home, '.config', 'systemd', 'user');
    await mkdir(unitDir, { recursive: true });
    await writeFile(join(unitDir, 'forge-runner-dngioidev-iomanage.service'),
      '[Service]\nEnvironment=FORGE_RUNNER_OWNER=dngioidev FORGE_RUNNER_REPO=iomanage\n', 'utf8');
    await writeFile(join(unitDir, 'other.service'), '[Service]\n', 'utf8');
    const services = await detectRunnerServices({ platform: 'linux', home });
    expect(services).toEqual([{ name: 'forge-runner-dngioidev-iomanage', owner: 'dngioidev', repo: 'iomanage' }]);
  });

  it('linux: no systemd user dir → [] (graceful)', async () => {
    const home = await mkdtemp(join(tmpdir(), 'forge-nosvc-'));
    expect(await detectRunnerServices({ platform: 'linux', home })).toEqual([]);
  });
});
