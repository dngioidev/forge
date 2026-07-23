# Contributing to forge

Thanks for your interest in forge — a portable AI-dev-platform plugin for Claude Code. forge is built *by its own pipeline*: every feature is ticketed, planned, gated, trailed, and merged through the same skills it ships. Contributions follow the same path. This guide gets you from a clone to a merge-ready PR.

## Ground rules (read these first)

forge has a few laws that shape every contribution — they are enforced by mechanical gates, not by reviewer taste:

1. **Ticket-first.** Every change starts as a GitHub issue on the board; silent side-work is not accepted. If you find something out of scope mid-work, open a new issue rather than folding it into an unrelated PR.
2. **Honest verification.** Every PR states what was verified and what was **not**. "Unknown" is a valid answer — an untested claim is not.
3. **Gates are scripts, not opinions.** A refused gate names its reason and the command that unblocks it. Fix the cause or explain why the gate is wrong; don't route around it.
4. **The owner merges every PR.** Contributors open PRs and wait for review; merge is always the maintainer's action.

## Prerequisites

| need | check | fix |
| --- | --- | --- |
| Node ≥ 22.13 | `node --version` | [nodejs.org](https://nodejs.org) (the portable zip works — no admin needed) |
| pnpm 10.14+ | `pnpm --version` | `corepack enable` then `corepack prepare pnpm@10.14.0 --activate` |
| git + a GitHub account | `git --version` | [git-scm.com](https://git-scm.com) |
| gh CLI (for board/PR work) | `gh auth status` | `gh auth login` |

forge's `packageManager` is pinned to `pnpm@10.14.0` in `package.json`; Corepack will honor it automatically.

## Local setup

```bash
git clone https://github.com/dngioidev/forge.git
cd forge
pnpm install
pnpm verify
```

`pnpm verify` runs the full test suite (`vitest run`). A green `pnpm verify` is the single most important signal — **it must pass locally before you open a PR**, and CI runs the same command.

## The forge pipeline (how work flows)

forge's own delivery pipeline, front to back:

```
triage → plan → execute (per-task: scope → failing tests → implement → review) → ship → merge → release
```

- **triage** — one incoming idea/bug becomes a correctly-typed ticket (bug / item / test / chore) with acceptance criteria (AC-IDs) and a board slot.
- **plan** — the ticket becomes a task-by-task plan under `docs/plans/`, each task carrying a Files list, AC-IDs, and a test plan.
- **execute** — the plan is worked task by task: tests come *with* the code (often before it), then implementation, then review.
- **ship** — the gate ladder runs, the PR opens with an AC checklist and honest verification, and trail comments land on the issue.

You do **not** have to run the forge skills to contribute — but your PR is measured against the same gates they enforce, so it helps to know them.

## Branching

Branch off the latest `main`, named `<type>/<issue-number>-<slug>` (the number is the issue you're closing; the slugs below are illustrative):

```
fix/<n>-null-ledger-crash
feat/<n>-parallel-worktrees
docs/<n>-community-health-files
chore/<n>-secret-scan
test/<n>-cover-run-release
```

Spike branches (`spike/...`) are for throwaway research and are never merged.

## Commit format

Conventional Commits, with the driving issue referenced in the body or footer:

```
feat(autopilot): add worktree pool for parallel delivery

Closes #145
```

- Types in use: `feat`, `fix`, `docs`, `chore`, `test`, `refactor`, `perf`.
- An optional scope in parentheses names the area (`autopilot`, `board`, `gates`, `agy`, …).
- Reference the issue with `Closes #N` / `Fixes #N` (auto-closes on merge) or a plain `#N` for a related-but-not-closing link.

`release` derives the CHANGELOG straight from these commits, so an accurate type and scope matter.

## The gate ladder (what a PR is checked against)

`ship` runs these in order; contributors should expect the same bar. The full authoritative ladder (including the `situation` gate and the final `CI green` check) is in the [handbook](docs/guides/handbook.md#6-the-gate-ladder-what-ship-runs-in-order):

| gate | checks |
| --- | --- |
| situation | an active incident / security-response blocks non-hotfix ship |
| conventions | branch / commit / PR naming; spike branches never ship |
| verify | `pnpm verify` is green locally |
| plandrift | touched files stay within the plan's Files list (+ defaults) |
| testintent | pre-existing assertions aren't silently weakened |
| depguard | new deps exist, are ≥ 90 days old, and have ≥ 500 downloads |
| acgate | every acceptance-criterion ID is covered by a passing test |
| docsync | every doc under `docs/` is in the route index (`docs/README.md`); a new skill is in the handbook |
| review / security | role-card review of the diff; criticals block |
| CI green | never ask for merge on red |

If you add or change a doc under `docs/`, add its one-line entry to `docs/README.md`. If you add a skill, mention it in `docs/guides/handbook.md`. These are enforced by the `docsync` gate.

## How PRs are reviewed

1. Open the PR against `main` using the [pull request template](.github/PULL_REQUEST_TEMPLATE.md) — fill in the linked issue, the AC coverage, and the honest verification section.
2. Two automated role passes run on the diff: a **reviewer** (correctness → simplification → efficiency) and a **security** pass (injection, secrets, supply chain, CI/hook surface). Both report severity-tagged findings; any critical/high must be resolved.
3. `CODEOWNERS` requests the maintainer as reviewer automatically.
4. The maintainer reviews and merges. PRs are squash-merged; keep the PR title in conventional-commit form since it becomes the squash commit.

## Reporting bugs & proposing features

Use the issue templates — [bug report](.github/ISSUE_TEMPLATE/) or feature request — so your report lands with the fields triage needs (repro/expected/actual for bugs; problem/proposal/acceptance criteria for features).

## Code of conduct & security

By participating you agree to the [Code of Conduct](CODE_OF_CONDUCT.md). To report a security vulnerability, follow [SECURITY.md](SECURITY.md) — **do not** open a public issue for security reports.

## License

forge is MIT-licensed. By contributing, you agree that your contributions are licensed under the same [MIT License](LICENSE).
