import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const spikePath = join(repoRoot, 'docs', 'spikes', '2026-08-13-argv-tokenize-model.md');
const routeIndexPath = join(repoRoot, 'docs', 'README.md');
const denylistPath = join(repoRoot, 'plugin', 'hooks', 'denylist.mjs');

describe('#451 — tokenize-then-judge argv model spike', () => {
  it('AC-451.1: the spike states the tokenizer design and the boundary of what it refuses to model', async () => {
    const doc = await readFile(spikePath, 'utf8');
    expect(doc).toMatch(/## 1\. Design — tokenize-then-judge/);
    // the token kinds the design commits to
    expect(doc).toContain("'word' | 'assignment' | 'separator' | 'ddash' | 'substitution' | 'unresolved-brace'");
    // explicit refusals, not silently left implicit
    expect(doc).toMatch(/explicitly refuses to model/);
    expect(doc).toContain('Brace expansion');
    expect(doc).toMatch(/Filesystem-backed path resolution/);
  });

  it('AC-451.2: the path-resolution scope decision is made and grounded in real (bash-independent) evidence, not defaulted', async () => {
    const doc = await readFile(spikePath, 'utf8');
    expect(doc).toMatch(/## 2\. Path-resolution scope/);
    expect(doc).toContain('path.posix.normalize');
    expect(doc).toContain('../prod-secrets');
    expect(doc).toMatch(/\*\*Decision: \(b\), lexical normalisation/);
    // The judge rule must be the one that PRESERVES AC-446.1, and the tempting
    // leading-component variant must be recorded as rejected rather than
    // quietly dropped — adversarial review caught the first draft proposing a
    // rule that would have regressed a pinned test.
    expect(doc).toContain('AC-446.1');
    expect(doc).toMatch(/variant is wrong and is rejected here/);
    // The symlink cost is stated as a real, reachable limitation (pnpm's own
    // node_modules layout), not waved away as needing a planted symlink.
    expect(doc).toMatch(/pnpm/);
    expect(doc).toMatch(/no attacker required/);
  });

  it('AC-451.3: a subsumption matrix covers all six sibling tickets with a verdict and evidence for each', async () => {
    const doc = await readFile(spikePath, 'utf8');
    expect(doc).toMatch(/## 3\. Subsumption matrix/);
    for (const n of ['#451', '#452', '#454', '#456', '#448', '#449']) {
      expect(doc, n).toContain(n);
    }
    expect(doc).toMatch(/\*\*Closed\*\*/);
    // The corrected count, after adversarial review downgraded #449 and #452.
    // Pinned explicitly so a later edit cannot quietly re-inflate the claim
    // back toward "one rewrite retires six tickets".
    expect(doc).toMatch(/one rewrite does not retire six tickets/);
    expect(doc).toMatch(/2 cleanly closed \(#454, #456\)/);

    // Pin the two DOWNGRADED verdicts to their own matrix rows, not to a bare
    // "Partially closed" appearing anywhere in the doc — #448 was already
    // partial before the review, so a generic match would still pass if #449
    // or #452 were quietly re-inflated back to "Closed". Locate each row by
    // its leading ticket cell, then assert that row's own verdict text.
    const row = (ticket) => {
      const line = doc.split('\n').find((l) => l.startsWith(`| **${ticket}**`));
      expect(line, `matrix row for ${ticket}`).toBeTruthy();
      return line;
    };
    expect(row('#449')).toMatch(/Partially closed/);
    expect(row('#449')).toMatch(/Downgraded from "Closed"/);
    expect(row('#452')).toMatch(/Split verdict/);
    expect(row('#452')).toMatch(/does NOT/);
    expect(row('#448')).toMatch(/Partially closed/);

    // #452's AC.4 scope caveat — the round-1 reviewer minor finding. Pinned so
    // the caveat cannot be dropped again without failing here.
    expect(row('#452')).toMatch(/AC\.4/);
    expect(row('#452')).toMatch(/#453/);
  });

  it('AC-451.4: the #452 mutual-exclusivity question is answered with evidence, not asserted', async () => {
    const doc = await readFile(spikePath, 'utf8');
    expect(doc).toMatch(/## 4\. #452's mutual exclusivity/);
    expect(doc).toMatch(/forced-choice artifact/i);
    // Tokenization dissolves the REPORTED artifact and exposes a real
    // question about what AC-446.6 actually tests. But the doc must NOT
    // overclaim that as unsatisfiable — round-2 security review falsified
    // that, and the withdrawal must stay visible rather than being quietly
    // reworded away.
    expect(doc).toMatch(/AC-446\.1[\s\S]{0,300}AC-446\.6|AC-446\.6[\s\S]{0,300}AC-446\.1/);
    expect(doc).toMatch(/A separating rule does exist/);
    expect(doc).toMatch(/that was wrong/);
    expect(doc).toMatch(/is withdrawn/);
    // ...and the cost that makes it a tradeoff rather than a free win, which
    // the review did not surface and the spike measured for itself.
    expect(doc).toMatch(/spelling-dependence|spelling-dependent/);
    // The over-block-accident finding DOES survive the correction — keep it
    // pinned so the withdrawal doesn't take the valid part with it.
    expect(doc).toMatch(/over-block accident/);
  });

  it('AC-451.4: the new live bypass found while testing the matrix is reported and filed, not silently dropped', async () => {
    const doc = await readFile(spikePath, 'utf8');
    // `rm -r$(true)f` — a substitution fused mid-word truncates the flag
    // cluster's letter run. Verified against check() during the spike.
    expect(doc).toContain('#459');
    expect(doc).toMatch(/live bypass/);
  });

  it('AC-451.5: a migration plan names the regression corpus and phases the work, no big-bang swap', async () => {
    const doc = await readFile(spikePath, 'utf8');
    expect(doc).toMatch(/## 5\. Migration plan/);
    expect(doc).toContain('AC-429.*');
    expect(doc).toContain('AC-437.*');
    expect(doc).toContain('AC-446.*');
    expect(doc).toContain('AC-450.*');
    expect(doc).toMatch(/Phase 1/);
    expect(doc).toMatch(/Phase 4/);
    // The safe-target semantics question must be surfaced to the owner before
    // the port — stated as a decision to settle early, NOT (as an earlier
    // draft had it) an unsatisfiable hard blocker. Both halves are pinned:
    // the gate exists, and it is not a blocker.
    expect(doc).toMatch(/Decide §4's safe-target question before writing the port/);
    expect(doc).toMatch(/not a blocker/);
    expect(doc).toMatch(/Phase 2 is not blocked/);
    expect(doc).toMatch(/Three live options/);
  });

  it('AC-451.6: the recommendation weighs the tripwire-not-boundary and no-auto-approve facts honestly before recommending', async () => {
    const doc = await readFile(spikePath, 'utf8');
    expect(doc).toMatch(/## 6\. Recommendation/);
    expect(doc).toMatch(/fails open/);
    expect(doc).toMatch(/tripwire/);
    expect(doc).toMatch(/no host currently auto-approves any of the six commands/i);
    // "don't do it at all" must stay a live, argued option, not a token nod
    expect(doc).toMatch(/don't do it at all/);
    expect(doc).toMatch(/It remains defensible|remains defensible/);
  });

  it('AC-451.7: the follow-up tickets were filed under #182 and are named in the spike', async () => {
    const doc = await readFile(spikePath, 'utf8');
    expect(doc).toContain('**#457**');
    expect(doc).toContain('**#459**');
    expect(doc).toMatch(/Phase 1 only/);
    expect(doc).toMatch(/six sibling tickets stay open/);
  });

  it('the spike doc is linked from the docs route index', async () => {
    const index = await readFile(routeIndexPath, 'utf8');
    expect(index).toContain('spikes/2026-08-13-argv-tokenize-model.md');
  });

  it('this is genuinely a spike: no production hook source was touched (superseded, #449)', async () => {
    // The spike's whole premise was "design and decide, do not implement" —
    // this originally pinned that denylist.mjs had NO tokenizer/token-kind
    // vocabulary wired in, so a PR that quietly slipped implementation into
    // the #451 SPIKE's own branch would trip this rather than pass silently.
    // #449 is the sanctioned, separately-ticketed integration this spike's
    // own §5 migration plan and subsumption matrix (§3) always named as a
    // later, independent step — not a quiet slip into the spike itself — so
    // the "no tokenizer vocabulary at all" half of this assertion no longer
    // holds and is corrected here rather than left permanently red.
    // `unresolved-brace` stays pinned absent: that's #448's own Phase-2-style
    // vocabulary (brace-adjacent flag detection), which #449 does not touch
    // or need — its scope is #449's own AC-449.1..4, not #448's.
    const src = await readFile(denylistPath, 'utf8');
    expect(src).toContain('shell-tokenize');
    expect(src).not.toContain('unresolved-brace');
  });
});
