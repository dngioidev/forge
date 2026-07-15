# forge — AI-driven development platform — Design Spec

**Date:** 2026-07-15 (v3.5 — owner-review amendments, round 6: lifecycle dry-run + automation ladder)
**Repo:** dngioidev/forge (new)
**Testbed:** dngioidev/cms (design system), later tasky-ai and future repos
**Goal:** A portable Claude Code plugin that runs the entire AI development workflow: pipeline skills (idea → tickets → spec → plan → execute → ship → release), a specialized agent roster with pluggable CLI backends, GitHub Projects automation, a human escalation protocol, an error-learning loop, a structural graph-RAG index for code retrieval and reuse, a DevOps layer (Docker + Terraform, production-deployable from day one), and a mission-control console (local daemon + cloud + device app) for monitoring and driving the fleet.

## 1. Purpose & context

- Owner: solo developer today; the platform is team-ready by design (section 3) — team structure lives behind config and can change mid-project.
- Today: the superpowers plugin provides process orchestration (brainstorm → plan → subagent-driven-development → ship); board work is hand-driven GraphQL; subagents are generic; nothing learns from errors; no code-reuse retrieval.
- Decision (owner, 2026-07-15): build an **own pipeline** — forge replaces superpowers **incrementally, skill by skill**, proving parity on real cms work before each superpowers counterpart is retired. Superpowers is uninstalled from consumer repos once forge's pipeline skills reach parity.
- Claude Code is always the orchestrator. Other CLIs (agy/Gemini, codex, …) may fill individual agent roles to save tokens, never orchestrate.

### Decisions log (owner-approved, 2026-07-15)

| Decision | Choice |
| --- | --- |
| Goal | Portable platform, not cms-only |
| Home | New repo `dngioidev/forge`, Claude Code plugin marketplace |
| Pipeline | Own pipeline (approach B), incremental skill-by-skill migration |
| Graph RAG | Structural graph (ts-morph → SQLite → MCP), no embeddings initially (roadmap backlog) |
| Learning | Auto-capture kind-tagged failures + gated `/distill` (human approves every lesson) |
| Board | Docs-as-code stays in git; board = tracker + auto-published digests |
| Backend swap scope (v3) | Non-Claude backends only for read roles (investigator, librarian, second-opinion) + implementer under the child-branch rule; every gate role pinned to Claude, enforced in code |
| Team model (v3) | Human roles/areas behind `forge.json` `team` block; solo = one member holding all roles; structure changeable mid-project by config edit |
| Escalation (v3) | Formal halt-and-ask protocol; first transport = GitHub-native (Blocked status + decision comment); console app upgrades transport later |
| Console (v3) | Mission-control app (local daemon + Firebase/GCP + device app) as sub-projects 9a/9b; graduates to its own repo |
| CI runners (v3) | GitHub-hosted; no self-hosted CI runner — the console daemon is the local runner for *agent* work, not CI |
| Docs knowledge base (v3.1) | `docs/` KB with route index (`docs/README.md`), ADR-style `decisions/`, `guides/` runbooks; `forge:ship` maintains the index |
| Scope boundaries (v3.1) | No separate v1/v2 versioning — deferred items live on the rollout backlog (section 12); section 14 keeps only permanent non-goals |
| DevOps layer (v3.2) | Deployability is a standing gate: Docker + Terraform reference stack, `devops` role (pinned), deploy scaffold at `forge init`, deploy-readiness gate in ship, apply always human-approved |
| Environments (v3.3) | Branch-driven configurable chain: main is CI-only and never deploys; staging deploys on demand via the `staging` branch; production promotes staging's exact image digest; chain length is per-repo config |
| Post-merge SDLC (v3.3) | Three new skills — `forge:release` (semver/changelog/tag/publish), `forge:hotfix` (expedited path + rollback + incident capture), `forge:maintain` (dependency cadence, cms #70 lesson) — plus data lifecycle, observability minimum, `features.e2e`, digest flow metrics |
| Git conventions (v3.4) | Branch naming `<type>/<issue#>-<slug>`, cut-from-main-only, squash-merge with conventional PR title, fast-forward-only environment branches, immutable release-only semver tags, generated release description; ship lints, doctor audits |
| Decision mechanics (v3.5) | One mechanism for every human decision: scheduled gates and escalations both use the decision-comment flow; plan gate auto by default, config can require sign-off |
| Automation ladder (v3.5) | L0→L3 maturity ladder as config progression; `policy.autoApprove` risk tiers (default off, journaled, digest-sampled); production promote / apply / distill / security stay human at every level |

## 2. Repo & plugin anatomy

```
forge/
  .claude-plugin/marketplace.json    one marketplace, one plugin: "forge"
  plugin/
    .claude-plugin/plugin.json
    skills/          pipeline + board + learning skills (markdown)
    cards/           backend-neutral role cards (single source; outside agents/ so Claude Code never loads them as agents)
    agents/          Claude-native agent definitions compiled from cards
    hooks/           learning-capture + safety hooks (node .mjs + hooks.json)
    commands/        /distill, /ticket (quick triage), /forge:<verb> wrappers (below)
    mcp/graph/       graph-RAG MCP server (node)
    scripts/
      board/         gh GraphQL helpers (create/move/receipt/digest/log)
      backends/      CLI adapters (agy, codex, …) implementing run/report contract
      lib/           shared node utilities (Windows-safe spawn, path, CRLF)
    templates/       consumer CI workflow (verify + gitleaks); deploy/<stack>/ scaffolds (Dockerfile, compose, terraform)
  docs/
    README.md        route index: one line per doc, grouped by kind — the single entry point for project knowledge
    product/         vision, roadmap, PRDs — the context forge:ideate brainstorms against
    specs/           design specs (this file)
    plans/           implementation plans
    decisions/       ADR-style records (short, numbered): owner decisions that outlive the spec that spawned them
    guides/          runbooks & how-tos: install, init, backends, console ops, troubleshooting
  package.json       Node >=22.13, vitest suites for hooks/scripts/mcp
  .github/workflows/ verify CI (vitest, actionlint, SHA-pinned actions)
```

- Consumer repos install via `claude plugin marketplace add dngioidev/forge` (in-session: `/plugin marketplace add`) + plugin install, then `forge init` (section 6).
- **Command surface:** every `forge <verb>` in this spec (`init`, `doctor`, `backends sync`, `deploy-init`, `graph install-hook`, `graph rebuild`) is a plugin slash command `/forge:<verb>` wrapping a script in `plugin/scripts/` — no installed binary, no npm bin. Stack-specific helpers (e.g. a `/new-component` command) are not part of the portable plugin; consumer repos add them via the normal override mechanism.
- **Per-repo config `.claude/forge.json`** (committed in each consumer repo) keeps the plugin generic:

```jsonc
{
  "version": 1,
  "board": {
    "projectNumber": 7,
    "projectId": "PVT_…",
    "fields": { "status": { "id": "…", "options": { "backlog": "…", "ready": "…", "inProgress": "…",
                                                     "inReview": "…", "blocked": "…", "done": "…" } },
                 "priority": { "…": "…" }, "size": { "…": "…" }, "type": { "…": "…" },
                 "iteration": { "…": "…" }, "area": { "…": "…" } },   // iteration/area optional
    "deliveryLogIssue": 205
  },
  "conventions": {
    "verify": "pnpm verify",
    "commitFormat": "conventional+issue-ref",
    "specsDir": "docs/specs",     // cms currently maps these to docs/superpowers/* during migration
    "plansDir": "docs/plans",
    "shell": "windows"            // renders the plugin's Windows shell-rule template into synced context files
  },
  "features": { "graph": true, "designReview": true, "deploy": true, "e2e": false },   // stack-specific pieces are flags
  "deploy": { /* section 10 */ },
  "team": { /* section 3 */ },
  "roster": { /* section 5 */ }
}
```

- `forge init` bootstraps or adopts the board and writes this file (section 6).
- Principles: plain Node + gh CLI only; no external services in the plugin itself; no API keys beyond existing gh/CLI auth; Windows-first (CRLF, `.cmd` spawn EINVAL, path-separator lessons become test cases in forge CI).
- **Git conventions (platform law; `forge:ship` lints them, `doctor` audits):**
  - **Branch naming:** work branches are `<type>/<issue#>-<kebab-slug>` (`feat/15-button`, `fix/70-dependabot-train`); `<type>` is the conventional-commit type set (feat, fix, chore, docs, refactor, test, perf). Agent child branches (the CLI-implementer rule, section 5) suffix the parent: `feat/15-button--implementer`. Environment branch names come from `deploy.environments` (section 10). Nothing else may exist on the remote.
  - **Cut rules:** work branches cut from up-to-date main only; one ticket per branch; branch-off-branch only for agent child branches; rebase on main before ship's whole-branch final review.
  - **Merge rules:** PRs squash-merge with a conventional-format PR title + issue ref — the squash title is what main's history and the changelog see. Head branch auto-deleted on merge; `doctor` warns on stale merged branches. Environment branches only ever fast-forward to a main commit — never diverge, never force-pushed, never deleted (so every deploy is attributable to one main SHA).
  - **Commit format:** `type(scope): subject (#issue)`, imperative, subject ≤72 chars; breaking changes marked `!` or `BREAKING CHANGE:` footer.
  - **Tag rules:** annotated `v<major>.<minor>.<patch>` tags on main commits, created only by `forge:release`, never moved or deleted. Bump derived from conventional commits since the last tag: fix→patch, feat→minor, breaking→major.
  - **Release description:** generated, fixed shape — one-paragraph summary, changes grouped by type with ticket links, deploy notes (migrations to run, infra changed y/n), the promoted image digest; `CHANGELOG.md` updated in the release commit.
- **Docs knowledge base:** project knowledge lives in `docs/`, in git — no wiki. `docs/README.md` is the **route index**: one line per doc (title, link, one-phrase hook), grouped by kind, so anything is findable in one hop. Maintaining it is not optional: `forge:ship`'s checklist updates the index whenever a merged branch adds or renames a doc, and `forge doctor` warns on docs missing from the index. Decisions that outlive a single spec (e.g. this spec's decisions log) get promoted to short numbered ADRs in `docs/decisions/`; `guides/` holds operational runbooks. The same taxonomy is the convention for consumer repos: `specsDir`/`plansDir` siblings plus a route index at their parent's `README.md`, maintained by the same ship step.

