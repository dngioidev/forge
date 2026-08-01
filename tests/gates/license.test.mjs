import { describe, it, expect } from 'vitest';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_ALLOWLIST,
  parseLicenses,
  evaluate,
  licenseAllowed,
  resolveAllowlist,
  parsePnpmResult,
  checkPluginLicense,
  runLicenseGate,
} from '../../plugin/scripts/gates/license.mjs';

const noop = () => {};
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

// The real forge dep tree today: 58 packages, all permissive — canned in the
// `pnpm licenses list --json` shape (SPDX key -> array of package descriptors).
const PERMISSIVE_JSON = JSON.stringify({
  MIT: [
    { name: 'vitest', versions: ['3.2.4'], license: 'MIT' },
    { name: '@ts-morph/common', versions: ['0.29.0'], license: 'MIT' },
  ],
  'Apache-2.0': [{ name: 'ts-morph', versions: ['28.0.0'], license: 'Apache-2.0' }],
  'BlueOak-1.0.0': [{ name: 'jackspeak', versions: ['3.4.3'], license: 'BlueOak-1.0.0' }],
  ISC: [{ name: 'semver', versions: ['7.7.2'], license: 'ISC' }],
  'BSD-3-Clause': [{ name: 'source-map-js', versions: ['1.2.1'], license: 'BSD-3-Clause' }],
});
const execPermissive = async () => ({ ok: true, stdout: PERMISSIVE_JSON, stderr: '' });

async function tempDir() {
  return mkdtemp(join(tmpdir(), 'forge-lic-'));
}

