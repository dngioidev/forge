import { describe, it, expect } from 'vitest';
import {
  parseRunnerRelease,
  parsePinnedVersion,
  compareVersions,
  fetchRunnerPin,
  FALLBACK_RUNNER_PIN,
} from '../../plugin/scripts/lib/runner-release.mjs';
import { fakeGh } from '../helpers/fakegh.mjs';

const LINUX = 'a'.repeat(64);
const WIN = 'b'.repeat(64);
const body = (v = '2.340.0') =>
  `- actions-runner-linux-x64-${v}.tar.gz <!-- BEGIN SHA linux-x64 -->${LINUX}<!-- END SHA linux-x64 -->\n` +
  `- actions-runner-win-x64-${v}.zip <!-- BEGIN SHA win-x64 -->${WIN}<!-- END SHA win-x64 -->`;

describe('runner-release — #233 parsing + pinning', () => {
  it('parseRunnerRelease strips the v prefix and extracts both SHAs (lowercased)', () => {
    // uppercase SHAs (markers stay lowercase, as GitHub publishes them) → lowercased out
    const upper = `<!-- BEGIN SHA linux-x64 -->${LINUX.toUpperCase()}<!-- END SHA linux-x64 -->\n` +
      `<!-- BEGIN SHA win-x64 -->${WIN.toUpperCase()}<!-- END SHA win-x64 -->`;
    const pin = parseRunnerRelease('v2.340.0', upper);
    expect(pin).toEqual({ version: '2.340.0', linux: LINUX, win: WIN });
  });

  it('parseRunnerRelease → null when a SHA marker or a valid version is missing', () => {
    expect(parseRunnerRelease('v2.340.0', 'no markers here')).toBe(null);
    expect(parseRunnerRelease('not-a-version', body())).toBe(null);
  });

  it('parsePinnedVersion reads the Dockerfile ARG and the ps1 param', () => {
    expect(parsePinnedVersion('FROM node\nARG RUNNER_VERSION=2.336.0\n')).toBe('2.336.0');
    expect(parsePinnedVersion("[string]$RunnerVersion = '2.328.0',")).toBe('2.328.0');
    expect(parsePinnedVersion(null)).toBe(null);
    expect(parsePinnedVersion('nothing pinned')).toBe(null);
  });

  it('compareVersions orders semver-ish versions', () => {
    expect(compareVersions('2.300.0', '2.340.0')).toBe(-1);
    expect(compareVersions('2.340.0', '2.340.0')).toBe(0);
    expect(compareVersions('2.341.0', '2.340.0')).toBe(1);
    expect(compareVersions('2.9.0', '2.10.0')).toBe(-1); // numeric, not lexical
  });

  it('fetchRunnerPin returns a live pin from the release endpoint', async () => {
    const { gh } = fakeGh([
      [(j) => j.startsWith('api repos/actions/runner/releases/latest'),
        { stdout: JSON.stringify({ tag_name: 'v2.340.0', body: body('2.340.0') }) }],
    ]);
    const pin = await fetchRunnerPin(gh);
    expect(pin).toMatchObject({ version: '2.340.0', linux: LINUX, win: WIN, source: 'live' });
  });

  it('fetchRunnerPin degrades to the real fallback pin (never a placeholder) + warns on gh failure', async () => {
    const logs = [];
    const { gh } = fakeGh([
      [(j) => j.startsWith('api repos/actions/runner/releases/latest'), { ok: false, stderr: 'boom' }],
    ]);
    const pin = await fetchRunnerPin(gh, (m) => logs.push(String(m)));
    expect(pin).toMatchObject({ ...FALLBACK_RUNNER_PIN, source: 'fallback' });
    expect(pin.linux).toMatch(/^[0-9a-f]{64}$/);
    expect(pin.win).toMatch(/^[0-9a-f]{64}$/);
    expect(logs.join('\n')).toMatch(/could not resolve the current actions\/runner release/);
  });
});
