import { describe, it, expect } from 'vitest';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (rel) => readFile(join(root, rel), 'utf8');

// #467: autopilot/SKILL.md was 75,603 bytes (~18.5k tokens) at the start of this
// delivery — grown from the ticket's cited 49,195 by #517/#523 landing after
// filing — 3x the next-largest skill and loaded in full at every invoke. AC-2
// relocates the two sections the ticket identifies as pure lookup (Driver
// scripts; the deep mechanics/field-evidence half of Monitor notifications)
// into `plugin/skills/autopilot/reference/*.md`, linked from SKILL.md at their
// original position. Mandatory-procedure sections are untouched.
describe('forge:autopilot skill size (#467)', () => {
  it('AC-467.1: the agy emit path bundles plugin/skills/autopilot/reference/*.md — agy is not reference-blind', async () => {
    const { emitAgyPlugin } = await import('../../plugin/scripts/agy/emit.mjs');
    const dest = await mkdtemp(join(tmpdir(), 'agy-467-'));
    try {
      const res = await emitAgyPlugin({ destRoot: dest, log: () => {} });
      expect(res.ok).toBe(true);
      const driverRef = await readFile(join(dest, 'skills', 'autopilot', 'reference', 'driver-scripts.md'), 'utf8');
      const monitorRef = await readFile(join(dest, 'skills', 'autopilot', 'reference', 'monitor-notifications.md'), 'utf8');
      // real content, not an empty placeholder — the full lookup detail survives the copy
      expect(driverRef).toMatch(/selectNext\(tickets\)/);
      expect(monitorRef).toMatch(/Field evidence \(2026-08-11\/13 run\)/);
    } finally {
      await rm(dest, { recursive: true, force: true });
    }
  });

  it('AC-467.2: SKILL.md links to both reference docs, and every mandatory-procedure section stays inline (not reduced to a pointer)', async () => {
    const s = await read('plugin/skills/autopilot/SKILL.md');
    // #467 reviewer round 1: a hardcoded `plugin/`-prefixed path doesn't resolve
    // for a real plugin install (cwd is the TARGET repo, not this checkout) or
    // for the agy-emitted package (emit.mjs strips the plugin/ prefix on copy).
    // The file's own established convention is ${CLAUDE_PLUGIN_ROOT}-prefixed
    // (e.g. line ~132's perms.mjs invocation) — pin that convention here too.
    expect(s).not.toMatch(/[`(]plugin\/skills\/autopilot\/reference\//);
    expect(s).toMatch(/\$\{CLAUDE_PLUGIN_ROOT\}\/skills\/autopilot\/reference\/driver-scripts\.md/);
    expect(s).toMatch(/\$\{CLAUDE_PLUGIN_ROOT\}\/skills\/autopilot\/reference\/monitor-notifications\.md/);
    // the ticket's own "do NOT move" list — each still has its full procedural body inline,
    // not just a heading. Spot-check a load-bearing sentence from each, not just the title.
    expect(s).toMatch(/mergeAuthPreflight\(\{\s*authorized,\s*config\s*\}\)/); // Merge-authorization preflight
    expect(s).toMatch(/DEFAULT_LOW_WATER/); // Rate-budget preflight
    expect(s).toMatch(/local Claude settings allowlist|allowlist alone/i); // Permissions
    expect(s).toMatch(/six probes/); // Environment preflight
    expect(s).toMatch(/5-hour session usage window/); // Session-window self-pause
    expect(s).toMatch(/Return-then-resume watchdog/); // full watchdog section, not summarized away
    expect(s).toMatch(/stalled-before-pr/i);
  });

  it('AC-467.3: rationale relocated out of SKILL.md is verifiably present (not deleted) in the reference docs', async () => {
    const skill = await read('plugin/skills/autopilot/SKILL.md');
    const driverRef = await read('plugin/skills/autopilot/reference/driver-scripts.md');
    const monitorRef = await read('plugin/skills/autopilot/reference/monitor-notifications.md');
    // the deep outbox mechanism detail moved out of SKILL.md...
    expect(skill).not.toMatch(/outbox\.lock.*deliberately separate from any future/s);
    // ...and landed intact in the reference doc, not dropped
    expect(monitorRef).toMatch(/outbox\.lock.*deliberately separate from any future/s);
    // forge-agents' honest-limit narrative: moved, not deleted
    expect(skill).not.toMatch(/Honest limit — the cooperation dependency/);
    expect(monitorRef).toMatch(/honest limit/i);
    // driver-scripts full per-script rationale: moved, not deleted
    expect(skill).not.toMatch(/reducing the 3 idle CI-status pollers/);
    expect(driverRef).toMatch(/reducing the 3 idle CI-status pollers/);
    // #467 reviewer round 1 found these three sentences dropped from BOTH files
    // (silently deleted, not relocated) — regression-pin each into the reference
    // doc so a future edit can't drop them again without a red test.
    expect(monitorRef).toMatch(/the recovery itself \(§ Auto-merge item 4\) still runs inside the delivery subagent's own merge-bar check/);
    expect(monitorRef).toMatch(/where it runs the full gate pipeline again/);
    expect(monitorRef).toMatch(/mirroring `ci-watch\.mjs`'s `writeCiWatchState` never-fail-the-caller contract/);
    expect(monitorRef).toMatch(/Staleness keys on `lastArtifactAt`/);
    // #467 reviewer round 2 found a fourth dropped clause (SKILL.md's AC.5
    // paragraph trimmed two explanatory clauses with nowhere to land) —
    // restored verbatim inline (this one stayed inline, not relocated).
    expect(skill).toMatch(/there is no report for a subagent that never returned, so there is nothing here for the watchdog to consume/);
    expect(skill).toMatch(/The `forge-agents` line is exactly what it says: a notice surfaced to the \(blocked\) main loop while the spawn is still in flight/);
    // the "Honest limit" bold lead-in itself, dropped when converted to a heading
    expect(monitorRef).toMatch(/\*\*Honest limit — the cooperation dependency, not quietly shipped\.\*\*/);
  });

  it('AC-467.4: every tests/skills/autopilot.test.mjs assertion still targets content actually present in SKILL.md', async () => {
    // Regression guard for AC-4: relocated content must never leave a stale
    // assertion passing against text that no longer lives in SKILL.md. The
    // full existing suite is the real check (run as part of `verify`); this
    // is a fast smoke re-assertion of the specific literals this ticket's
    // edit touched, so a future edit to either section can't silently drift.
    const s = await read('plugin/skills/autopilot/SKILL.md');
    expect(s).toMatch(/CI <state> on PR #<n> \(<branch>\)/);
    expect(s).toMatch(/Decision <id> \(#<issue>\) resolved/);
    expect(s).toMatch(/`envpreflight\.mjs`/);
    expect(s).toMatch(/classifyLiveness/);
    expect(s).toMatch(/\.forge\/agents/);
    expect(s).toMatch(/never calls `resolveReturnedTicket`/);
    expect(s).toMatch(/#474/);
    expect(s).toMatch(/DEFAULT_STALE_MS/);
    expect(s).toMatch(/60 minutes/i);
  });

  it('AC-467.5: measured size reduction — SKILL.md is smaller than its pre-delivery size, with the cut content relocated not lost', async () => {
    const s = await read('plugin/skills/autopilot/SKILL.md');
    const bytes = Buffer.byteLength(s, 'utf8');
    // 75,603 bytes measured at the start of this delivery (#517/#523 grew it
    // past the ticket's cited 49,195). A real, meaningful cut — not a rounding change.
    expect(bytes).toBeLessThan(70000);
    const driverRef = await read('plugin/skills/autopilot/reference/driver-scripts.md');
    const monitorRef = await read('plugin/skills/autopilot/reference/monitor-notifications.md');
    expect(driverRef.length).toBeGreaterThan(1000);
    expect(monitorRef.length).toBeGreaterThan(1000);
  });
});

// #561: 69,998 bytes measured at filing time — 2 bytes of headroom under the
// same 70000 ceiling above, so any doc change (a sentence, a table row) failed
// `pnpm verify`. #557's reviewer had two documentation-discoverability notes
// left unfixed for exactly this reason. Picked extraction to reference docs
// (the established #467 pattern) over raising the ceiling, because the
// ceiling's purpose (#467) is bounding what loads into context on every
// autopilot invocation, not bounding total documentation — raising the number
// would have defeated that purpose. Two new reference docs
// (`reference/watchdog-history.md`, `reference/rate-budget-history.md`) hold
// the #319/#464/#474/#522 watchdog archaeology and the #407/#517/#526/#530
// rate-budget history that made up most of the file's growth; the
// `driver-scripts.md` reference gained the #488 loop-backstop archaeology.
// Measured: SKILL.md 69,998 -> 61,621 bytes (headroom 2 -> 8,379 under the
// unchanged 70000 ceiling); mandatory-procedure content (every AC-467.2/.3/.4
// literal above) is unchanged, only relocatable rationale moved.
describe('forge:autopilot skill size (#561)', () => {
  it('AC-561.1: appending a modest, realistic doc paragraph no longer trips the size gate', async () => {
    const s = await read('plugin/skills/autopilot/SKILL.md');
    // A realistic doc addition an ordinary ticket might make — a new bullet
    // documenting a follow-up behavior, comparable in size to existing bullets
    // in the file. Before #561 (69,998 bytes + this paragraph) this failed;
    // after #561's extraction there is real headroom for it.
    const realisticAddition =
      '\n\n## Example follow-up doc addition (regression fixture, not a real section)\n\n' +
      '- **A new operational note a future ticket might add.** This paragraph stands in for ' +
      'the kind of ordinary doc maintenance that used to fail `pnpm verify` outright when the ' +
      'file sat only 2 bytes under its ceiling — a single new bullet documenting a behavior, ' +
      'a cross-reference, or a clarification, the everyday shape of a doc-touching PR, not a ' +
      'wholesale rewrite of the skill.\n';
    expect(Buffer.byteLength(realisticAddition, 'utf8')).toBeGreaterThan(200);
    const withAddition = Buffer.byteLength(s + realisticAddition, 'utf8');
    expect(withAddition).toBeLessThan(70000);
  });

  it('AC-561.2 (AC-2): at least 8,000 bytes of headroom under the 70000-byte ceiling', async () => {
    const s = await read('plugin/skills/autopilot/SKILL.md');
    const bytes = Buffer.byteLength(s, 'utf8');
    const ceiling = 70000;
    expect(ceiling - bytes).toBeGreaterThanOrEqual(8000);
  });

  it('AC-561.3 (AC-4): the two new reference docs exist and hold real relocated content, not empty placeholders', async () => {
    const watchdogRef = await read('plugin/skills/autopilot/reference/watchdog-history.md');
    const rateBudgetRef = await read('plugin/skills/autopilot/reference/rate-budget-history.md');
    expect(watchdogRef.length).toBeGreaterThan(1000);
    expect(rateBudgetRef.length).toBeGreaterThan(1000);
    // spot-check real relocated content survived the move, not just a heading
    expect(watchdogRef).toMatch(/2026-08-11\/13 run had the warning in bold/);
    expect(watchdogRef).toMatch(/#469/);
    expect(watchdogRef).toMatch(/#472/);
    expect(rateBudgetRef).toMatch(/UNATTRIBUTED_DRAIN_FLOOR/);
    expect(rateBudgetRef).toMatch(/hit 2\/8.*hits 8\/8/s);
  });

  it('AC-561.4 (AC-4): SKILL.md links both new reference docs at the point content was relocated from', async () => {
    const s = await read('plugin/skills/autopilot/SKILL.md');
    expect(s).toMatch(/\$\{CLAUDE_PLUGIN_ROOT\}\/skills\/autopilot\/reference\/watchdog-history\.md/);
    expect(s).toMatch(/\$\{CLAUDE_PLUGIN_ROOT\}\/skills\/autopilot\/reference\/rate-budget-history\.md/);
    // same hardcoded-path mistake #467 caught (AC-467.2) must not recur for the new links
    expect(s).not.toMatch(/[`(]plugin\/skills\/autopilot\/reference\/watchdog-history/);
    expect(s).not.toMatch(/[`(]plugin\/skills\/autopilot\/reference\/rate-budget-history/);
  });

  it('AC-561.5 (AC-5): the two deferred #557 reviewer notes are addressed', async () => {
    const s = await read('plugin/skills/autopilot/SKILL.md');
    // note 1: the literal-string caveat now names the escalate.mjs -file flags
    // explicitly instead of a generic "--body-file" for that case
    expect(s).toMatch(/--reason-file/);
    expect(s).toMatch(/--context-file/);
    // note 2: board/SKILL.md's table gained the escalate.mjs row it never had
    const boardSkill = await read('plugin/skills/board/SKILL.md');
    expect(boardSkill).toMatch(/`escalate\.mjs`/);
    expect(boardSkill).toMatch(/--reason-file/);
    expect(boardSkill).toMatch(/--context-file/);
  });
});
