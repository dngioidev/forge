import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const bin = join(root, 'plugin', 'bin', 'forge');

function bashAvailable() {
  try { execFileSync('bash', ['-c', 'true'], { stdio: 'ignore' }); return true; } catch { return false; }
}
const HAS_BASH = bashAvailable();
const dry = (args) => execFileSync('bash', [bin, ...args], { env: { ...process.env, FORGE_DRY: '1' }, encoding: 'utf8' }).trim();

describe('forge dispatcher (#150)', () => {
  it('is a bash script with a usage block and the FORGE_DRY hook', () => {
    const s = readFileSync(bin, 'utf8');
    expect(s.startsWith('#!/usr/bin/env bash')).toBe(true);
    expect(s).toMatch(/FORGE_DRY/);
    expect(s).toMatch(/areas: board/);
  });

  it.runIf(HAS_BASH)('resolves two-level areas to scripts/<area>/<cmd>.mjs', () => {
    expect(dry(['board', 'create', '--title', 'x'])).toMatch(/scripts\/board\/create\.mjs --title x$/);
    expect(dry(['gate', 'docsync', '--base', 'main'])).toMatch(/scripts\/gates\/docsync\.mjs --base main$/);
    expect(dry(['autopilot', 'select', '--dry-run'])).toMatch(/scripts\/autopilot\/select\.mjs --dry-run$/);
  });

  it.runIf(HAS_BASH)('resolves single-level init/doctor/release', () => {
    expect(dry(['init', '--project', '8'])).toMatch(/scripts\/init\.mjs --project 8$/);
    expect(dry(['doctor'])).toMatch(/scripts\/doctor\.mjs$/);
    expect(dry(['release', '--dry-run'])).toMatch(/scripts\/release\/release\.mjs --dry-run$/);
  });

  it.runIf(HAS_BASH)('fails fast: no args, unknown area, missing command, missing script', () => {
    expect(() => execFileSync('bash', [bin], { stdio: 'ignore' })).toThrow();               // no args
    expect(() => execFileSync('bash', [bin, 'bogus'], { stdio: 'ignore' })).toThrow();       // unknown area
    expect(() => execFileSync('bash', [bin, 'board'], { stdio: 'ignore' })).toThrow();       // missing command
    expect(() => execFileSync('bash', [bin, 'board', 'nope'], { stdio: 'ignore' })).toThrow(); // missing script
  });
});
