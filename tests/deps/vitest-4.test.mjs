import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// #339: vitest 3 -> 4 migration. This is the durable, machine-checkable half of
// AC.1 ("vitest is on 4.x ... with the agy-emit timeout resolved at the root, not
// merely a blanket testTimeout bump") — it fails a future PR that either downgrades
// vitest again or "fixes" a slow-test flake by quietly widening the timeout instead
// of root-causing it.
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

describe('AC-339.1: vitest is on the 4.x major, and the Windows agy-emit slowdown was root-caused', () => {
  it('AC-339.1: package.json pins vitest to the 4.x major', async () => {
    const pkg = JSON.parse(await readFile(join(repoRoot, 'package.json'), 'utf8'));
    const spec = pkg.devDependencies.vitest;
    expect(spec).toMatch(/^\^?4\./);
  });

  it('AC-339.1: the installed vitest resolves to a real 4.x release', async () => {
    const installed = JSON.parse(await readFile(join(repoRoot, 'node_modules', 'vitest', 'package.json'), 'utf8'));
    expect(installed.version.startsWith('4.')).toBe(true);
  });

  it('AC-339.1: testTimeout/hookTimeout were NOT bumped past the #251 baseline to paper over the v4 slowdown', async () => {
    // #251 set these to 30000 for a slower self-hosted runner. If a future change
    // "fixes" the v4 Windows slowdown by pushing this number up instead of fixing
    // the actual spawn cost, that is exactly the non-root-cause fix AC.1 forbids.
    const cfg = await readFile(join(repoRoot, 'vitest.config.mjs'), 'utf8');
    expect(cfg).toMatch(/testTimeout:\s*30000/);
    expect(cfg).toMatch(/hookTimeout:\s*30000/);
  });

  it('AC-339.1: the spawn-heavy agy-deny emit case fires its independent child processes concurrently, not serially', async () => {
    // The root-cause fix for the ~3x Windows slowdown (originally six sequential
    // `node` spawns, each paying Windows' expensive CreateProcess cost on the
    // critical path; #429 added a seventh independent case for the new
    // allow/ask default): run the independent spawns concurrently. This guards
    // against someone reverting to sequential awaits and silently reintroducing
    // the timeout risk.
    const test = await readFile(join(repoRoot, 'tests', 'agy', 'emit.test.mjs'), 'utf8');
    const caseText = test.slice(
      test.indexOf("it('AC-289.2: denies force-push"),
      test.indexOf("it('AC-289.2: fails OPEN"),
    );
    expect(caseText).toContain('Promise.all([');
    // exactly one `await` drives all runNode() spawns (the Promise.all), not one per spawn.
    expect((caseText.match(/await runNode\(/g) ?? []).length).toBe(0);
    expect((caseText.match(/runNode\(/g) ?? []).length).toBe(7);
  });
});
