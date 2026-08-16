# ADR-0005 — Local self-hosted runner: PAT/secret model, sharing path, isolation, OS coverage, advanced-CI

**Date:** 2026-07-23 · **Status:** **accepted** (owner sign-off 2026-07-23, AC1 gate cleared — build AC2–AC6 authorised). **Superseded in practice for this repo by [#426](https://github.com/dngioidev/forge/issues/426) (2026-08-16, #462 annotation):** `dngioidev/forge` went public and CI here now runs hosted-only (`.claude/forge.json` `runner.enabled: false`); this ADR remains the accepted design for the **private-fork opt-in** case. · **Ticket:** #180 · **Route:** spike (deliverable = this decision record; the throwaway spike branch `spike/180-local-self-hosted-runner` never merges)

## Context

Ticket #180 proposes an **opt-in, private-only** forge capability that scaffolds and uses a **local self-hosted GitHub Actions runner** so private repos get free CI. Private repos have a metered monthly Actions-minute cap and the Windows leg bills at 2× — a local runner drops GitHub billing to $0 and, once compute is free, lets forge afford heavier pipelines.

AC1 is the gate: a design spike must resolve five owner decisions and the owner must approve before any build (AC2–AC6). This ADR is that spike's deliverable. It grounds each recommendation in (a) GitHub's official self-hosted-runner docs and (b) this repo's actual CI artifacts. Where a decision genuinely depends on the owner's account topology or risk tolerance rather than on evidence, it is flagged and routed to the escalation instead of being invented (crazy-mode ground gate).

**This repo's actual pipeline (grounded):**
- `.github/workflows/verify.yml` — matrix `os: [windows-latest, ubuntu-latest]`, each running `pnpm verify` (Node 22 + pnpm); plus `actionlint` (via `docker://rhysd/actionlint`) and `plugin-validate` (`claude plugin validate ./plugin --strict`) on `ubuntu-latest`. Trigger is `pull_request` (NOT `pull_request_target`), read-only `GITHUB_TOKEN`, no `secrets.*` referenced — deliberate fork-PR hardening (see `docs/security/oss-ci-hardening.md`).
- `.github/workflows/secret-scan.yml` — gitleaks over full history, `docker://ghcr.io/gitleaks/gitleaks`, on push/PR.
- Deploy layer already exists as templates: `plugin/templates/deploy/node/{Dockerfile,docker-compose.yml}` + Terraform under `infra/envs/{staging,production}` and `infra/modules/observability` (spec §10, build-once law).
- `.claude/forge.json` is **committed** (board IDs + conventions) — confirms decision-1's premise: a PAT must never live in `forge.json`.
- **This repo (`dngioidev/forge`) is currently `isPrivate: true`** but is being hardened for a public OSS release (recent commits #210/#216/#218/#219). So it is a live candidate for the local runner *today*, and the private-only refusal must fire at the exact moment it flips to public.

## Owner sign-off (AC1) — approved with two amendments

The owner approved ADR-0005 (2026-07-23) on the `esc-180` escalation, choosing **option 1 (approve)** with two refinements to the storage medium and the Windows path. The amendments are folded into Decisions 1 and 4 below and marked **[owner-amended]**:

1. **PAT storage** — the gitignored `~/.forge/runner.env` store is delivered as a **file-backed, *service-scoped* environment file** (loaded only into the runner service's environment), and `init` prompts the user at enable-time with per-OS setup instructions. Machine-level and interactive-shell-global env variables are explicitly discouraged.
2. **Windows coverage** — the **non-containerized native Windows host runner is promoted from an "advanced escape hatch" to a supported, default setup path** when a Windows box is present, retaining one nightly hosted `windows-latest` drift check and hosted-Windows as the fallback when no Windows box is available.

All five decisions are otherwise approved as written. Build (AC2–AC6) is authorised and decomposed into #224–#227.

## Decisions

### Decision 1 — PAT / secret handling (critical) → **RECOMMEND: JIT ephemeral registration, no stored PAT in the steady state; a fine-grained "Administration" PAT only as the local mint credential, in a file-backed, service-scoped, gitignored machine store — never a Docker secret, never `forge.json`, never a machine-level or interactive-shell-global env var.** [owner-amended]

Grounded facts:
- Registering a runner needs admin-level auth. Classic scope is `repo` (repo-level) or `admin:org` (org-level, plus `repo` for private repos); the caller must have admin access to the target. The fine-grained equivalent is the repository/org **"Administration" permission (read & write)** — this is the minimum, repo-scoped credential to prefer over a broad classic PAT. [GitHub REST — self-hosted runners]
- **Just-in-time (JIT) runners** eliminate long-lived registration credentials: `POST /repos/{owner}/{repo}/actions/runners/generate-jitconfig` (or the `/orgs/{org}/…` form) returns a config that lets a runner "run a single job before being automatically removed," and lets you "improve the security of your self-hosted runner infrastructure by limiting the exposure of long lived credentials." [GitHub Changelog 2023-06-02] The registration token itself expires after one hour. [GitHub REST — self-hosted runners]

Recommended model (defence in depth, weakest-credential-wins ordering):
1. **Steady state = JIT + `--ephemeral`.** A tiny local supervisor mints a one-hour JIT config per job and starts a single-use container; no runner credential outlives a job. This is the target and what the generated compose/supervisor should do.
2. **The one stored secret = a fine-grained PAT with only "Administration: read & write", scoped to the exact private repos** the box serves — used solely to call `generate-jitconfig`. **[owner-amended]** It lives in a **machine-level, gitignored `~/.forge/runner.env` (chmod 600)** and is loaded **only as the runner service's environment** (systemd `EnvironmentFile=~/.forge/runner.env` on Linux/WSL; the Windows service's own environment, or NSSM `AppEnvironmentExtra`, on Windows native) — so the token never enters the user's interactive shell environment where an ambient process (e.g. an `npm install` postinstall) could read `process.env`. It is **not** a Docker `secret:`/build arg (bakes into layers/inspectable history), **never** in `forge.json` or any committed file, and **not** a machine-level (`setx /M`, `/etc/environment`) or user-global shell env var (broad ambient exposure). `init` must:
   - print **per-OS enable-time setup instructions** (write `~/.forge/runner.env`, register the service to read it) rather than ever writing the secret itself;
   - add `**/.forge/`, `runner.env`, `*.runner.env` to `.gitignore` and the gitleaks allowlist context;
   - and `doctor` must assert the store is **gitignored + not tracked + chmod 600** (a check the file-backed store supports and a bare `setx` var could not).
3. Prefer the org-app path (GitHub App installation token) over a PAT **only** if the sharing decision (Decision 2) lands on a real org — an App is auditable and revocable per-install; out of scope for personal-account solo mode.

**PAT leak blast-radius (documented, as AC1 requires):**
- *Fine-grained "Administration"-only PAT, one private repo:* attacker can register/remove **runners** on that repo and read/modify runner config — they cannot read code, secrets, or Actions logs, and cannot push. Worst case: register a malicious runner to intercept that repo's private-repo jobs (which do expose that repo's Actions secrets to jobs). Contained to one repo; revoke the token to stop it. This is why the token is fine-grained + single-repo, not classic `repo`.
- *Classic `repo` PAT (rejected):* full read/write to code, secrets, and all the user's private repos — catastrophic. Explicitly not used.
- *A leaked JIT config:* single-job, one-hour TTL, auto-removes — minimal window, self-expiring. This is the whole point of preferring it.
- *The runner's own `GITHUB_TOKEN` at job time* is GitHub-issued, job-scoped, and auto-expires; the design does not add standing secrets to jobs.

### Decision 2 — Personal vs org sharing → **RECOMMEND: ship BOTH, default to per-repo registration for solo/personal accounts; document that true "one runner, many repos" sharing requires a (free) org, and offer it as an opt-in `sharing: org` mode. The account-topology choice itself is the owner's.**

Grounded facts:
- "A self-hosted runner can only be registered to one repository, one organization, or one enterprise at a time." Repo-level runners serve one repo; **org-level runners can process jobs for multiple repositories.** [GitHub — about self-hosted runners]
- Personal-account repos **cannot** share an org runner group; runner groups are an org/enterprise construct. The documented way to get one box serving many repos is an **organization-level runner**. [GitHub — managing access using groups; community discussion #179202]

Recommendation:
- **`sharing: "repo"` (default, solo/personal):** the plugin registers the same physical box **per private repo** (each repo gets its own JIT registration against the one host). "Many repos share one box" is achieved operationally (one machine, N registrations), not by a shared org runner. Honest boundary: N registrations to maintain, but zero org setup and works on a bare personal account.
- **`sharing: "org"` (opt-in):** if the user has (or creates a free) org and moves the private repos into it, the plugin points at an **org runner group** so one registration serves all repos. This is the only path where sharing is "real" in GitHub's model.
- **Owner decision (resolved):** the owner approved **`sharing: "repo"` as the shipped default**; `sharing: "org"` remains available opt-in. The plugin supports both.

### Decision 3 — Isolation / concurrency → **RECOMMEND: ephemeral one-job-per-container runners (`--ephemeral` + JIT), a dedicated custom label for routing, and a hard concurrency cap on the box.**

Grounded facts:
- JIT/ephemeral runners run exactly one job then are removed [GitHub Changelog 2023-06-02] — the recommended primitive for autoscaling/isolation so repos/jobs can't poison a reused workspace.
- GitHub's own guidance: "We recommend that you only use self-hosted runners with private repositories" because "forks of your public repository can potentially run dangerous code on your self-hosted runner machine." [GitHub — self-hosted runner security] Isolation must therefore assume even private-repo code is only as trusted as repo collaborators.

Recommendation:
- **Ephemeral container per job** (fresh workspace, torn down after) — no cross-job/cross-repo state.
- **Label routing:** the runner registers with a distinct custom label (e.g. `forge-local`), and the generated `verify.yml` targets `runs-on: [self-hosted, linux, forge-local]` **only** for private-repo Linux legs. Hosted labels stay for everything else, so a mis-config can't silently pull public/hosted jobs onto the box.
- **Concurrency cap:** limit simultaneous jobs on one box (e.g. 1–2, sized to host cores) via the supervisor + workflow `concurrency:` group (verify.yml already uses `cancel-in-progress` per ref — keep it).
- Non-negotiable guard: `init`/`doctor` refuse runner wiring when `gh repo view --json isPrivate` is false, with a clear message — this is the fork-PR RCE mitigation GitHub explicitly calls out, and the reason this very repo must lose the runner the moment it goes public.

### Decision 4 — OS coverage → **RECOMMEND: local runner covers Linux legs via container; the native Windows host runner is a supported, default setup path when a Windows box is present (owner-promoted), covering the Windows leg locally; keep one nightly hosted `windows-latest` drift check and hosted-Windows as the fallback when no Windows box is available.** [owner-amended]

Grounded in this repo: `verify.yml` runs the matrix on `windows-latest` + `ubuntu-latest`, both running `pnpm verify`; `actionlint` and `plugin-validate` are already Linux-only. A Linux-container runner covers ubuntu + both Linux-only jobs cleanly. Windows-in-container needs Windows-container mode (heavy, host-version-locked) — poor fit for a solo box; a **native** Windows host runner avoids it entirely and runs `pnpm verify` on real Windows exactly as the developer runs it locally. The owner develops on Windows 11, so the Windows box already exists — the natural topology is **one Windows machine hosting a native Windows runner (Windows legs) + a WSL2/Docker Linux runner (Linux legs)**, giving true "one box, shared across repos" for both OSes.

Recommendation:
- **Linux legs:** containerized Linux runner takes all Linux legs (matrix `ubuntu-latest`, `actionlint`, `plugin-validate`).
- **Windows leg [owner-amended]:** when a Windows box is present, a **non-containerized native Windows host runner** (a Windows service, registered `--ephemeral`) takes the Windows leg locally at $0 — this is now the **default** setup path, not an escape hatch. It fully eliminates the 2× Windows hosted spend (the stated cost driver), not just trims it.
  - **Isolation caveat (documented):** a native host runner has no per-job container teardown, so collaborator code runs on the developer's machine. Mitigations: `--ephemeral` (one job per registration) + wipe the `_work` directory between jobs + the **hard private-only guard** (never public/fork PRs — non-negotiable) + the Decision-3 concurrency cap so a job can't starve the machine.
  - **Drift guard:** keep **one nightly hosted `windows-latest` run** so "works on my box" (host OS drift vs the clean hosted image) can't hide.
  - **Fallback:** when no Windows box is available (e.g. a Linux-only host, or a Mac/Linux contributor), the generated `verify.yml` keeps the Windows leg on hosted, trimmed to `push: [main]` + a nightly `schedule:` — PRs run Linux-only on the free local runner. (This is the CI-cost thread's "Windows → main-only + nightly; PRs Linux-only" trim, now the fallback rather than the default.)

### Decision 5 — Advanced-CI upside → **RECOMMEND: turn on, in order, (a) full Linux matrix per PR, (b) the existing deploy-layer verify (build + `terraform plan` smoke, no apply), (c) a nightly rail: `forge:maintain` + graph reindex + a security pass. Gate anything that spends real money behind explicit owner opt-in.**

Grounded in this repo's real, already-present machinery:
- **Deploy layer exists** (`plugin/templates/deploy/node/{Dockerfile,docker-compose.yml}`, Terraform `infra/envs/{staging,production}`, `infra/modules/observability`) — so a "build the image + `terraform plan` diff + compose healthcheck smoke" rail on the free runner is real, not aspirational. Keep the build-once law: build/plan on the runner, never auto-`apply`.
- **`forge:maintain` skill exists** (dependency cadence + CVE triage) — a nightly `schedule:` job on the free runner is the natural home.
- **Graph reindex** — the `forge-graph` MCP index is a natural nightly rebuild on free compute.
- **Security pass** — `secret-scan.yml` (gitleaks full-history) already exists; a nightly deeper pass (e.g. dependency/advisory sweep via maintain) fits the same rail.

Recommendation: the generated pipeline enables **(a)** full Linux matrix per PR immediately (free), **(b)** deploy-layer build + plan smoke on PR/main (no apply; anything that provisions real infra or hits a paid API is off by default and owner-gated), and **(c)** a **nightly** consolidated rail (`maintain` + graph reindex + security sweep) since those are latency-tolerant and heavy. This is upside the metered-minute pipeline could never justify, now affordable because Linux compute is $0.

## Consequences

- **AC1 is cleared** — the owner signed off (2026-07-23) with the two amendments above. AC2–AC6 are authorised and decompose into child tickets under #180:
  - **#224** — scaffold assets (Dockerfile + compose + trimmed workflow) + private-only refusal (AC2/AC3); carries the Decision-1 file-backed service-scoped env store + per-OS enable instructions and the Decision-4 native-Windows path.
  - **#225** — `doctor` runner-health check (AC4): registered + online when enabled, plus the store gitignored/untracked/chmod-600 assertion.
  - **#226** — `forge.json` `runner` block + docs (AC5): labels, `sharing` mode, windows policy; solo-vs-team + private-only boundary documented.
  - **#227** — end-to-end dogfood on the local runner (AC6): requires the owner to provision the physical runner + mint the fine-grained PAT, so this ticket is expected to pause for owner machine setup.
- **Recovery / throwaway:** the spike *branch* is deleted after write-up; nothing there is merged. This ADR (the decision record) lands on `main` alongside ADR-0001…0004. Any code sketched during the spike is re-implemented properly through plan/execute, never cherry-picked.

## Sources (grounded)

- GitHub Docs — *Self-hosted runners: managing access / security* (public-repo & fork-PR RCE warning; "only use self-hosted runners with private repositories"): https://docs.github.com/en/actions/how-tos/manage-runners/self-hosted-runners/manage-access
- GitHub Docs — *About self-hosted runners* (a runner registers to one repo/org/enterprise; org runners serve many repos; personal repos need an org to share): https://docs.github.com/en/actions/hosting-your-own-runners/about-self-hosted-runners
- GitHub Docs — *Managing access to self-hosted runners using groups* (runner groups are org/enterprise-level): https://docs.github.com/en/actions/hosting-your-own-runners/managing-access-to-self-hosted-runners-using-groups
- GitHub Changelog — *Just-in-time self-hosted runners* (single-use runner, limits long-lived-credential exposure): https://github.blog/changelog/2023-06-02-github-actions-just-in-time-self-hosted-runners/
- GitHub Docs — *REST API endpoints for self-hosted runners* (registration-token/`generate-jitconfig`; `repo` / `admin:org` scope; admin access; token 1-hour expiry): https://docs.github.com/en/rest/actions/self-hosted-runners
- GitHub community discussion #179202 — personal-account runner sharing across projects (org-level runner is the sharing path): https://github.com/orgs/community/discussions/179202
- This repo: `.github/workflows/verify.yml`, `.github/workflows/secret-scan.yml`, `.claude/forge.json`, `plugin/templates/deploy/node/{Dockerfile,docker-compose.yml,infra/**}`, `docs/security/oss-ci-hardening.md`; live visibility `gh repo view --json isPrivate` → `true` (2026-07-23).
