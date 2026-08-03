import { describe, it, expect } from 'vitest';
import { mkdtemp, writeFile, mkdir } from 'node:fs/promises';
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
  PYTHON_LICENSES,
  PYTHON_LICENSE_EXCEPTIONS,
  parsePyprojectDeps,
  resolvePythonLicenses,
  evaluatePython,
  checkPythonLicenses,
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

// #349 — the license gate was blind to the Python dependency tree
// (tools/runner-ui/pyproject.toml), so the one genuinely non-permissive dep,
// PySide6 (LGPL-3.0), was invisible to the gate built to catch copyleft.
describe('license gate — Python dependency tree (#349)', () => {
  // A synthetic pyproject that exercises the parser's edge cases: a runtime dep, a
  // marker string carrying inner single quotes (pywinpty's `sys_platform == 'win32'`),
  // a dev group, and non-dependency arrays (build requires / hatch packages /
  // testpaths) that must NOT leak in. It mirrors the pre-#355 cockpit shape on
  // purpose so the parser stays covered against markers/quotes even though the real
  // tree is now cores-only.
  const PYPROJECT = `[project]
name = "forge-cockpit"
version = "0.1.0"
license = { text = "LGPL-3.0-or-later" }
dependencies = [
    "PySide6>=6.7",
    "pywinpty>=2.0; sys_platform == 'win32'",
    "psutil>=5.9",
]

[project.scripts]
forge-cockpit = "forge_cockpit.__main__:main"

[dependency-groups]
dev = [
    "pytest>=8.0",
    "pytest-qt>=4.4",
]

[build-system]
requires = ["hatchling"]
build-backend = "hatchling.build"

[tool.hatch.build.targets.wheel]
packages = ["forge_cockpit"]

[tool.pytest.ini_options]
testpaths = ["tests"]
`;

  it('AC-349.1: parses ONLY declared/dev deps from pyproject.toml (not build requires, packages, testpaths)', () => {
    const names = parsePyprojectDeps(PYPROJECT);
    expect(names).toEqual(['pyside6', 'pywinpty', 'psutil', 'pytest', 'pytest-qt']);
    // the marker's inner 'win32' and the non-dependency arrays must NOT leak in.
    expect(names).not.toContain('win32');
    expect(names).not.toContain('hatchling');
    expect(names).not.toContain('forge_cockpit');
    expect(names).not.toContain('tests');
  });

  it('AC-349.1: resolves declared deps through the curated SPDX map; unmapped → empty (fails closed)', () => {
    const resolved = resolvePythonLicenses(['psutil', 'pytest', 'mystery-dep']);
    expect(resolved).toContainEqual({ name: 'psutil', license: 'BSD-3-Clause' });
    expect(resolved).toContainEqual({ name: 'pytest', license: 'MIT' });
    expect(resolved).toContainEqual({ name: 'mystery-dep', license: '' });
  });

  it('AC-355.3: the whole real Python tree is inspected + allowlist applied (gate is not blind to it)', async () => {
    const res = await checkPythonLicenses(REPO_ROOT);
    expect(res.skipped).toBeFalsy();
    // #355 retired PySide6/pywinpty/pytest-qt; #351 (Cockpit v2 backend, ADR-0008)
    // added the FastAPI web stack — fastapi + uvicorn (runtime) and httpx (dev,
    // powering the TestClient), all permissive. Every declared dep is actually
    // evaluated, not silently skipped.
    expect(res.names).toEqual(['psutil', 'fastapi', 'uvicorn', 'pytest', 'httpx']);
    expect(res.ok).toBe(true);
  });

  it('AC-355.3: the real Python tree is fully permissive with ZERO exceptions (PySide6 retired)', async () => {
    // #355 removed the desktop UI and with it the one LGPL dependency (PySide6),
    // so the Python tree is now clean end to end — no violations AND no exceptions.
    expect(DEFAULT_ALLOWLIST).not.toContain('LGPL-3.0'); // LGPL is still NOT permissive.
    const res = await checkPythonLicenses(REPO_ROOT);
    expect(res.violations).toEqual([]);   // no violations...
    expect(res.exceptions).toEqual([]);   // ...and, crucially, no documented waivers either.
    expect(res.exceptions.find((e) => e.name === 'pyside6')).toBeUndefined(); // PySide6 is gone.
    expect(res.ok).toBe(true);

    // The exception mechanism is retained and still package-scoped: an LGPL dep
    // that isn't waived (nothing is, now) still fails closed.
    const other = evaluatePython([{ name: 'some-lgpl-lib', license: 'LGPL-3.0' }]);
    expect(other.ok).toBe(false);
    expect(other.violations[0]).toMatchObject({ name: 'some-lgpl-lib', license: 'LGPL-3.0' });
  });

  it('AC-349.3: a disallowed (GPL-3.0) Python dependency is CAUGHT — the gate fails', () => {
    const res = evaluatePython([
      { name: 'psutil', license: 'BSD-3-Clause' },
      { name: 'copyleft-py', license: 'GPL-3.0-only' },
    ]);
    expect(res.ok).toBe(false);
    expect(res.violations).toHaveLength(1);
    expect(res.violations[0]).toMatchObject({ name: 'copyleft-py', license: 'GPL-3.0-only' });
    expect(res.violations[0].reason).toMatch(/not in the allowlist/);
  });

  it('AC-349.3: an unmapped/unknown Python dep fails CLOSED (never silently passes)', () => {
    const res = evaluatePython(resolvePythonLicenses(['pytest', 'brand-new-unmapped-dep']));
    expect(res.ok).toBe(false);
    expect(res.violations.map((v) => v.name)).toEqual(['brand-new-unmapped-dep']);
    expect(res.violations[0].reason).toMatch(/fails closed/);
  });

  it('AC-349.3: checkPythonLicenses FAILS on a fixture pyproject carrying a GPL dep', async () => {
    const dir = await tempDir();
    await writeFile(join(dir, 'pyproject.toml'), `[project]
dependencies = ["psutil>=5.9"]
`, 'utf8');
    // map psutil→BSD (fine) but inject a GPL dep via a one-off map to prove the pipeline fails.
    const gplMap = { psutil: 'GPL-3.0-only' };
    const resolved = resolvePythonLicenses(parsePyprojectDeps(await readFileFixture(dir)), gplMap);
    const res = evaluatePython(resolved);
    expect(res.ok).toBe(false);
    expect(res.violations[0]).toMatchObject({ name: 'psutil', license: 'GPL-3.0-only' });
  });

  it('AC-349.1: checkPythonLicenses SKIPS gracefully when there is no pyproject.toml', async () => {
    const dir = await tempDir();
    const res = await checkPythonLicenses(dir);
    expect(res.skipped).toBe(true);
    expect(res.ok).toBe(true);
    expect(res.violations).toEqual([]);
  });

  it('AC-355.3: there are NO Python license exceptions — the PySide6 waiver is gone with the dep', () => {
    // #355 retired PySide6 (the only LGPL dep), so its documented #349 exception
    // must not outlive it: the exception set is now empty.
    expect(PYTHON_LICENSE_EXCEPTIONS).toEqual([]);
    expect(PYTHON_LICENSE_EXCEPTIONS.find((e) => e.package === 'pyside6')).toBeUndefined();
    // the curated map no longer classifies PySide6/pywinpty/pytest-qt either.
    expect(PYTHON_LICENSES.pyside6).toBeUndefined();
    expect(PYTHON_LICENSES.pywinpty).toBeUndefined();
    expect(PYTHON_LICENSES['pytest-qt']).toBeUndefined();
  });

  it('AC-355.3: runLicenseGate covers BOTH trees and stays GREEN on the real repo with ZERO exceptions', async () => {
    const res = await runLicenseGate({ cwd: REPO_ROOT, execFn: execPermissive, log: noop });
    expect(res.ok).toBe(true);
    expect(res.python).toBeTruthy();
    expect(res.python.skipped).toBeFalsy();
    expect(res.python.exceptions).toEqual([]); // no waivers — fully permissive Python tree.
    expect(res.python.violations).toEqual([]);
  });

  it('AC-349.3: runLicenseGate FAILS overall when the Python tree carries a non-permissive dep (end to end)', async () => {
    // A full mini-repo: MIT plugin declaration + all-permissive npm (execPermissive),
    // but a cockpit pyproject that declares an unmapped/non-permissive Python dep.
    const dir = await tempDir();
    await writeFile(join(dir, 'LICENSE'), 'MIT License\n\nCopyright (c) 2026', 'utf8');
    await writeFile(join(dir, 'package.json'), JSON.stringify({ license: 'MIT' }), 'utf8');
    const pyDir = join(dir, 'tools', 'runner-ui');
    await mkdir(pyDir, { recursive: true });
    await writeFile(join(pyDir, 'pyproject.toml'), `[project]
dependencies = ["some-copyleft-lib>=1.0"]
`, 'utf8');
    const res = await runLicenseGate({ cwd: dir, execFn: execPermissive, log: noop });
    expect(res.plugin.ok).toBe(true);       // plugin declaration fine
    expect(res.violations).toEqual([]);     // npm side fine
    expect(res.python.ok).toBe(false);      // Python side catches the unmapped dep
    expect(res.ok).toBe(false);             // → whole gate reds
    expect(res.python.violations[0]).toMatchObject({ name: 'some-copyleft-lib' });
  });
});

// Small helper: read the fixture pyproject written into a temp dir.
async function readFileFixture(dir) {
  const { readFile } = await import('node:fs/promises');
  return readFile(join(dir, 'pyproject.toml'), 'utf8');
}
