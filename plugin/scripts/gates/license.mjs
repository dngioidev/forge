#!/usr/bin/env node
/**
 * License-compliance gate (#342, spec §13 supply-chain): the *enforcing* license
 * check forge never had. depguard only proves a dependency EXISTS; the consumer
 * CI template merely runs `pnpm licenses list` and never fails. This gate reads
 * the installed dependency licenses (npm via `pnpm licenses list --json`) and
 * FAILS on any SPDX id outside a configurable allowlist — and it also validates
 * the plugin's OWN license declaration (a LICENSE file plus a consistent license
 * field in package.json and plugin/.claude-plugin/plugin.json).
 *
 * Fail-closed by construction: an unknown / UNLICENSED / missing license is a
 * violation, never a pass. It degrades gracefully (skip, don't crash) when there
 * is no pnpm/node project to inspect. Sibling ticket #343 wires it into CI; this
 * ticket only builds the gate and registers it in the gate suite (gate_run).
 *
 * Pure functions (parseLicenses / evaluate / resolveAllowlist / licenseAllowed)
 * hold the logic and are unit-tested with canned JSON; the runner shells out to
 * pnpm through the injected exec so tests never touch the network or real pnpm.
 */
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { run } from '../lib/exec.mjs';
import { loadConfig } from '../lib/config.mjs';

/**
 * The default permissive allowlist (#342/AC.1). SPDX ids that carry no
 * copyleft/attribution surprise for a plugin that ships zero runtime deps.
 * Overridable via forge.json `license.allow`.
 */
export const DEFAULT_ALLOWLIST = Object.freeze([
  'MIT', 'ISC', 'Apache-2.0', 'BSD-2-Clause', 'BSD-3-Clause',
  'BlueOak-1.0.0', '0BSD', 'Unlicense', 'CC0-1.0',
]);

/** The plugin's own declared license (AC.2) — forge is MIT end to end. */
export const EXPECTED_LICENSE = 'MIT';

/** License strings that mean "no usable license" — always fail closed (AC.1). */
const UNKNOWN_MARKERS = new Set(['', 'unknown', 'unlicensed', 'see license in license', 'none']);

/**
 * Flatten `pnpm licenses list --json` into [{name, license}]. The output is an
 * object keyed by the SPDX license string, each value an array of package
 * descriptors ({name, versions, license, ...}). We prefer the per-package
 * `license` field and fall back to the group key; a package with neither yields
 * an empty license string, which evaluate() then fails closed. Pure — no I/O.
 */
export function parseLicenses(pnpmJson) {
  const out = [];
  if (!pnpmJson || typeof pnpmJson !== 'object' || Array.isArray(pnpmJson)) return out;
  for (const [groupKey, pkgs] of Object.entries(pnpmJson)) {
    if (!Array.isArray(pkgs)) continue;
    for (const p of pkgs) {
      const name = (p && typeof p.name === 'string' && p.name) || '(unknown package)';
      const perPkg = p && typeof p.license === 'string' ? p.license.trim() : '';
      const license = perPkg || (typeof groupKey === 'string' ? groupKey.trim() : '');
      out.push({ name, license });
    }
  }
  return out;
}

/**
 * Is a single license string permitted by the allowlist? Handles the common SPDX
 * compound expressions the right way: `(MIT OR Apache-2.0)` passes if ANY disjunct
 * is allowed; `(MIT AND CC0-1.0)` passes only if EVERY conjunct is allowed. An
 * empty / unknown / UNLICENSED marker is never allowed (fail closed).
 */
export function licenseAllowed(license, allow) {
  const norm = (license ?? '').trim();
  if (!norm || UNKNOWN_MARKERS.has(norm.toLowerCase())) return false;
  if (allow.has(norm)) return true;
  const inner = norm.replace(/^\(+|\)+$/g, '').trim();
  const clean = (s) => s.trim().replace(/^\(+|\)+$/g, '').trim();
  if (/\sOR\s/i.test(inner)) return inner.split(/\sOR\s/i).some((part) => allow.has(clean(part)));
  if (/\sAND\s/i.test(inner)) return inner.split(/\sAND\s/i).every((part) => allow.has(clean(part)));
  return false;
}

/**
 * Check a flat [{name, license}] list against an allowlist. Returns
 * { ok, violations:[{name, license, reason}] }. Pure — no I/O.
 */
export function evaluate(licenses, allowlist = DEFAULT_ALLOWLIST) {
  const allow = new Set(allowlist);
  const violations = [];
  for (const { name, license } of licenses) {
    const norm = (license ?? '').trim();
    if (!norm || UNKNOWN_MARKERS.has(norm.toLowerCase())) {
      violations.push({ name, license: norm || '(none)', reason: 'missing/unknown license — fails closed' });
    } else if (!licenseAllowed(norm, allow)) {
      violations.push({ name, license: norm, reason: `license '${norm}' is not in the allowlist` });
    }
  }
  return { ok: violations.length === 0, violations };
}

