import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (rel) => readFile(join(root, rel), 'utf8');

describe('forge:autopilot skill (AC-1, AC-4, #126)', () => {
  it('AC-1: is a continuous loop over deliver — select, deliver, advance, until none remain', async () => {
    const s = await read('plugin/skills/autopilot/SKILL.md');
    expect(s).toMatch(/^name:\s*autopilot$/m);
    // built on the real pipeline, not a parallel one
    expect(s).toMatch(/forge:deliver/);
    expect(s).toMatch(/loop/i);
    expect(s).toMatch(/select.*next actionable|next actionable/i);
    // continuous until the board is empty, then a run report
    expect(s).toMatch(/no actionable ticket remains|none left|until.*none/i);
    expect(s).toMatch(/run report/i);
    // one at a time in v1 (parallel is deferred)
    expect(s).toMatch(/one ticket at a time/i);
  });

  it('AC-4: the human PR gate is replaced by a strict merge bar — nothing merges on red', async () => {
    const s = await read('plugin/skills/autopilot/SKILL.md');
    expect(s).toMatch(/auto-merge/i);
    expect(s).toMatch(/squash-merge to main/i);
    // the bar: ship green + mechanical gates + reviewer/security + CI green
    for (const gate of ['plandrift', 'testintent', 'depguard', 'acgate']) {
      expect(s, `merge bar missing ${gate}`).toContain(gate);
    }
    expect(s).toMatch(/reviewer/);
    expect(s).toMatch(/security/);
    expect(s).toMatch(/CI.*green|green.*CI/i);
    // the invariant
    expect(s).toMatch(/nothing merges on red|never merge.*red|merges on red.*ever/i);
    // safe-by-default opt-out
    expect(s).toMatch(/autopilotAutoMerge/);
  });

  it('AC-4: halts only on real escalations, and an escalation parks one ticket + continues', async () => {
    const s = await read('plugin/skills/autopilot/SKILL.md');
    expect(s).toMatch(/escalate\.mjs/);
    // the owner's two headline gates
    expect(s).toMatch(/product broken/i);
    expect(s).toMatch(/decision.*(not|isn't) the engine|design deviation needs a decision/i);
    // one escalation must not stop the whole run
    expect(s).toMatch(/parks? one ticket|continue.*next|does not stop the whole run/i);
  });

  it('#156/AC-466.7: the main loop is orchestrate-only — spawns a per-ticket delivery subagent, never delivers inline', async () => {
    const s = await read('plugin/skills/autopilot/SKILL.md');
    // the loop's per-ticket step is a Task-tool spawn, not inline delivery
    expect(s).toMatch(/SPAWN a delivery subagent|spawn a delivery subagent/i);
    expect(s).toMatch(/Task tool/);
    expect(s).toMatch(/subagent_type/);
    // explicit prohibition on inline delivery in the main loop
    expect(s).toMatch(/never deliver.* inline|NEVER delivers inline|not run `?forge:deliver`? inline|must not.*deliver.*inline/i);
    // the compact return contract the loop consumes
    expect(s).toMatch(/\{issue, outcome/);
    // #466: the same spawn discipline extends to triage and shape — not delivery alone
    expect(s).toMatch(/SPAWN a triage subagent|spawn a triage subagent/i);
    expect(s).toMatch(/SPAWN a shape subagent|spawn a shape subagent/i);
  });

  it('#156/#430: documents per-host permission pre-authorization required for a continuous run', async () => {
    const s = await read('plugin/skills/autopilot/SKILL.md');
    expect(s).toMatch(/Permissions/);
    expect(s).toMatch(/perms\.mjs/);
    expect(s).toMatch(/Claude Code/);
    expect(s).toMatch(/local settings file|local Claude settings/i);
    expect(s).toMatch(/Antigravity \(agy\)/);
    expect(s).toMatch(/hook-mediated/);
    expect(s).toMatch(/permission prompt|pre-authoriz/i);
    // #430: the source skill is copied byte-for-byte into the emitted agy package
    // (plugin/scripts/agy/emit.mjs COMPONENT_DIRS), so it must never spell out the
    // Claude-only filename literally — an agy-hosted agent reading its own bundled
    // copy would be told to write a file agy never reads. tests/agy/emit.test.mjs
    // (AC-430) pins the same property against the emitted tree.
    expect(s).not.toMatch(/settings\.local\.json/);
  });

  it('#137: documents context/cost bounding — spawned per-ticket delivery + O(1) outer loop', async () => {
    const s = await read('plugin/skills/autopilot/SKILL.md');
    expect(s).toMatch(/discardable context|spawned agent/i);
    expect(s).toMatch(/own spawned agent|delivered in a discardable/i);
    // outer loop keeps only file-backed state
    expect(s).toMatch(/run\.json.*outcome|one-line outcome/i);
    expect(s).toMatch(/O\(1\) per ticket/);
    // a dedicated cost/context section, incl. the OS-irrelevant note
    expect(s).toMatch(/Cost & context on long runs/);
    expect(s).toMatch(/checkpoint|resume protocol reconstructs/i);
    expect(s).toMatch(/host OS is irrelevant|OS.*irrelevant/i);
  });

  it('#177: the delivery-subagent brief watches CI to green in-run and forbids the return-then-resume stall', async () => {
    const s = await read('plugin/skills/autopilot/SKILL.md');
    // AC1: brief instructs gh pr checks --watch to conclusion + merge in the same run
    expect(s).toMatch(/gh pr checks <pr> --watch/);
    expect(s).toMatch(/watch CI to green in.?run|watch CI to conclusion/i);
    expect(s).toMatch(/same (run|invocation)/i);
    // AC2: the open-PR-then-await-external-notification stall is explicitly forbidden
    expect(s).toMatch(/Forbidden.*return-then-resume|return-then-resume stall/i);
    expect(s).toMatch(/nothing re-invokes it when CI goes green|isn't re-invoked on green|never return.*re-spawned on green/i);
    expect(s).toMatch(/await.*(external|background).*notification/i);
  });

  it('#169: SKILL wires the forge-ci / forge-decisions monitors and reacts to their notifications instead of inline polling', async () => {
    const s = await read('plugin/skills/autopilot/SKILL.md');
    // AC1: both monitors are named and the notification model is described
    expect(s).toMatch(/forge-ci/);
    expect(s).toMatch(/forge-decisions/);
    expect(s).toMatch(/monitors\.json/);
    expect(s).toMatch(/on-skill-invoke:autopilot/);
    // AC1: the model is push-notification-driven, replacing inline polling at the loop level
    expect(s).toMatch(/push a stdout line to the \*\*running main loop\*\* as a notification/);
    expect(s).toMatch(/without (a polling timer|polling|inline.?poll)|instead of polling|never inline-poll/i);
    // AC1: the merge bar reacts to a CI pass line; a resolved-decision line unblocks the escalated ticket
    expect(s).toMatch(/CI pass/);
    expect(s).toMatch(/unblocks the escalated ticket|resolved-decision line/i);
    // AC2: prose is consistent with what the monitors ACTUALLY emit
    expect(s).toMatch(/CI <state> on PR #<n> \(<branch>\)/);
    expect(s).toMatch(/Decision <id> \(#<issue>\) resolved/);
    // #177 consistency trap: monitors notify the MAIN LOOP, the subagent still watches its own CI in-run
    expect(s).toMatch(/notif\w*\s+the\s+\*\*main loop\*\*|notify the \*\*main loop\*\*|running main loop/i);
    expect(s).toMatch(/own\*?\*? PR's CI in-run|watches its \*\*own\*\* PR/i);
    expect(s).toMatch(/orthogonal/i);
  });

  it('#179 AC1: SKILL documents that in-session merge authorization is required and config+allowlist alone is insufficient', async () => {
    const s = await read('plugin/skills/autopilot/SKILL.md');
    // the harness auto-mode classifier requires a live in-session user authorization
    expect(s).toMatch(/in-session/i);
    expect(s).toMatch(/auto-mode classifier|harness.*classifier/i);
    // config + allowlist ALONE do not clear the classifier
    expect(s).toMatch(/allowlist alone|necessary but not sufficient|not sufficient/i);
    expect(s).toMatch(/autopilotAutoMerge/);
    // a grant only in run.json / narration is insufficient
    expect(s).toMatch(/run\.json.*(narration|not count|does not)|narration.*(not count|does not)/i);
    // without it the loop stalls at the first merge
    expect(s).toMatch(/stalls? at (the )?first merge/i);
  });

  it('#179 AC1: the autopilot spec documents the in-session-authorization requirement and its insufficiency', async () => {
    const s = await read('docs/specs/2026-07-21-forge-autopilot.md');
    expect(s).toMatch(/in-session/i);
    expect(s).toMatch(/auto-mode classifier|harness.*classifier/i);
    expect(s).toMatch(/necessary but not sufficient|not sufficient/i);
    expect(s).toMatch(/autopilotAutoMerge/);
    expect(s).toMatch(/run\.json.*(narration|insufficient|not)|narration.*(insufficient|not)/i);
    expect(s).toMatch(/stalls? at (the )?first merge/i);
  });

  it('#179 AC2: SKILL documents a run-start merge-authorization preflight that degrades instead of burning a delivery', async () => {
    const s = await read('plugin/skills/autopilot/SKILL.md');
    // a documented run-start preflight step
    expect(s).toMatch(/preflight/i);
    expect(s).toMatch(/run.?start|before spawning the first delivery|run start/i);
    // if absent: surface + degrade (PR-only / awaiting-human), not a mid-run stall
    expect(s).toMatch(/PR-only|awaiting-human/i);
    expect(s).toMatch(/degrade|surface it/i);
    expect(s).toMatch(/Merge.?policy/i);
  });

  it('#179 AC2: the spec documents the run-start merge-authorization preflight', async () => {
    const s = await read('docs/specs/2026-07-21-forge-autopilot.md');
    expect(s).toMatch(/preflight/i);
    expect(s).toMatch(/run.?start|before.*first delivery/i);
    expect(s).toMatch(/PR-only|awaiting-human/i);
  });

  it('#166: the kill switch names only the real situation gate — no removed forge-control pause', async () => {
    const s = await read('plugin/skills/autopilot/SKILL.md');
    // AC2: forge-control was removed by ADR-0003 — no dead-subsystem reference remains
    expect(s).not.toMatch(/forge-control/);
    expect(s).not.toMatch(/\.forge-control/);
    // AC1: the kill switch describes the real per-repo situation gate (incident / security hold)
    expect(s).toMatch(/situation gate/i);
    expect(s).toMatch(/incident/i);
    expect(s).toMatch(/security.?(response|hold)/i);
  });

  it('#192: the spec kill switch names only the real situation gate — no removed forge-control pause', async () => {
    const s = await read('docs/specs/2026-07-21-forge-autopilot.md');
    // AC2: forge-control was removed by ADR-0003 — no dead-subsystem reference remains in the active spec
    expect(s).not.toMatch(/forge-control/);
    expect(s).not.toMatch(/\.forge-control/);
    // AC1: the kill switch describes the real per-repo situation gate (incident / security hold), matching SKILL.md
    expect(s).toMatch(/situation gate/i);
    expect(s).toMatch(/incident/i);
    expect(s).toMatch(/security.?(response|hold)/i);
  });

  it('#379: the delivery subagent spawn pins an explicit model, not a bare unpinned general-purpose', async () => {
    const s = await read('plugin/skills/autopilot/SKILL.md');
    // the spawn instruction names an explicit model override, tiered like every other forge role agent (#101)
    expect(s).toMatch(/subagent_type:\s*general-purpose.*model:\s*["']?sonnet["']?/i);
    expect(s).toMatch(/#101/);
  });

  it('AC-2 front door + AC-5 files new work + AC-6 safety are all specified', async () => {
    const s = await read('plugin/skills/autopilot/SKILL.md');
    // auto-triage front door, under-specified => escalate + skip
    expect(s).toMatch(/auto-triage|front door/i);
    expect(s).toMatch(/forge:triage/);
    expect(s).toMatch(/verdict: fail/);
    // can open new bugs/spikes/items mid-run
    expect(s).toMatch(/board\/create\.mjs/);
    expect(s).toMatch(/bug/);
    expect(s).toMatch(/spike/);
    // safety rails: pause / kill switch, loop backstop, resumable run ledger
    expect(s).toMatch(/paused|kill switch/i);
    expect(s).toMatch(/backstop|max-iterations/i);
    expect(s).toMatch(/run\.json|run ledger/i);
  });

  // AC-466.1/AC-7: the orchestrate-only mandate (#156) covered only `deliver`;
  // this generalizes it to every action select.mjs can return.
  it('AC-466.1: the main loop NEVER runs a skill inline — every select.mjs action (resume/deliver/triage/shape) is spawned', async () => {
    const s = await read('plugin/skills/autopilot/SKILL.md');
    expect(s).toMatch(/the main loop never runs a skill inline/i);
    expect(s).toMatch(/every action `?select\.mjs`? returns is executed in a spawned subagent/i);
    // the action->subagent table names all four
    expect(s).toMatch(/\bresume\b[\s\S]{0,400}\bdeliver\b[\s\S]{0,400}\btriage\b[\s\S]{0,400}\bshape\b|shape[\s\S]{0,200}triage subagent|triage subagent/i);
    expect(s).toMatch(/shape subagent/i);
    expect(s).toMatch(/triage subagent/i);
  });

  it('AC-466.2: --shape spawns a shape subagent (not an inline forge:shape call) and reads only its terminal JSON', async () => {
    const s = await read('plugin/skills/autopilot/SKILL.md');
    expect(s).toMatch(/spawn.{0,80}shape subagent|shape subagent.{0,80}spawn/is);
    // the shape subagent's terminal report contract (already specified in shape/SKILL.md)
    expect(s).toMatch(/\{["']?verdict["']?,\s*["']?outcome["']?,\s*["']?issue["']?,\s*["']?followUp["']?,\s*["']?sources["']?\}/);
  });

  it('AC-466.3: the delivery brief no longer carries a fused shape-first route', async () => {
    const s = await read('plugin/skills/autopilot/SKILL.md');
    expect(s).not.toMatch(/shape-first under/i);
  });

  it('AC-466.5: the loop re-reads run.json every iteration, and the resume protocol covers compaction, not just a fresh session', async () => {
    const s = await read('plugin/skills/autopilot/SKILL.md');
    expect(s).toMatch(/re-reads? `?run\.json`? at the top of every iteration/i);
    expect(s).toMatch(/fresh session.{0,40}or after (any )?compaction|compaction.{0,40}fresh session/i);
    // mergeMode is a record of a past grant, not a recoverable grant — re-anchoring
    // must not create the belief that merge authority was restored.
    expect(s).toMatch(/record of a past grant, not a recoverable grant/i);
  });

  it('AC-464.5: § Return-then-resume watchdog documents the stalled-before-PR shape alongside awaiting-merge', async () => {
    const s = await read('plugin/skills/autopilot/SKILL.md');
    expect(s).toMatch(/Return-then-resume watchdog/);
    // the second stall's name and its distinguishing recovery (respawn, not the merge bar)
    expect(s).toMatch(/stalled-before-pr/i);
    expect(s).toMatch(/action.{0,10}respawn/i);
    // both shapes named together so the prose and the mechanism agree (#464)
    expect(s).toMatch(/#464/);
    expect(s).toMatch(/#319/);
    // the recovery distinction from AC.2: resume/re-spawn vs funnel to the merge bar
    expect(s).toMatch(/resume or re-spawn/i);
    expect(s).toMatch(/never funnel to the merge bar|not.{0,10}the merge bar/i);
  });
});