## 3. Team model & human roles

**Human roles are config, not code.** Skills read the `team` block fresh every run — changing the team is a config edit (PR'd, versioned, auditable). No other part of the platform references usernames.

```jsonc
"team": {
  "members": [
    { "github": "dngioidev", "roles": ["maintainer", "security-approver"], "areas": ["*"] },
    { "github": "alice",     "roles": ["developer", "reviewer"],           "areas": ["frontend/*"] }
  ],
  "policy": {
    "approvals": {
      "spec":       ["maintainer"],
      "merge":      ["maintainer"],
      "distill":    ["maintainer"],
      "deploy":     ["maintainer"],
      "escalation": { "security": ["security-approver"], "default": ["maintainer"] }
    },
    "assignment": "manual",  // or "by-area"
    "autoApprove": {         // automation ladder L2 (section 12) — absent/false = every gate is human
      "spec":  { "maxSize": "s", "minPriority": "p2", "excludePaths": ["infra/**", ".github/**", "plugin/hooks/**"] },
      "merge": { "sameTiers": true }   // auto-merge only PRs that pass every gate AND match the spec tier
    }
  }
}
```

- **Built-in human roles** (custom allowed): `maintainer`, `developer`, `reviewer`, `security-approver`. A member holds any combination. Human roles are distinct from *agent* roles (section 5).
- **Solo is the degenerate case**: one member holding all roles — no mode flag; skills derive it. When approver == requester, gates collapse to self-approval, so the solo flow stays as fast as today.
- **Gates route by role, not by name**: spec approval goes to whoever holds `maintainer` at that moment; security escalations route to `security-approver`. Membership changes re-route every gate automatically.
- **Work separation via `areas`** (path globs, later graph-aware): `ideate` assigns tickets by area when `assignment: "by-area"`; `scoper` flags cross-area blast radius so the affected area's owner is looped in before review, not surprised at it.
- **Board follows**: assignees set from members; digests gain a per-member workload section (invisible when solo).
- **`forge doctor` validation**: every member is a real repo collaborator; ≥1 `maintainer` exists; every approval policy resolves to ≥1 current member (catches "we removed the only security-approver").
- **Risk-tiered auto-approval (`policy.autoApprove`, default off):** a gate may skip its human when the ticket fits the configured tier — size/priority bounds, no cross-area impact, no path in the exclude list (security-sensitive paths never qualify). Every auto-approval is journaled (`auto-approve` kind) and sampled in digests for after-the-fact audit. Production promote, `terraform apply`, `/distill`, and security escalations can never be auto-approved — config in those slots is ignored, same mechanism as the backend pins (section 5).

## 4. Pipeline skills

Ten skills. Main flow: **ideate → triage → brainstorm → plan → execute → ship → release**, with `board` called by all of them; `hotfix` and `maintain` run outside the main flow. Each skill is a markdown checklist + process graph, same discipline as superpowers but tuned: ticket-first, role-routed gates (section 3), Windows shell rules, caveman-terse receipts. All skills honor the escalation protocol (section 7).

1. **`forge:ideate`** — raw idea / feature area → feature brainstorm (grounded in `docs/product/` — vision/roadmap/PRDs — when present) → decomposed feature list → epic + child tickets with acceptance criteria, type, size, priority, dependencies, board placement, assignee (per team policy). Builds the ticket tree so work starts ticket-first. (Whole feature areas; single items go straight to triage.)
2. **`forge:triage`** — one incoming bug/idea → correctly-typed ticket with AC + board placement.
   **Dedup rule (ideate + triage):** search open items by title/keywords before creating; on a probable match, link/comment on the existing ticket instead of duplicating — idempotency covers script re-runs, this covers semantic duplicates.
3. **`forge:brainstorm`** — ticketed feature → design spec in the consumer's specs dir; decomposition-first for multi-system asks; spec self-review; spec-approval gate (routed per team policy).
4. **`forge:plan`** — spec → task-by-task plan in the consumer's plans dir. Every task carries: ticket ref, files, complete code, **test-plan section** (cases, edge matrix, AC mapping, plus E2E critical-path cases when `features.e2e` is on — drafted by `test-architect`), verify command, done-criteria. **The plan gate is auto by default** — execution starts without sign-off; add `plan` to `team.policy.approvals` to require one (decided, not merely undefined).
5. **`forge:execute`** — plan → branch. Order per task: `scoper` narrows blast radius (which components/files/tests) → `test-architect` writes failing tests → `implementer` makes them pass → per-task review (`reviewer`; `design-reviewer` added for UI tasks when `features.designReview` is on — off drops that role entirely). Whole-branch final review + fix waves at the end. Ledger `.forge/progress.md` (git-ignored, survives compaction). **Resume protocol:** a fresh session picking up mid-execute reads the ledger, then `.forge/decisions/`, verifies branch state against the plan, and continues from the first incomplete task — no human re-briefing required.
6. **`forge:ship`** — branch → PR: conventions lint (branch name, PR title, commit format — section 2), commits→issues map, honest verification checklist, **AC-verification gate** (machine evidence: test-runner JSON output mapped to ACs — section 13), **plan-drift check** (actual touched files vs plan + blast radius; deviation escalates), **security gate** (`security` reviewer pass on the branch), **deploy-readiness gate** (image builds + healthcheck boots, `terraform plan` clean when `infra/` changed — section 10, when `features.deploy` is on), **CI-green check** before the PR is marked ready. After merge (by a `maintainer`): receipt comments, board Done moves, delivery-log row, epic digest refresh, docs route-index update when the branch touched `docs/` (section 2).
7. **`forge:release`** — merged main → named release: semver bump from conventional commits, changelog, git tag, GitHub Release, user-facing docs refresh. **Release names artifacts, it never builds them:** for images it retags the staging-verified digest with the semver tag (build-once — section 10), so the release name and the bytes running in production are identical; for packages (npm) it publishes from the tagged commit. **Timing rule:** in deploy-enabled repos, release runs *after* the staging merge + smoke pass (there must be a verified digest to name); in non-deploy repos (libraries), release runs any time after merge. The bridge between "merged" and "a deployable artifact with a name."
8. **`forge:hotfix`** — expedited production-incident path: security gate + verify stay, planning ritual compressed to a one-paragraph scope note, mandatory follow-up postmortem ticket; the incident lands in the journal as an `incident` event so `/distill` learns from production failures. **Only the process ritual is compressed — the deploy path is not:** a hotfix still traverses the environment chain (staging smoke included; it's minutes, not hours). Includes the rollback runbook (redeploy the previous image digest, one command).
9. **`forge:maintain`** — dependency cadence (the cms #70 lesson as platform law): patch/minor updates batched + auto-verified + merged; majors bundled into one coordinated upgrade ticket, never merged individually; CVE advisories triaged with a response SLA. Runs on demand or as a scheduled routine.
10. **`forge:board`** — shared ticket-operations skill wrapping `scripts/board/*` (section 6); the other nine call it instead of raw GraphQL.

Migration order (parity proven on real cms work before retiring each superpowers counterpart): ship → plan+execute → brainstorm. `ideate`, `triage`, `board`, `release`, `hotfix`, `maintain` have no counterpart and land whenever ready.

## 5. Agent roster & pluggable backends

**Role ≠ runtime.** Each role is a **role card** (mission, checklist, output contract, guardrails) rendered onto a configurable **backend**.

| Role | Default backend | Job |
| --- | --- | --- |
| `implementer` | claude:sonnet | one plan task, TDD, conventions injected from forge.json |
| `reviewer` | claude:fable (**pinned**) | per-task + whole-branch review, severity-tagged findings |
| `security` | claude:fable (**pinned**) | adversarial pass: injection, secrets, supply chain, hook/CI attack surface; read-only |
| `design-reviewer` | claude:sonnet (**pinned**) | token-only styling, a11y contract, stories present, visual spec match |
| `scoper` | claude:sonnet (**pinned**) | ticket impact analysis: touched components/files, test set to run, blast radius |
| `test-architect` | claude:sonnet (**pinned**) | AC → test plan; writes failing tests first; verifies AC coverage at ship |
| `devops` | claude:sonnet (**pinned**) | Dockerfile/compose/Terraform ownership, CI deploy jobs, infra diff review, `terraform plan` (section 10) |
| `investigator` | claude:haiku | read-only code location, cheap fan-out |
| `librarian` | claude:haiku | RAG-first lookup: queries graph MCP before any grep sweep |
| `second-opinion` | codex:gpt-5 (optional) | independent second-pass critique of specs/plans/diffs on demand; read-only, advisory — never a merge gate |

**Swap allowlist (enforced in the backend loader, not convention):** only `investigator`, `librarian`, and `second-opinion` accept non-Claude backends; `implementer` may use one only under the child-branch rule below — the loader checks the condition itself (rejects a non-Claude implementer unless the current branch matches the agent child-branch pattern `…--<role>`, section 2), and `forge:ship` refuses to mark the PR ready until the CLI-authored diff has a recorded Claude `reviewer` pass. Every other role — everything that feeds a gate or decision — is pinned `claude:*`; a roster entry attempting to swap a pinned role is **ignored with a warning** (same mechanism as the security pin). Pinned roles may still change *Claude model* via roster (e.g. `reviewer: claude:opus`).

**Backends** (per-repo `forge.json` `roster` block):

```jsonc
"roster": {
  "investigator":   { "backend": "agy:gemini-flash",  "fallback": "claude:haiku" },
  "librarian":      { "backend": "agy:gemini-flash",  "fallback": "claude:haiku" },
  "second-opinion": { "backend": "codex:gpt-5",       "optional": true },
  "implementer":    { "backend": "claude:sonnet" }
  // pinned roles: only claude:<model> accepted; non-claude entries ignored by design
}
```

- Backend id format is uniform: **`<runtime>:<model>`** (`claude:sonnet`, `agy:gemini-pro`, `agy:gemini-flash`, `codex:gpt-5`, …). Model part optional — bare runtime (`agy`) means the adapter's declared default model. `fallback` uses the same format.
- **Role cards are backend-neutral**, stored in `plugin/cards/<role>.md` (mission, checklist, guardrails, output contract — every card carries the **honesty clause**: "unknown" is a valid answer; guessed file paths or API names are a card violation). One source, two renderers:
  - `claude:*` — card compiled to `agents/<role>.md` native subagent. Compiled agent files carry **no model pin**: the orchestrator reads the roster and passes the model at spawn time, so a per-repo model override needs no file regeneration. Read-only roles compile with read-only tool allowlists.
  - CLI backends (`agy`, `codex`, …) — adapter script per CLI in `scripts/backends/`, one contract: `run(roleCard, taskBrief, model) → report`. The adapter renders `role card + forge.json conventions + task brief + report contract` into a single prompt (`agy -p …`, `codex exec …`), owns the model-id→CLI-flag mapping, and declares its default model plus accepted model ids; unknown model id → treated like missing CLI. Adapters pass CLI-native sandbox/read-only flags where the CLI supports them. Generalizes the existing agy-consult pattern.
- **Task brief** is composed by the orchestrator: goal, ticket ref, scoped file list (from `scoper`/graph), constraints, expected output. CLI agents run in the repo cwd and read files themselves — briefs carry pointers, never file dumps.
- **Native context sync:** `forge backends sync` renders forge.json conventions (verify command, commit format, specs/plans dirs, plus the plugin's static shell-rule template selected by `conventions.shell`) into the context files each CLI reads natively — `GEMINI.md` for agy, `AGENTS.md` for codex — so repo context costs zero prompt tokens per call. Sync writes a fenced managed block (`<!-- forge:begin --> … <!-- forge:end -->`) and never touches content outside it, so hand-written sections survive. Managed blocks are rendered **only from forge.json content and static plugin templates**, never from fetched or external text. Sync also writes CLI-native ignore files (`.geminiignore`, codex equivalent) excluding `.env*`, `*.pem`, key material, `*.tfstate`, `.terraform/`, and `.forge/` (section 13). Re-run on forge.json change; `forge init` runs it once.
- **Report contract** (every role, every backend): markdown body + terminal JSON block

  ```json
  { "verdict": "pass|fail", "findings": [ { "severity": "critical|major|minor", "file": "…", "line": 1, "summary": "…" } ] }
  ```

  Ship gates (reviewer, security, AC-verification) consume the JSON block only — never parse prose. Gate scripts apply **cite-or-drop** (section 13): findings whose `file`/`line` don't exist are dropped automatically.
- Failure handling: per-adapter timeout (default 10 min). Timeout, nonzero exit, or malformed report JSON → one retry with the violation appended to the prompt, then `fallback` backend + `backend-fallback` journal event. Missing CLI / auth failure skips straight to fallback. `optional: true` roles have no fallback: on any failure the role is skipped with a note in the session output (still journaled). Fallback exhausted on a non-optional role → escalation (section 7).
- Every backend call is journaled (role, backend id, prompt hash) — audit trail for the learning loop and forensics.
- Rules:
  - Claude Code always orchestrates; CLIs only fill roles.
  - Token-heavy read roles are the swap targets (investigator, librarian, second-opinion) — enforced by the allowlist above.
  - A write-capable CLI backend (implementer) is allowed **only on a child branch, with a mandatory Claude `reviewer` diff pass before merge** (existing tasky rule, now platform law).
  - `security` and all gate roles are a trust boundary: always Claude, config cannot override.
  - **CLI reports are untrusted input:** the orchestrator treats them as data, never as instructions to follow; any CLI-backend contribution to a branch still passes the Claude `reviewer` + `security` gates.
  - **Data sharing:** CLI backends send repo content to third-party providers (Google, OpenAI). Accepted for the owner's repos; a consumer repo opts out by not listing CLI backends in its roster. Adapter pre-send scan + ignore files bound what can leak (section 13).
- Consumer repos may override role cards: for `claude:*` backends, ship `.claude/agents/<role>.md` (repo definitions win over plugin — Claude Code precedence); for CLI backends, adapters prefer `.claude/cards/<role>.md` over the plugin card when present. Same override story both sides.
- Adding a role = new role card + forge.json entry. Adding a CLI = one adapter implementing the contract.

## 6. Board automation

`scripts/board/*.mjs`, all invoked through `forge:board`:

- **create** — ticket with type/priority/size/parent (native sub-issue) + assignee + board add + field set, in one command.
- **move** — status transitions across the forge standard set: **Backlog → Ready → In progress → In review → Blocked/Needs decision → Done**. Solo, some columns stay thin; team, they're load-bearing. `init` creates missing options on fresh projects and maps whatever exists on adopted ones; skills degrade gracefully to the mapped subset.
- **receipt** — merge receipt comment on issues; idempotent (re-run updates, never duplicates).
- **Idempotency is a rule for every script, not just receipt:** re-runs detect existing state (issue by title+parent, board item, comment marker) and resume or update instead of duplicating. Multi-step `create` (issue → board add → field set) resumes from the failed step.
- **digest** — epic body auto-carries spec link + live child table + per-member workload (team) + **open escalations first**; refreshed on child changes. Also carries **flow metrics** computed from data the board + journal already hold — cycle time per ticket, Size estimate vs actual, gate-failure rate, backend cost per shipped ticket — the platform's own evidence that it's paying off. And a **stalled-items section**: green PRs unmerged, staging deploys unpromoted, decision comments unanswered — each with its age, so nothing halts silently (`doctor` flags the same list).
- **log** — delivery-log row append to the pinned per-repo issue (tasky #205 pattern).
- **init** — full bootstrap, idempotent (adopt-or-create): checks gh auth + Node ≥22.13 → creates the GitHub Project + status/priority/size/type fields with standard options if absent, discovers IDs if present (optional iteration/area fields are discovered and mapped when present; init offers to create `area` when `assignment: "by-area"`) → creates the delivery-log issue if missing → writes `forge.json` (board + team skeleton) → adds `.forge/` to the consumer `.gitignore` → installs the consumer CI template (below) if `.github/workflows/` lacks a verify workflow → runs `forge backends sync`. Works on a fresh repo and a mature one. **Spike required (SP1):** verify ProjectsV2 GraphQL can add options to the built-in Status single-select on a fresh project; if not, init documents the manual step and falls back to mapping whatever exists (the degrade-gracefully path above). Init and doctor grow with the rollout: the CI-template step lands with SP3, the backends-sync step with SP4.
- **doctor** — read-only health check: gh auth, project reachable, field/option IDs valid, team block valid (section 3), roster backends' CLIs present, Node ≥22.13, branch protection with required verify check, secret scanning + push protection enabled (warn if not), `guides/onboarding.md` present when the team has >1 member. Run any time; `init` ends by running it.

**Consumer CI template** (`plugin/templates/`): one minimal workflow — the repo's `verify` command on PR and push-to-main, plus gitleaks and a dependency license scan. `forge:ship` checks CI is green before marking a PR ready. Branch protection (require the verify check) is the hard backstop agents cannot bypass — `init` offers to set it, `doctor` warns when absent.

Docs stay in git (reviewable, diffable); the board is the tracker + window. Field IDs are read from config — no hand-built GraphQL in sessions ever again.

## 7. Escalation & human decisions

Scheduled gates (spec approval, distill approval, merge) are not enough — the pipeline needs a **halt-and-ask** path for mid-flight surprises. Escalation is platform law: skills never auto-resolve past a trigger.

**One mechanism for every human decision:** scheduled gates and escalations use the *same* decision-comment flow — context, options, recommendation posted on the issue; the reply is the decision; the thread is the audit trail. A spec approval is simply a scheduled decision comment; an escalation is an unscheduled one. One mechanism means one inbox (console 9a), one journal shape, one audit story.

**Triggers:**
- `critical`-severity finding from any reviewer/security pass.
- The same gate failing twice.
- Plan drift: actual work exceeding the plan's file list + scoper's blast radius.
- Any destructive or hard-to-reverse action (force push, data deletion, rewriting published history) — including hits on the hook denylist (section 13).
- Backend fallback exhausted on a non-optional role.
- Cross-area impact without the area owner's sign-off (team mode).

**Action (always the same sequence):** halt the pipeline → move the ticket to **Blocked/Needs decision** → post a decision comment on the issue (context, options, recommendation) → journal an `escalation` event → stop. Routing follows `team.policy.escalation` (category → role holders), so a security escalation pings the `security-approver`, not everyone.

**First transport — GitHub-native, zero infra:** GitHub Mobile already pushes issue comments to the approver's phone; they reply in the comment thread; the session (or the next one) reads the decision and resumes. The comment thread is the permanent audit trail. The console app (section 11) upgrades the transport to tap-to-answer later but **never replaces the GitHub record** — every decision still lands on the issue.

## 8. Learning loop

**Capture** — plugin hooks (PostToolUse + gate failures) append kind-tagged JSONL to `.forge/journal.jsonl` (git-ignored):

```json
{"ts":"…","kind":"gate-fail","tool":"Bash","cmd":"pnpm verify","exit":1,"err_line":"…","ticket":"#15","branch":"feat/…"}
```

Kinds: `gate-fail`, `blocked-edit`, `cmd-fail`, `backend-fallback`, `review-finding`, `escalation`, `incident` (production failures, appended by `forge:hotfix` — the most valuable lessons `/distill` sees), `auto-approve` (every gate skipped under `policy.autoApprove`, section 3 — the audit trail automation rides on). Read-only commands (grep/ls/cat/gh view/git log/…) are excluded **at capture time** via an exclusion list — the tasky-ai journal-noise lesson baked in. `review-finding` events are not tool failures, so hooks can't see them: the execute/ship skills append them explicitly from reviewer report JSON.

**Distill** — `/distill` skill: reads journal since last run, clusters repeats, proposes per cluster one of: CLAUDE.md rule, role-card edit, new lint/hook guard, memory entry. **A `maintainer` approves each proposal before anything is written** — and applied lessons land as a PR, so in a team they get reviewed like any other change. Applied lessons are logged with journal refs; after distill the journal is archived to `.forge/journal-archive/<date>.jsonl` (rejected clusters keep their evidence), and the live journal starts empty. Suggested cadence: after each epic ships, or weekly.

## 9. Graph RAG MCP server

`plugin/mcp/graph/` — structural index of the consumer repo, no embeddings initially (backlog item; the schema keeps an embedding column slot). Feature-flagged: `features.graph` — TypeScript repos only; with the flag off, `librarian` falls back to grep-first and `scoper` uses import-scan (that fallback is **permanent** for non-TS repos, not a stopgap).

- **Indexer:** ts-morph parse → SQLite `.forge/graph.db` via built-in `node:sqlite` (Node ≥22.13, where the module is no longer experimental — no native-module builds on Windows). Git-ignored, rebuildable, zero network.
  - Nodes: file, component, export, props-interface, token, story, test, icon.
  - Edges: imports, renders, uses-token, tests, documents. Ticket edges from commit-message issue refs link code to tickets.
- **Incremental:** `forge graph install-hook` writes a `.git/hooks/post-commit` that reindexes changed files only (plugins cannot install git hooks themselves — explicit opt-in command). `forge:execute`/`forge:ship` also reindex touched files, so the graph stays fresh even without the hook; `forge graph rebuild` does a full pass.
- **MCP tools:** `find_component(query)`, `who_uses(symbol|token)`, `similar_props(interface)`, `blast_radius(files[])`, `code_for_ticket(#n)`, `reuse_candidates(description)` (ranked by export/props/story-text keyword match).
- **Hardening:** parameterized SQL only; MCP tool inputs schema-validated; file-path params canonicalized (no traversal outside the repo root).
- **Consumers:** `librarian` answers "does X already exist" before anything new is written; `scoper` computes touched components + the test set from `blast_radius`; the `implementer` role card mandates a `reuse_candidates` check before creating new files.

## 10. Deploy layer (DevOps)

**Principle: every project is production-deployable from day one — deployability is a standing gate, not a launch-week scramble.** The reference stack is **Docker containers + Terraform IaC**; the concrete templates vary by tech stack, the discipline doesn't.

**Config** — `deploy` block in `forge.json`, behind `features.deploy`:

```jsonc
"deploy": {
  "docker":      { "file": "Dockerfile", "compose": "docker-compose.yml", "healthcheck": "/healthz" },
  "terraform":   { "dir": "infra/", "stateBackend": "gcs" },
  "environments": [
    { "name": "staging",    "branch": "staging", "deploy": "on-push" },  // merge main → staging when a live check is needed
    { "name": "production", "deploy": "promote" }                        // promotes staging's exact artifact, human-gated
  ],
  "previews": false,        // optional: ephemeral env per PR (reviewers judge a running app)
  "migrations": null        // repos with a DB set e.g. { "tool": "…", "dir": "migrations/" }
}
```

**Environments — configurable chain, staging-first, branch-driven:**
- **Local is environment zero:** the compose file gives every repo a free local run; when local build + CI checks suffice, the cloud chain can be as short as `["production"]`.
- **main is CI-only — it never deploys.** Merging to main runs verify/tests/validation, nothing else. Deploys are driven by **environment branches**: when a live check is needed, merge main into the `staging` branch — that push (and only that) builds the image (tagged with the commit SHA) and deploys staging. On-demand staging keeps deploy + CI cost near zero between live checks.
- **Environment branches are protected — merging into one is a human act.** Agents never push or merge to environment branches; that merge *is* the deploy authorization. The deploy workflow updates the running service's image (an app-level rollout, not a `terraform apply` — infra changes stay separately gated).
- **Staging is prod-shaped:** same Terraform modules, same secret-manager pattern, smaller sizing. It exists because with cloud infra there is often no meaningful dev env — IAM bindings, DNS, and service wiring can only be verified live.
- **Promotion, not rebuild:** the production workflow deploys the registry image already recorded for that commit SHA (built by the staging workflow) — never a fresh build. `forge:release` retags that digest with the semver name (section 4), and production runs only release-named digests. Post-deploy **smoke tests** (healthcheck + critical-path probes) run against staging after deploy and against production after promote.
- **The chain is per-repo config:** static site → `["production"]`; real app → staging + production. Every environment maps to an environment branch; in a single-environment chain, production gets its own branch and its workflow builds (no prior build exists) — the human-merge gate and smoke tests still apply. `previews: true` adds per-PR ephemeral envs (backlog — section 12). Same philosophy as the team block.

- **Scaffolding at project start:** `forge init` (fresh repo) offers the deploy scaffold from `plugin/templates/deploy/<stack>/` — multi-stage Dockerfile (non-root user, base image pinned by digest), `.dockerignore`, compose file for local run, a Terraform skeleton (remote state with locking, one directory per configured environment, provider pinned), and the environment-branch deploy workflows. Adopted repos get the same via `/forge:deploy-init`. Stack templates start with what the owner's repos need (node/static); adding a stack = adding a template directory.
- **`devops` agent role** (section 5): owns Dockerfile/compose/Terraform changes, keeps CI deploy jobs green, reviews infra diffs for cost and blast radius, and runs `terraform plan`. Pinned `claude:*` — infra and CI are attack surface, same trust boundary as `security`.
- **Deploy-readiness gate in `forge:ship`** (when `features.deploy` is on): the consumer CI template gains a job that builds the image and boots it against the healthcheck; `terraform validate` + `plan` (dry-run) must pass when `infra/` changed. **Path-filtered for cost:** the image job runs only when Dockerfile/lockfile/source change, the plan job only when `infra/` changes. A branch that breaks the image or the plan doesn't ship — that's what "always ready to deploy" means mechanically.
- **Apply is never automatic:** `terraform apply` and promotion to production are escalation-gated — `team.policy.approvals.deploy` (default `maintainer`) must approve via the decision flow (section 7). The pipeline prepares deployments; humans pull the trigger.
- **Data lifecycle** (repos with a database, via `deploy.migrations`): migrations are forward-only with a tested rollback story; CI runs them against a disposable instance before merge; staging runs them before production does; backup/restore is owned by the Terraform layer per environment. Declared now so the discipline exists before the first schema change, not after the first bad one.
- **Minimal production observability** (scaffold-wired): an uptime check against each environment's healthcheck and a log-based error alert, so an incident pages the `deploy` approver instead of waiting for a user report. Full APM/dashboards live on the backlog (section 12).
- **Secrets & state:** runtime secrets live in the cloud secret manager (referenced by Terraform, never in the repo or image); Terraform state is remote with locking and is treated as secret-bearing (never committed, never sent to CLI backends — covered by the ignore-file sync, section 13).

## 11. Platform console (forge-console)

Mission control for the fleet: monitoring, remote decisions, and remote triggering across repos and machines. Escalation delivery is one feature; the console's real scope is **observe and drive everything the daemon can see**.

```
Claude Code session ──escalation/telemetry──▶ forge daemon (local, outbound-only)
                                                  │ writes
                                                  ▼
                                        Firestore (queues + state)
                                                  │ Cloud Function
                                                  ▼
                                        FCM push ──▶ device app (per-member, role-scoped)
                                                  │ tap decision / send command
                                                  ▼
                                        Firestore doc ──▶ daemon listener
                                                  ▼
                              .forge/decisions/<id>.json ──▶ session resumes
```

- **Daemon:** one per machine, outbound connections only (Firestore listeners — no open ports, works behind NAT), registers with a machine ID. Multi-machine from day one. "Session resumes" in the diagram means: the daemon relaunches the halted pipeline headlessly (`claude -p --resume <session>`) with the decision file in place — or, without the daemon, the next interactive session reads `.forge/decisions/` and continues (matching section 7's stop-and-wait semantics).
- **Cloud:** Firebase only (Auth + Firestore + Functions + FCM) — free tier covers solo/small-team volume; Cloud Run enters only if a live web dashboard is wanted later.
- **The daemon is also the local runner:** remote commands spawn headless `claude -p` sessions on the owner's machine — zero GitHub Actions minutes, zero cloud compute. CI itself stays on GitHub-hosted runners (2,000 free min/month far exceeds current usage; a self-hosted CI runner would couple merges to the machine being on). Machine off ⇒ commands and escalations queue in Firestore; nothing is lost, and the GitHub-native escalation path (section 7) still works regardless.

**Monitor (read-only telemetry):** machine health + heartbeat per machine; live sessions (repo / ticket / branch / phase from the `.forge/progress.md` ledger + journal, elapsed, idle-vs-working); agent activity (active roles, backend in use, fallback events); cost & usage (token spend per day / repo / backend / role, budget alerts); pipeline & gate feed (per-ticket stage, gate results, CI status mirror, live journal tail across repos); cross-repo board digest with escalations first.

**Control (allowlisted command verbs):** escalation + approvals inbox (structured decisions, spec approvals, distill lessons — tap-to-answer, routed per `team.policy`); remote triggers (start ticket #N, `/distill`, rerun verify, graph rebuild); work queue ("run these 3 tickets overnight", sequential per machine); session control (pause / resume / kill a session or single agent); **global kill switch** (stop every agent on every machine); runner admin (register/deregister machines, daemon logs, remote daemon restart).

**Guardrails (design invariants, enforced daemon-side):**
- The console can **never** push code, merge, or edit files — those live in GitHub behind branch protection. Command verbs are an allowlist; unknown verbs are rejected by the daemon, not merely hidden in the UI.
- **Metadata only in the cloud:** ticket refs, phase names, counts, costs, option labels. Code, diffs, and prompts never enter Firestore/FCM; the app deep-links to GitHub for context.
- Firebase Auth per team member; visibility and command rights scoped by their `team` roles; every command audit-logged in Firestore.

The console graduates to its own repo (`forge-console`) after sub-project 9a — a device app + cloud project has a different lifecycle than a plugin.

## 12. Rollout

Each sub-project = its own spec → plan → epic in the forge repo, executed with the current pipeline (superpowers until forge replaces it), dogfooded on live cms component work (Epics 3–6) before the next starts.

| # | Sub-project | Size | Replaces |
| --- | --- | --- | --- |
| 1 | Plugin skeleton: marketplace, plugin.json, cms install, `forge.json` schema (board/team/features/roster) + `forge init` + `forge doctor` | S | — |
| 2 | Board automation: `forge:board` + scripts (statuses, assignees, digest, log) | M | manual GraphQL |
| 3 | `forge:ship` + `forge:triage` + escalation protocol (GitHub-native) + journal format & append helper + destructive-command denylist hook + consumer CI template | M | ship-and-document ritual |
| 4 | Agent roster + backend adapters (role cards, swap allowlist, agy adapter, fallback logic, pre-send scan, ignore-file sync) | M | generic subagents |
| 4b | Deploy layer: `devops` role card, deploy/<stack> templates, `/forge:deploy-init`, environment-branch workflows, deploy-readiness gate + CI image-build job, smoke tests, observability minimum | M | hand-rolled Dockerfiles/infra |
| 4c | `forge:release`: semver + changelog + tag + GitHub Release + artifact publish | S | manual releases |
| 5 | `forge:plan` + `forge:execute` (scoper + test-architect gates, plan-drift check, dependency-existence guard, `features.e2e` test layer wired) | L | writing-plans + subagent-driven-development |
| 6 | `forge:ideate` + `forge:brainstorm` | M | brainstorming |
| 7 | Learning loop: capture hooks + `/distill` (journal format itself lands in SP3) + digest flow metrics | M | — |
| 8 | Graph RAG MCP (`librarian` goes live; `scoper` upgrades from import-scan to graph) | L | — |
| 9a | Console: daemon + escalation inbox + monitoring basics (then graduates to `forge-console` repo) | L | GitHub-Mobile-only escalation UX |
| 9b | Console control plane: remote triggers, work queue, kill switch, multi-machine admin | L | — |
| 10 | `forge:hotfix` + rollback runbook + incident journal capture | S | — |
| 11 | `forge:maintain`: dependency cadence + CVE triage (pull earlier as a scheduled routine if Dependabot pain returns) | S | hand-triaged Dependabot PRs |

**Staged gates:** `forge:ship` (SP3) launches with degraded gates — generic subagents run the security/reviewer passes and the AC gate maps tests to ticket ACs directly — and upgrades in place as later sub-projects land: role cards + report contract + cite-or-drop (SP4), deploy-readiness gate (SP4b), plan-based AC mapping + plan-drift check (SP5). SP3's deliverable is the ritual and the gate *slots*, not their final occupants.

Superpowers is uninstalled from cms after sub-project 6. Graph RAG is late deliberately: its payoff grows with codebase size, and by then cms has real components to index. The console (9a/9b) consumes sub-project 3's escalation protocol and 7's journal, so it comes after the pipeline skills land; 9b is specced and executed in the `forge-console` repo after 9a's graduation.

**Automation maturity ladder** — "full automation" is a config progression, not a rewrite. Each level is opt-in per repo; the trust boundary holds at every level:

| Level | What changes | Needs |
| --- | --- | --- |
| **L0** | Every gate synchronous with a human (the spec default) | SP3 |
| **L1** | Same gates, tap-to-answer latency — decisions from the phone | Console 9a |
| **L2** | Risk-tiered auto-approval: qualifying specs + fully-green PRs skip the human, journaled + digest-sampled (`policy.autoApprove`, section 3) | 9a + trusted test suite (`features.e2e` on critical paths before enabling auto-merge) |
| **L3** | Scheduled autonomous queue: overnight batch runs, morning decision inbox; quota exhaustion pauses (never fails); blocked tickets skipped when remaining work is disjoint | 9b work queue + parallel-execution backlog piece |

**At every level, permanently human:** production promote, `terraform apply`, `/distill`, security-critical escalations. That ceiling is the design's trust boundary — the reason the levels below it are safe — not a bottleneck to engineer away.

**Backlog (on the roadmap, unscheduled — each becomes a numbered sub-project when picked up):**
- Embeddings / semantic search on the graph (schema keeps an embedding column slot — section 9).
- Non-TypeScript language indexers, added by demand per stack (until then `features.graph: false` gives the import-scan/grep fallback).
- Team coordination automation (auto-assignment balancing, review-load distribution, calendars) — the team *model* ships in sub-project 1; this is the automation on top.
- Console web dashboard (Cloud Run) — the shipped console is daemon + device app.
- Full production APM (metrics dashboards, tracing) — the shipped minimum is uptime + error alerting (section 10).
- Per-PR preview environments (`previews: true`, section 10) — ephemeral env per PR so reviewers judge a running app.
- **Parallel ticket execution** (automation L3 dependency): git worktree per ticket, scoper blast-radius **disjointness check** (only tickets with non-overlapping file sets run concurrently — graph-computed), merge queue so squash-merges land serially.
- **Cloud-session runner fallback**: when no registered machine is online, the work queue falls back to Claude Code cloud sessions instead of stalling.

## 13. Quality, trust & safety

**Quality:**
- forge repo: own GitHub project board, conventional commits + issue refs, feature-branch + PR flow — the platform obeys the workflow it enforces.
- CI `verify`: vitest suites for hooks, board scripts, backend adapters, MCP server (fixture repos as test beds); actionlint; SHA-pinned actions; concurrency cancel.
- Windows-first test cases: CRLF handling, `.cmd` spawn without shell (EINVAL), path-separator comparisons — every recorded Windows lesson becomes a regression test.
- Skills are markdown (not unit-testable) — validated by dogfooding gates: a pipeline skill only retires its superpowers counterpart after shipping at least one real cms epic end-to-end.

**Anti-hallucination (agents claiming things that aren't true):**
- **Cite-or-drop:** every finding/claim must carry a verifiable ref (file:line, command, graph query). Gate scripts verify the ref exists; unverifiable findings are dropped automatically, not debated.
- **Machine evidence only:** verify/test outcomes come from orchestrator-captured exit codes, never from an agent's report. The AC-verification gate consumes the test-runner's JSON reporter output mapped to ACs — not prose.
- **Plan-drift detection:** at ship, the branch's actual touched files are diffed against the plan's file list + scoper's blast radius; deviation escalates (section 7).
- **Dependency-existence guard:** any *new* package must pass a registry check (exists, minimum age, download floor) before install — blocks hallucinated-package (slopsquatting) supply-chain attacks.
- **Honesty clause** in every role card: "unknown" is a valid answer; guessed paths/APIs are a card violation.

**Anti-secret-leak:**
- Adapter **pre-send scan** (pattern + entropy) of every composed prompt before it reaches an external CLI; refuse on hit.
- `backends sync` writes CLI-native ignore files (`.geminiignore`, codex equivalent): `.env*`, `*.pem`, key material, `*.tfstate`, `.terraform/`, `.forge/`.
- Journal capture never logs secrets (denylist on env-looking tokens).
- GitHub **secret scanning + push protection** enabled per repo (`init` sets, `doctor` warns); gitleaks runs in the consumer CI template.
- Outbound console notifications are metadata-only (section 11) — repo content never transits third-party push.
- Terraform state is secret-bearing: remote with locking, never committed, kept away from CLI backends via the ignore-file sync above (section 10).

**Anti-injection:**
- **All external text is data:** GitHub issue bodies, PR comments, CLI-backend reports, web content — quoted/fenced as data in skills, never followed as instructions. Board scripts pass content via GraphQL variables/argv only; hooks and adapters never interpolate untrusted strings into shell commands (in-process APIs or argv arrays only — the format.mjs command-injection lesson).
- MCP graph hardening: parameterized SQL, schema-validated inputs, canonicalized paths (section 9).
- Zero-dependency discipline: plugin scripts are plain Node; `ignore-scripts` so nothing runs postinstall; actions SHA-pinned.
- Deploy supply chain: base images pinned by digest in the scaffolds; Terraform providers version-pinned; scaffolds are static plugin templates, never fetched.
- Managed blocks (`GEMINI.md`/`AGENTS.md`) rendered only from forge.json content and static plugin templates, never from fetched text.

**Blast-radius control (rogue or confused agents):**
- Read-only roles run with read-only tool allowlists (native subagents) or CLI sandbox/read-only flags (adapters).
- Destructive-command denylist in hooks (force push, hard reset, recursive delete, history rewrite) → escalation, not execution.
- Branch protection means no agent path reaches main — or any environment branch — without a human merge.
- `terraform apply` and promotion to production are escalation-gated behind `team.policy.approvals.deploy`, and every deploy requires a human-performed environment-branch merge (section 10) — no agent ever applies infra or deploys on its own.
- Every backend call journaled (role, backend id, prompt hash); every console command audit-logged.
- `security` and all gate roles pinned to Claude (section 5); CLI reports untrusted, always behind Claude `reviewer` + `security` gates.

## 14. Non-goals

Everything planned lives on the rollout roadmap (section 12) — scheduled sub-projects or the backlog. This section is only for what forge will **not** do:

- Replacing Claude Code as orchestrator.
- Self-hosted CI runners — the console daemon covers local *agent* compute (section 11); CI stays GitHub-hosted. Revisit only if Actions minutes cap out.
- A wiki or any knowledge store outside git — `docs/` + route index is the single source (section 2).