describe('license gate — SPDX allowlist enforcement (#342)', () => {
  it('AC-342.1: parses the pnpm shape and passes an all-permissive tree', () => {
    const licenses = parseLicenses(JSON.parse(PERMISSIVE_JSON));
    expect(licenses).toContainEqual({ name: 'ts-morph', license: 'Apache-2.0' });
    expect(licenses).toContainEqual({ name: 'jackspeak', license: 'BlueOak-1.0.0' });
    const res = evaluate(licenses);
    expect(res.ok).toBe(true);
    expect(res.violations).toEqual([]);
  });

  it('AC-342.1: FAILS on a disallowed (GPL) SPDX id', () => {
    const gpl = {
      MIT: [{ name: 'fine', versions: ['1'], license: 'MIT' }],
      'GPL-3.0-only': [{ name: 'copyleft-lib', versions: ['1'], license: 'GPL-3.0-only' }],
    };
    const res = evaluate(parseLicenses(gpl));
    expect(res.ok).toBe(false);
    expect(res.violations).toHaveLength(1);
    expect(res.violations[0]).toMatchObject({ name: 'copyleft-lib', license: 'GPL-3.0-only' });
    expect(res.violations[0].reason).toMatch(/not in the allowlist/);
  });

  it('AC-342.1: fails CLOSED on unknown / UNLICENSED / missing license', () => {
    const bad = {
      Unknown: [{ name: 'mystery', versions: ['1'], license: 'Unknown' }],
      UNLICENSED: [{ name: 'proprietary', versions: ['1'], license: 'UNLICENSED' }],
      // grouped under a key but with no per-package license and an empty key would
      // still fail; here the key itself is the only signal and is not allowlisted.
    };
    const res = evaluate(parseLicenses(bad));
    expect(res.ok).toBe(false);
    const names = res.violations.map((v) => v.name).sort();
    expect(names).toEqual(['mystery', 'proprietary']);
    for (const v of res.violations) expect(v.reason).toMatch(/fails closed|not in the allowlist/);
  });

  it('AC-342.1: a package with no license at all fails closed', () => {
    const res = evaluate([{ name: 'no-license-pkg', license: '' }]);
    expect(res.ok).toBe(false);
    expect(res.violations[0].reason).toMatch(/fails closed/);
  });

  it('AC-342.1: honours SPDX OR/AND compound expressions correctly', () => {
    const allow = new Set(DEFAULT_ALLOWLIST);
    expect(licenseAllowed('(MIT OR Apache-2.0)', allow)).toBe(true); // any disjunct allowed
    expect(licenseAllowed('(MIT OR GPL-3.0)', allow)).toBe(true);
    expect(licenseAllowed('(MIT AND CC0-1.0)', allow)).toBe(true); // both allowed
    expect(licenseAllowed('(MIT AND GPL-3.0)', allow)).toBe(false); // one conjunct disallowed
    expect(licenseAllowed('GPL-3.0-only', allow)).toBe(false);
  });

  it('AC-342.1: allowlist is overridable via forge.json license.allow, else defaults', () => {
    expect(resolveAllowlist(null)).toEqual([...DEFAULT_ALLOWLIST]);
    expect(resolveAllowlist({})).toEqual([...DEFAULT_ALLOWLIST]);
    expect(resolveAllowlist({ license: { allow: ['MIT', 'ISC'] } })).toEqual(['MIT', 'ISC']);
    // an empty/invalid override falls back to the default rather than allowing nothing
    expect(resolveAllowlist({ license: { allow: [] } })).toEqual([...DEFAULT_ALLOWLIST]);
    // a config that restricts the allowlist then rejects a previously-fine license
    const restricted = evaluate([{ name: 'ts-morph', license: 'Apache-2.0' }], resolveAllowlist({ license: { allow: ['MIT'] } }));
    expect(restricted.ok).toBe(false);
  });

  it('parsePnpmResult: empty stdout is a clean empty list; garbage fails closed', () => {
    expect(parsePnpmResult({ ok: true, stdout: '   ' })).toEqual({ ok: true, licenses: [] });
    expect(parsePnpmResult({ ok: true, stdout: 'not json' }).ok).toBe(false);
    expect(parsePnpmResult({ ok: true, stdout: PERMISSIVE_JSON }).licenses.length).toBe(6);
  });

  it('AC-342.2: validates the plugin\'s own license declaration on the real repo (LICENSE + package.json + plugin.json all MIT)', async () => {
    const res = await checkPluginLicense(REPO_ROOT);
    expect(res.problems).toEqual([]);
    expect(res.ok).toBe(true);
    expect(res.pkgLicense).toBe('MIT');
    expect(res.pluginLicense).toBe('MIT');
  });

  it('AC-342.2: FAILS when the LICENSE file is missing', async () => {
    const dir = await tempDir();
    await writeFile(join(dir, 'package.json'), JSON.stringify({ license: 'MIT' }), 'utf8');
    const res = await checkPluginLicense(dir);
    expect(res.ok).toBe(false);
    expect(res.problems.join(' ')).toMatch(/no LICENSE file/);
  });

  it('AC-342.2: FAILS when a declared license is inconsistent with MIT', async () => {
    const dir = await tempDir();
    await writeFile(join(dir, 'LICENSE'), 'MIT License\n\nCopyright (c) 2026', 'utf8');
    await writeFile(join(dir, 'package.json'), JSON.stringify({ license: 'Apache-2.0' }), 'utf8');
    const res = await checkPluginLicense(dir);
    expect(res.ok).toBe(false);
    expect(res.problems.join(' ')).toMatch(/package\.json license Apache-2\.0/);
  });

  it('AC-342.3: SKIPS gracefully (no crash) when there is no package.json (non-node project)', async () => {
    const dir = await tempDir();
    let execCalled = false;
    const res = await runLicenseGate({ cwd: dir, execFn: async () => { execCalled = true; return { ok: true, stdout: '{}' }; }, log: noop });
    expect(res.ok).toBe(true);
    expect(res.skipped).toBe(true);
    expect(res.violations).toEqual([]);
    expect(execCalled).toBe(false); // never even shells out to pnpm
  });

  it('AC-342.4: runLicenseGate is GREEN on the current tree (real plugin declaration + all-permissive deps)', async () => {
    const res = await runLicenseGate({ cwd: REPO_ROOT, execFn: execPermissive, log: noop });
    expect(res.skipped).toBeFalsy();
    expect(res.plugin.ok).toBe(true);
    expect(res.violations).toEqual([]);
    expect(res.ok).toBe(true);
    expect(res.allowlist).toEqual([...DEFAULT_ALLOWLIST]);
  });

  it('AC-342.4: runLicenseGate FAILS the whole gate on a disallowed (GPL) dependency', async () => {
    const execGpl = async () => ({ ok: true, stdout: JSON.stringify({ 'GPL-3.0-only': [{ name: 'copyleft-lib', versions: ['1'], license: 'GPL-3.0-only' }] }), stderr: '' });
    const res = await runLicenseGate({ cwd: REPO_ROOT, execFn: execGpl, log: noop });
    expect(res.ok).toBe(false);
    expect(res.violations.some((v) => v.name === 'copyleft-lib')).toBe(true);
  });

  it('AC-342.4: runLicenseGate fails CLOSED on an unknown dependency license', async () => {
    const execUnknown = async () => ({ ok: true, stdout: JSON.stringify({ Unknown: [{ name: 'mystery', versions: ['1'], license: 'Unknown' }] }), stderr: '' });
    const res = await runLicenseGate({ cwd: REPO_ROOT, execFn: execUnknown, log: noop });
    expect(res.ok).toBe(false);
    expect(res.violations[0]).toMatchObject({ name: 'mystery' });
    expect(res.violations[0].reason).toMatch(/fails closed/);
  });

  it('AC-342.4: runLicenseGate FAILS when the plugin LICENSE declaration is missing (node project, permissive deps)', async () => {
    const dir = await tempDir();
    await writeFile(join(dir, 'package.json'), JSON.stringify({ license: 'MIT' }), 'utf8');
    // package.json present (node project) but no LICENSE file → plugin check fails.
    const res = await runLicenseGate({ cwd: dir, execFn: execPermissive, log: noop });
    expect(res.skipped).toBeFalsy();
    expect(res.ok).toBe(false);
    expect(res.plugin.problems.join(' ')).toMatch(/no LICENSE file/);
  });
});