/** The effective allowlist: forge.json `license.allow` when valid, else the default. */
export function resolveAllowlist(config) {
  const allow = config?.license?.allow;
  if (Array.isArray(allow) && allow.length > 0 && allow.every((x) => typeof x === 'string' && x.trim())) {
    return allow.map((x) => x.trim());
  }
  return [...DEFAULT_ALLOWLIST];
}

async function readJson(path) {
  const raw = await readFile(path, 'utf8').catch(() => null);
  if (raw === null) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

/**
 * Validate the plugin's own license declaration (AC.2): a LICENSE file exists at
 * the repo root, and package.json + plugin/.claude-plugin/plugin.json declare a
 * license consistent with it (`expected`, MIT). plugin.json is only enforced when
 * present, so this check is meaningful in a consumer repo too. Returns
 * { ok, problems[], pkgLicense, pluginLicense }.
 */
export async function checkPluginLicense(cwd, { expected = EXPECTED_LICENSE } = {}) {
  const problems = [];
  const licenseText = await readFile(resolve(cwd, 'LICENSE'), 'utf8').catch(() => null);
  if (licenseText === null) problems.push('no LICENSE file at the repo root');
  else if (expected === 'MIT' && !/\bMIT License\b/i.test(licenseText)) {
    problems.push('LICENSE file does not declare the MIT License');
  }

  const pkg = await readJson(resolve(cwd, 'package.json'));
  const pkgLicense = pkg && typeof pkg.license === 'string' ? pkg.license : null;
  if (pkgLicense !== expected) problems.push(`package.json license ${pkgLicense ?? '(missing)'} != ${expected}`);

  const pluginJson = await readJson(resolve(cwd, 'plugin/.claude-plugin/plugin.json'));
  const pluginLicense = pluginJson && typeof pluginJson.license === 'string' ? pluginJson.license : null;
  // Only enforce plugin.json when the manifest exists (consumer repos have none).
  if (pluginJson && pluginLicense !== expected) {
    problems.push(`plugin.json license ${pluginLicense ?? '(missing)'} != ${expected}`);
  }

  return { ok: problems.length === 0, problems, pkgLicense, pluginLicense };
}

/**
 * Parse the exec result of `pnpm licenses list --json` defensively. Empty stdout
 * (a project with no reportable dependency licenses) is a clean, empty list; a
 * non-empty but unparseable payload fails closed with a note. Returns
 * { ok, licenses[] } or { ok:false, error }.
 */
export function parsePnpmResult(res) {
  const stdout = (res?.stdout ?? '').trim();
  if (!stdout) return { ok: true, licenses: [] };
  try {
    return { ok: true, licenses: parseLicenses(JSON.parse(stdout)) };
  } catch {
    return { ok: false, error: 'could not parse `pnpm licenses list --json` output — failing closed' };
  }
}

/**
 * Run the license-compliance gate. Degrades gracefully (AC.3): with no
 * package.json it is not a pnpm/node project, so it SKIPS (a clear note, not a
 * crash). Otherwise it validates the plugin's own license (AC.2) and every
 * installed dependency license against the allowlist (AC.1). Returns
 * { ok, skipped?, violations, plugin, allowlist }.
 */
export async function runLicenseGate({ cwd, execFn = run, log = console.log, config = null, expected = EXPECTED_LICENSE } = {}) {
  // AC.3 — no package.json → not a node project; skip rather than fail/crash.
  const pkgRaw = await readFile(resolve(cwd, 'package.json'), 'utf8').catch(() => null);
  if (pkgRaw === null) {
    log('license: no package.json — not a pnpm/node project, skipping');
    return { ok: true, skipped: true, violations: [], plugin: null, allowlist: [] };
  }

  let cfg = config;
  if (cfg == null) {
    const loaded = await loadConfig(cwd).catch(() => null);
    cfg = loaded?.config ?? null;
  }
  const allowlist = resolveAllowlist(cfg);

  // AC.2 — the plugin's own license declaration.
  const plugin = await checkPluginLicense(cwd, { expected });
  for (const p of plugin.problems) log(`x plugin-license: ${p}`);

  // AC.1 — installed dependency licenses via the injected exec (no real pnpm in tests).
  const res = await execFn('pnpm', ['licenses', 'list', '--json'], { cwd });
  const parsed = parsePnpmResult(res);
  let violations = [];
  if (!parsed.ok) {
    violations = [{ name: '(pnpm)', license: '(unparseable)', reason: parsed.error }];
  } else {
    violations = evaluate(parsed.licenses, allowlist).violations;
  }

  for (const v of violations) log(`x ${v.name}: ${v.license} — ${v.reason}`);
  const ok = plugin.ok && violations.length === 0;
  if (ok) {
    log(`license: clean — plugin declares ${expected}; all dependency licenses within the allowlist (${allowlist.length} ids)`);
  } else {
    log(`license: ${plugin.problems.length} plugin-declaration issue(s), ${violations.length} disallowed/unknown dependency license(s) — fix or extend license.allow before shipping`);
  }
  return { ok, violations, plugin, allowlist };
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  runLicenseGate({ cwd: process.cwd() }).then((res) => process.exit(res.ok ? 0 : 1));
}
