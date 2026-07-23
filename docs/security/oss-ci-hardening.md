# OSS CI & repo hardening for public contribution

Status: **AC2 + AC4 delivered in-repo; the AC3 Dependabot *config*
(`.github/dependabot.yml`) is committed here too. Enabling the AC3 security
features and applying AC1 branch protection are owner actions to apply at the
public flip (runbook below).**
Refs: #214 (this work) · parent epic #209 (open-source the repo) · #180
(self-hosted-runner integration — private-only) · SECURITY.md.

When the repo goes public it will accept pull requests from strangers, including
from forks. Private-repo defaults are unsafe for that. This document is the
written analysis and the application runbook.

---

## AC2 — Fork-PR CI safety analysis (`.github/workflows/verify.yml`)

**Verdict: safe for untrusted fork PRs.** The active workflow (`verify.yml`) was
audited for the "pwn-request" class of vulnerabilities and hardened. Findings:

### 1. Trigger — `pull_request`, not `pull_request_target` ✅

```yaml
on:
  push:
    branches: [main]
  pull_request:
```

This is the single most important control. `pull_request` checks out and runs the
**fork's** code with a **read-only** `GITHUB_TOKEN` and **no access to repo/org
secrets**. The dangerous alternative, `pull_request_target`, runs in the context
of the **base** repo — with a read/write token and secret access — while it is
trivial to also check out the attacker's code; that combination is the classic
secret-exfiltration / self-approval exploit. `verify.yml` does not use
`pull_request_target` anywhere, and must never be changed to for any job that
executes untrusted PR code.

Rule for future changes: if you ever need `pull_request_target` (e.g. to label
PRs or post a comment), it must run in a **separate** workflow that does **not**
check out or execute PR head code, and does the privileged step only.

### 2. No secrets are exposed to fork code ✅

No job in `verify.yml` references `secrets.*` (not even `secrets.GITHUB_TOKEN`
explicitly). There is nothing for a malicious PR to exfiltrate. `pnpm install
--frozen-lockfile` + `pnpm verify` (vitest), `actionlint`, and `claude plugin
validate` run entirely from the checked-out tree with no credentials.

Note: the **shipped consumer template** `plugin/templates/verify.yml` *does* wire
`secrets.GITHUB_TOKEN` into a `gitleaks` job. That token is the automatic,
per-run GitHub token — under `pull_request` it is read-only for fork PRs and is
scoped by that job's `permissions:` block (`contents: read`, `pull-requests:
read`). That is a template installed into *consumer* repos, not an active
workflow of this repo, and it is already least-privilege; it is called out here
only so a future audit does not mistake it for this repo's CI.

### 3. Least-privilege `permissions:` — top-level and per-job ✅

```yaml
permissions:        # workflow default
  contents: read
jobs:
  test:
    permissions:    # explicit per job (defense in depth)
      contents: read
  actionlint:
    permissions:
      contents: read
  plugin-validate:
    permissions:
      contents: read
```

The top-level block already dropped the token to read-only. `#214` added an
explicit `permissions: { contents: read }` to **every job** so that a future
top-level widening (someone adding `contents: write` or a package/pages scope for
one job) cannot silently grant the other jobs more than they need. No job needs
write, so every job is pinned to `contents: read`.

### 4. Supply-chain pinning ✅ (already in place)

Every third-party action is pinned to a full commit **SHA** with the human-readable
version in a trailing comment (`actions/checkout@08c6903… # v5.0.0`, etc.), and
the actionlint linter itself is pinned by image digest. SHA pinning defeats the
"someone force-pushes a malicious tag" supply-chain attack. Dependabot's
`github-actions` ecosystem (see `.github/dependabot.yml`) keeps these SHAs current
so pinning does not rot.

### 5. No untrusted expansion into `run:` ✅

No `run:` step interpolates attacker-controlled `${{ github.event.* }}` text (PR
title, body, branch name, etc.) into a shell command — the script-injection
vector. All `run:` steps are static commands.

### Residual risk

Under `pull_request`, fork code still executes on a GitHub-hosted runner (it must,
to be tested), but with no secrets and a read-only token the blast radius is
confined to that ephemeral runner. This is the accepted, standard posture for
open-source CI. **Do not** move CI onto a self-hosted runner for the public repo
(see AC4).

