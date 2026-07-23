import { describe, it, expect } from 'vitest';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runRunnerInit, parseArgs } from '../plugin/scripts/runner/init.mjs';
import { fakeGh } from './helpers/fakegh.mjs';
import { nextBackoff } from '../runner/linux/supervisor.mjs';

const noop = () => {};
const PRIVATE = { stdout: JSON.stringify({ isPrivate: true, owner: { login: 'dngioidev' }, name: 'forge' }) };
const privateRoutes = () => [[(j) => j.startsWith('repo view'), PRIVATE]];

async function scaffoldSupervisor() {
  const cwd = await mkdtemp(join(tmpdir(), 'forge-sup-'));
  const { gh } = fakeGh(privateRoutes());
  const res = await runRunnerInit({ gh, cwd }, parseArgs([]), noop);
  expect(res.ok).toBe(true);
  return readFile(join(cwd, 'runner', 'linux', 'supervisor.mjs'), 'utf8');
}

// #234 — a persistent build/container failure must trigger a bounded back-off,
// not a per-attempt JIT mint. These assert on the SCAFFOLDED supervisor (the
// asset an operator actually runs) that a non-zero container exit is treated as
// a failure and that a back-off applies to ALL failures, not just mint failure.
describe('#234 — supervisor backs off on build/container failure', () => {
  it('a non-zero container exit is wired to failure (return res.ok, not return true)', async () => {
    const sup = await scaffoldSupervisor();
    // runOneJob returns the container result's ok, so a non-zero exit == failure.
    expect(sup).toContain('return res.ok');
    // the old unconditional success is gone (isolate runOneJob's container tail).
    const runOne = sup.slice(sup.indexOf('async function runOneJob'), sup.indexOf('async function worker'));
    expect(runOne).not.toMatch(/return true;/);
  });

  it('the worker backs off on ANY failure, escalating and capped — not only on mint failure', async () => {
    const sup = await scaffoldSupervisor();
    // back-off is escalating via the pure helper and reset on success.
    expect(sup).toContain('nextBackoff');
    expect(sup).toContain('BACKOFF_CAP_MS');
    // the old comment scoping back-off to mint failure only is gone.
    expect(sup).not.toContain('back off on mint failure');
    // a consecutive-failure log line so the operator sees it is stuck.
    expect(sup).toMatch(/consecutive failure/i);
    // secret handling preserved: PAT/JIT never logged.
    expect(sup).not.toMatch(/log\([^)]*\$\{(PAT|minted\.jit|jit)\}/);
  });
});

// The back-off refactored into a pure helper is unit-tested directly.
describe('#234 — nextBackoff (pure)', () => {
  it('starts at 10s from no prior failure', () => {
    expect(nextBackoff(0)).toBe(10_000);
    expect(nextBackoff()).toBe(10_000);
  });

  it('doubles each consecutive failure', () => {
    expect(nextBackoff(10_000)).toBe(20_000);
    expect(nextBackoff(20_000)).toBe(40_000);
    expect(nextBackoff(40_000)).toBe(80_000);
  });

  it('is capped at 5 minutes so a stuck host cannot churn the API', () => {
    expect(nextBackoff(200_000)).toBe(300_000);
    expect(nextBackoff(300_000)).toBe(300_000);
    expect(nextBackoff(10_000_000)).toBe(300_000);
  });

  it('grows monotonically to the cap and never exceeds it', () => {
    let b = 0;
    for (let i = 0; i < 20; i++) {
      const next = nextBackoff(b);
      expect(next).toBeGreaterThanOrEqual(b);
      expect(next).toBeLessThanOrEqual(300_000);
      b = next;
    }
    expect(b).toBe(300_000);
  });
});
