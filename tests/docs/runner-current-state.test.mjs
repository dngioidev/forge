import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const adr0006Path = join(repoRoot, 'docs', 'decisions', '0006-runner-ui.md');
const adr0005Path = join(repoRoot, 'docs', 'decisions', '0005-local-self-hosted-runner.md');
const adoptionPath = join(repoRoot, 'docs', 'guides', 'runner-adoption.md');
const readmePath = join(repoRoot, 'docs', 'README.md');

describe('#462 — ADR-0006/0005 and runner-adoption assert self-hosted CI as current state after #426', () => {
  describe('AC-462.1: 0006-runner-ui.md no longer asserts unscoped present-tense runner-enabled state', () => {
    it('carries a post-#426 annotation scoping the runner fleet to the private-fork case', async () => {
      const adr = await readFile(adr0006Path, 'utf8');
      expect(adr).toMatch(/#426/);
      expect(adr).toMatch(/hosted-only|hosted GitHub-hosted runners|GitHub-hosted runners/i);
      expect(adr).toMatch(/private-fork/i);
    });

    it('the annotation appears before the present-tense grounded-facts claims it scopes', async () => {
      const adr = await readFile(adr0006Path, 'utf8');
      const annotationIdx = adr.search(/#426/);
      const alreadyRunsIdx = adr.indexOf('already runs');
      expect(annotationIdx).toBeGreaterThan(-1);
      expect(alreadyRunsIdx).toBeGreaterThan(-1);
      expect(annotationIdx).toBeLessThan(alreadyRunsIdx);
    });
  });

  describe('AC-462.2: 0005-local-self-hosted-runner.md Status records #426 superseded it in practice for this repo', () => {
    it('the Status line (near the top) mentions #426, "superseded", and "private-fork"', async () => {
      const adr = await readFile(adr0005Path, 'utf8');
      const header = adr.slice(0, adr.indexOf('## Context'));
      expect(header).toMatch(/#426/);
      expect(header).toMatch(/superseded/i);
      expect(header).toMatch(/private-fork/i);
    });

    it('the decision body and reasoning are not rewritten (Decision 1 heading text is unchanged)', async () => {
      const adr = await readFile(adr0005Path, 'utf8');
      expect(adr).toMatch(
        /### Decision 1 — PAT \/ secret handling \(critical\) → \*\*RECOMMEND: JIT ephemeral registration/
      );
    });
  });

  describe('AC-462.3: runner-adoption.md states near the top this repo is hosted-only since #426', () => {
    it('the opening section mentions #426, "hosted-only", "private", and cross-links verify.yml', async () => {
      const guide = await readFile(adoptionPath, 'utf8');
      const opening = guide.slice(0, guide.indexOf('## When to use it'));
      expect(opening).toMatch(/#426/);
      expect(opening).toMatch(/hosted-only/i);
      expect(opening).toMatch(/private repos?|private forks?/i);
      expect(opening).toMatch(/verify\.yml/);
    });
  });

  describe('AC-462.4: docs/README.md route-index lines for ADR-0005/0006 do not describe superseded state as live', () => {
    it('the ADR-0005 route-index line does not claim the runner is currently enabled/live', async () => {
      const index = await readFile(readmePath, 'utf8');
      const line = index.split('\n').find((l) => l.includes('ADR-0005'));
      expect(line).toBeTruthy();
      expect(line).not.toMatch(/currently (enabled|running|live)/i);
    });

    it('the ADR-0006 route-index line does not claim the runner fleet is currently live', async () => {
      const index = await readFile(readmePath, 'utf8');
      const line = index.split('\n').find((l) => l.includes('ADR-0006'));
      expect(line).toBeTruthy();
      expect(line).not.toMatch(/currently (enabled|running|live)/i);
    });
  });

  it('AC-462.5: this plan is linked from the docs route index', async () => {
    const index = await readFile(readmePath, 'utf8');
    expect(index).toContain('plans/2026-08-16-462-runner-current-state.md');
  });
});