---

## AC4 — Private-only features must not leak to the public repo

### Self-hosted runners are forbidden on the public repo

Untrusted fork PRs auto-running on a **self-hosted** runner is a known critical
risk: the runner is a persistent machine on the owner's network/host, and fork
code executing on it can pivot into that environment. GitHub's own guidance is to
never use self-hosted runners for public repositories with fork PRs.

Current state — **clean**: every `runs-on` in this repo is a GitHub-hosted label
(`ubuntu-latest`, `windows-latest`, and the `${{ matrix.os }}` over those two).
There is **no** `runs-on: self-hosted` anywhere, and the platform design spec is
explicit that forge uses **GitHub-hosted CI runners only**
(`docs/specs/2026-07-15-forge-platform-design.md`): the console/control daemon is
the local runner for *agent* work, never for *CI*.

Guard for the future:
- **Never** introduce `runs-on: self-hosted` (or a self-hosted runner-group
  label) in any workflow that triggers on `pull_request`.
- If epic **#180** (self-hosted-runner integration) is ever built, it is
  **private-only**. It must be gated so it can never run untrusted code — e.g.
  restricted to `push`/`workflow_dispatch` on the private repo, or guarded by an
  `if:` on repository visibility / a trusted-author or maintainer-label
  condition — and it must never be enabled on the public fork of this repo.
- #180 is not built yet, so no code guard is required today; this documented
  prohibition is the guard. Revisit it when #180 is planned.

---

## AC1 + AC3 — Owner settings runbook (apply at / after the public flip)

These are GitHub **settings/API** actions, not committable files. They require the
repo to be public and/or GitHub Advanced Security features that only exist on
public repos (free) or with GHAS. Apply them in one pass at the flip. All commands
assume `gh` authenticated as the owner and `REPO=dngioidev/forge`.

```bash
REPO=dngioidev/forge
```

### AC3a — Dependabot (alerts + security updates + version updates)

The version-update config already lives in `.github/dependabot.yml` (npm +
github-actions ecosystems, weekly, patch/minor grouped). Enable the features:

```bash
# Dependabot alerts (needs the dependency graph, which is on by default for
# public repos).
gh api -X PUT "repos/$REPO/vulnerability-alerts"

# Dependabot security updates (auto-PRs for vulnerable deps).
gh api -X PUT "repos/$REPO/automated-security-fixes"
```

Then confirm the version-update runs appear:
Settings → **Code security** → *Dependabot* shows alerts + security + version
updates all on; the first `dependabot.yml` run appears under
**Insights → Dependency graph → Dependabot**.

### AC3b — Secret scanning + push protection

Public repos get **secret scanning** free; **push protection** blocks a commit
that contains a detected secret before it lands.

```bash
gh api -X PATCH "repos/$REPO" -f 'security_and_analysis[secret_scanning][status]=enabled'
gh api -X PATCH "repos/$REPO" \
  -f 'security_and_analysis[secret_scanning_push_protection][status]=enabled'
```

UI equivalent: Settings → **Code security** → *Secret scanning* → Enable, then
*Push protection* → Enable. (Enabling secret scanning first is required before
push protection can be turned on.)

### AC3c — Private vulnerability reporting

Pairs with `SECURITY.md`, which already points reporters to the Security tab's
"Report a vulnerability".

```bash
gh api -X PUT "repos/$REPO/private-vulnerability-reporting"
```

UI equivalent: Settings → **Code security** → *Private vulnerability reporting* →
Enable.

### AC1 — Branch protection on `main`

Require PR review and the `verify` status check, and forbid direct pushes. The
ruleset below is a starting point; **read the autopilot reconciliation note first
— it changes whether you include the required-check now.**

```bash
# Classic branch protection on main. Adjust the required check contexts to the
# job names you want to gate on (see the note below re: CI being down).
gh api -X PUT "repos/$REPO/branches/main/protection" \
  -H "Accept: application/vnd.github+json" \
  --input - <<'JSON'
{
  "required_status_checks": {
    "strict": true,
    "contexts": ["test (ubuntu-latest)", "test (windows-latest)", "actionlint", "plugin-validate"]
  },
  "enforce_admins": false,
  "required_pull_request_reviews": {
    "required_approving_review_count": 1,
    "dismiss_stale_reviews": true,
    "require_code_owner_reviews": true
  },
  "restrictions": null,
  "required_linear_history": true,
  "allow_force_pushes": false,
  "allow_deletions": false
}
JSON
```

