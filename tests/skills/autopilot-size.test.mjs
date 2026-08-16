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