Notes on the choices:
- `require_code_owner_reviews: true` uses the existing `.github/CODEOWNERS`
  (`* @dngioidev`), so the maintainer's review is required.
- `enforce_admins: false` lets the owner still act directly if branch protection
  ever wedges a release; flip to `true` for a stricter posture.
- `required_linear_history: true` matches forge:ship / autopilot's squash-or-
  rebase merge model — set it only if you merge with squash/rebase, not merge
  commits.
- `restrictions: null` = no push allow-list beyond the review requirement.

#### ⚠️ Owner decision — required checks vs. autopilot's local-green merge model

`forge:autopilot` (and `forge:ship`) merge on **local-green**: they run
`pnpm verify` + reviewer + security locally and merge, rather than waiting on the
GitHub Actions `verify` check. **Right now CI is down** (Actions quota;
jobs fail at startup with a 0-step `startup_failure` — infra, not the diff). If
you turn on `required_status_checks` for `verify` while CI is down, **every merge
is blocked** until Actions is restored, because the required check can never go
green — including autopilot's own merges.

Two coherent options — the owner must pick:

1. **Required check ON (standard OSS posture).** Include the `verify` contexts
   above. This is the right long-term stance for a public repo, but it means the
   local-green auto-merge path must be reconciled — autopilot cannot merge past a
   required check that is red/pending. Only enable this **once CI is restored**,
   and accept that autopilot then merges only when the GitHub check is green (not
   purely local-green). Consider allowing autopilot to merge via admin/bypass, or
   retire the local-green shortcut for the public repo.
2. **Required review ON, required check OFF (interim).** Apply everything above
   **except** `required_status_checks` (send `"required_status_checks": null`).
   This keeps "no direct pushes + review required" — the contribution-safety win —
   without coupling merges to the currently-broken CI, preserving the local-green
   model. Add the required check later when CI is healthy and the model is
   reconciled.

Recommendation: ship option 2 at the flip (unblocks contribution safety
immediately), then move to option 1 once Actions quota is restored and the
autopilot merge model is decided. This decision is **the owner's** — it is not a
choice this PR can make.

### AC-adjacent — Actions settings for a public repo

Also review in Settings → **Actions** → *General* (UI or `gh api`):
- **Fork pull request workflows**: require approval for **all outside
  collaborators** (or first-time contributors at minimum) before workflows run on
  their PRs. This stops a drive-by PR from spending Actions minutes / probing CI
  before a maintainer looks.
- **Workflow permissions**: set the default `GITHUB_TOKEN` to **read-only** at the
  repo level (belt-and-suspenders behind the per-workflow `permissions:` blocks).
- Leave "Allow GitHub Actions to create and approve pull requests" **off** unless
  a specific automation needs it.

---

## Summary checklist

| AC  | Item | State |
| --- | --- | --- |
| AC2 | `verify.yml` uses `pull_request`, no secrets to forks, per-job least-privilege, SHA-pinned | ✅ delivered (this PR) |
| AC2 | Written safety analysis | ✅ this document |
| AC4 | Self-hosted runner documented private-only; no `self-hosted` in repo | ✅ delivered (this PR) |
| AC3 | `.github/dependabot.yml` (npm + github-actions) | ✅ committed (activates when Dependabot enabled) |
| AC3 | Enable Dependabot alerts + security updates | ⏳ owner at flip (runbook above) |
| AC3 | Enable secret scanning + push protection | ⏳ owner at flip (runbook above) |
| AC3 | Enable private vulnerability reporting | ⏳ owner at flip (runbook above) |
| AC1 | Branch protection on `main` (review + check + no direct push) | ⏳ owner at flip + required-check-vs-autopilot decision |

AC1 and AC3 enablement, and the required-check-vs-local-green decision, are
**owner / at-flip work** and are tracked as such on #214 (left open).
