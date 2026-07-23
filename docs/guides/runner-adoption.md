# Local self-hosted runner — adoption guide & runbook

How to give a **private** repo free CI on a local self-hosted GitHub Actions runner, and how to get past the issues you'll hit doing it. Design rationale lives in [ADR-0005](../decisions/0005-local-self-hosted-runner.md); the scaffolded per-repo operator notes live in `runner/README.md` after you run `forge:init --runner`. This guide is the cross-project adoption + troubleshooting layer, written from a real end-to-end dogfood (epic #180).

> **Private repos only.** A self-hosted runner must never process fork/public-repo PRs — forks can run untrusted code on your machine (GitHub's documented fork-PR RCE). `forge:init --runner` **refuses on a public repo**, and `forge:doctor` fails if the feature is on while the repo is public. When a repo goes public, remove the runner.

## When to use it

- The repo is **private** and hitting the monthly Actions-minute cap, or the Windows leg's 2× billing dominates cost.
- You have a machine that can stay on to host the runner(s).
- You want richer CI (full matrix, deploy smoke, nightly rails) that metered minutes couldn't justify.

Once compute is free, the only hosted cost left is whatever you deliberately keep on hosted.

## Prerequisites

- A **private** GitHub repo, forge-initialised (`forge:init`).
- A **host machine** that stays on:
  - **Linux legs** — a Linux box, **or** Windows with **WSL2 + Docker** (Docker Desktop with WSL integration, or native `docker.io` inside WSL).
  - **Windows leg** (optional, for free Windows CI) — a **native Windows** host (no container).
- On the host PATH: `git`, `gh`, `node` (≥ 22.13), and `docker` for the Linux container runner.
- A **fine-grained PAT** scoped to **only this repo** with **Administration: read & write** — nothing else. This is the JIT-mint credential (see the secret model below).

## Adopt on a NEW project

1. `forge:init` — bootstrap the board (skip if already initialised).
2. `forge:init --runner` — scaffolds `runner/` (Dockerfile, compose, supervisor, native-Windows `setup-runner.ps1`, README), a `verify.runner.yml`, and the `.gitignore` / `.gitleaks.toml` guards for the PAT store. Refuses on a public repo.
3. **Enable the runner in `forge.json`** (currently a manual step — the scaffold does not write it):
   ```json
   "runner": {
     "enabled": true,
     "labels": ["self-hosted", "linux", "forge-local"],
     "sharing": "repo",
     "windows": "hosted"
   }
   ```
   Set `windows` to `"native"` only once a native Windows runner is actually running (see below).
4. Do the **one-time host setup** for each OS leg (next section).
5. **Run `/forge:runner-check` to confirm readiness.** This is the go/no-go preflight — it resolves the `runner` block and checks the whole setup end-to-end (private-repo guard, block valid, host prerequisites, PAT-store safety, runner registered + online for your labels, scaffold present, version not stale), then prints a single **READY / NOT READY** verdict with a fix hint on every line. Fix any ✗, re-run until READY. (`forge:doctor` still prints a one-line runner-health summary as part of the general health check; `runner-check` is the broader adoption-focused pass.)
6. Commit the scaffold (`runner/`, `verify.runner.yml` → your `verify.yml`, the guards, the `forge.json` block). The installed runner binary dir is gitignored.

## Adopt on an EXISTING project

Same as above, with two differences the scaffold handles for you:

- **It never overwrites your `verify.yml`.** If you already have one, `forge:init --runner` drops the runner variant as **`.github/workflows/verify.runner.yml`** for you to review and swap in.
- **Safe to coexist during review; still swap to finish.** Both files are named `verify`, but the runner variant now carries a **distinct concurrency group** (`verify-runner-${{ github.ref }}`), so committing both during the review window no longer makes them cancel each other — the runner jobs run side-by-side with your incumbent `verify.yml` (fixed in #236; the old shared group silently cancelled the runner jobs). GitHub still runs two "verify" checks until you finish the swap, so replace `verify.yml` with the runner variant (`git rm verify.yml && git mv verify.runner.yml verify.yml`) once you've proven it green.
- **Cut over gradually.** You can point only the Linux legs at `forge-local` first (Windows stays hosted), prove it green, then move the Windows leg to a native runner.

## One-time host setup

### The one secret (both OSes)

The Administration-only PAT lives **only** in a gitignored, `chmod 600` file loaded as the runner **service's** environment — never in `forge.json`, a Docker secret, a machine-level `setx /M`, or an interactive shell global.

- **Linux / WSL:** `~/.forge/runner.env` → `FORGE_RUNNER_PAT=<token>`; the supervisor reads it from its process env (systemd `EnvironmentFile=%h/.forge/runner.env`, or `set -a; . ~/.forge/runner.env; set +a` for a foreground test run).
- **Windows (native):** supply `FORGE_RUNNER_PAT` via the service environment (NSSM `AppEnvironmentExtra=FORGE_RUNNER_PAT=<token>`), or `$env:FORGE_RUNNER_PAT = '<token>'` for a foreground test run.

Steady state is **JIT + `--ephemeral`**: the supervisor mints a one-hour, single-job runner config per job, so no runner credential outlives a job. A leaked PAT is one revocable, single-repo, Administration-only token that can't read code or secrets.

### Linux legs (WSL2 / Docker container runner)

1. Ensure `docker`, `gh`, `node` are on the WSL PATH and the Docker daemon is reachable (`docker info`).
2. Put the PAT in `~/.forge/runner.env` (chmod 600).
3. Start the supervisor:
   ```bash
   cd runner/linux
   set -a; . ~/.forge/runner.env; set +a      # foreground test; use systemd EnvironmentFile for a service
   FORGE_RUNNER_CONCURRENCY=1 node supervisor.mjs
   ```
   It builds the image on first run, mints a JIT config per job, and runs one ephemeral container per job. Leave it running.
4. For durability, register it as a `systemd --user` service (`EnvironmentFile=%h/.forge/runner.env`) — see `runner/README.md`.

### Windows leg (native host runner)

1. **Execution policy** blocks unsigned scripts by default: `Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass` (session-scoped, no admin), or invoke via `powershell -ExecutionPolicy Bypass -File .\setup-runner.ps1 …`.
2. `cd runner\windows; .\setup-runner.ps1 -Install` — downloads + checksum-verifies + unpacks the runner binary.
3. Set the PAT and serve:
   ```powershell
   $env:FORGE_RUNNER_PAT = '<token>'   # or pull from WSL: (wsl -d <distro> bash -lc 'grep -oP "(?<=FORGE_RUNNER_PAT=).*" ~/.forge/runner.env')
   .\setup-runner.ps1 -Serve
   ```
   It prepends Git Bash to PATH (so `bash`-shebang tools resolve to Git Bash, not WSL), mints a JIT config per job, and runs one ephemeral job at a time. Leave it running.
4. Route the Windows leg to it: set `test-windows`'s `runs-on` to `[self-hosted, windows, forge-local]` and `forge.json` `runner.windows` to `"native"`. Keep a nightly hosted `windows-latest` run if you want a clean-image drift check.
5. For durability, register `-Serve` as a Windows service (NSSM `AppEnvironmentExtra=FORGE_RUNNER_PAT=…`).

## Moving other workflows onto the runner

Any job can move to `runs-on: [self-hosted, linux, forge-local]` — **except `docker://` container actions**, which don't work on the containerized runner (see #238). Replace them with a **pinned, SHA-256-verified binary** step. Examples already converted in this repo:

- **actionlint** — `docker://rhysd/actionlint` → download the pinned `actionlint` binary and run `./actionlint`.
- **gitleaks** (secret-scan) — `docker://ghcr.io/gitleaks/gitleaks` → download the pinned `gitleaks` binary and run `./gitleaks detect --source=. …`.

Keep the supply-chain guard: pin the version and verify the SHA-256 of the download.

## Known issues & solutions (runbook)

Everything below was hit during the #180 dogfood. Ticket numbers link the fix/tracking.

| Symptom | Cause | Solution |
| --- | --- | --- |
| `docker command not found` in WSL | Docker Desktop not running, or WSL integration off for the distro | Start Docker Desktop (wait for **Engine running**); enable Settings → Resources → WSL Integration for the distro. Or install native `docker.io` in WSL (`sudo apt install docker.io docker-compose-v2 && sudo systemctl enable --now docker`). |
| `com.docker.service` Stopped while Docker Desktop is "running" | Docker Desktop backend didn't start | Quit + relaunch Docker Desktop, or `Start-Service com.docker.service` (elevated). |
| `docker compose build` → `required variable ENCODED_JIT_CONFIG is missing` | The compose `:?` guard trips on any command that parses the file, not just `run` (#232) | Skip the separate build — the supervisor builds on first `docker compose run`. Or `ENCODED_JIT_CONFIG=unused docker compose build`. |
| Build fails at `sha256sum -c` with `no properly formatted checksum lines` | The Dockerfile/`setup-runner.ps1` shipped a placeholder `RUNNER_SHA256` (#233) | Pin the current `actions-runner` release version + its published SHA-256 (from the release's `<!-- BEGIN SHA … -->` markers). |
| Runner connects then `Runner version vX is deprecated and cannot receive messages` | The pinned runner version is deprecated by GitHub; ephemeral runners can't auto-update (#233) | Bump `RUNNER_VERSION` to the latest `actions/runner` release + its SHA. Keep it current. |
| Supervisor loops fast, minting a new JIT config every attempt | On a persistent failure the Linux supervisor doesn't back off (#234) | Ctrl-C on any repeating failure; fix the underlying error before restarting. |
| Runner jobs show `cancelled`, never run (older scaffolds) | `verify.yml` and `verify.runner.yml` were both named `verify` and shared a concurrency group (#236) | Fixed: the runner variant now uses a distinct group (`verify-runner-*`) and coexists safely during review. If you scaffolded before the fix, change the variant's `concurrency.group` to `verify-runner-${{ github.ref }}`, then finish the swap (replace `verify.yml` with the runner variant). |
| `docker://` action (actionlint/gitleaks) fails: `no project was found in "/github/workspace"` | The containerized runner's `_work` bind-mount path isn't valid on the host daemon, so the sibling container's workspace is empty (#238) | Replace the container action with a pinned, SHA-verified **binary** step. |
| `setup-runner.ps1` → wall of PowerShell parser errors (`Unexpected token`, `missing terminator`) | Non-ASCII em-dashes; Windows PowerShell 5.1 reads BOM-less scripts as ANSI and mojibakes them (#240) | Keep the script ASCII-only (fixed in the template). If editing, avoid `—`/smart quotes. |
| `.\setup-runner.ps1 … : running scripts is disabled on this system` | Default `Restricted` execution policy | `Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass` (session-scoped, no admin). |
| `test-windows` fails: `Command failed: bash C:\…\plugin\bin\forge …` | On the native runner `bash` resolves to WSL's `System32\bash.exe`, which can't run a `C:\` path (hosted uses Git Bash) | `-Serve` now prepends Git Bash to PATH. If adapting elsewhere, ensure Git Bash wins over WSL bash for the runner process. |
| `Access to the path '…\.runner' is denied` on `-Serve` restart | A Ctrl-C mid-job left JIT config remnants (`.runner`, `.credentials*`) | `-Serve` now self-cleans these each iteration. To recover manually, delete `.runner`, `.credentials`, `.credentials_rsaparams` from `actions-runner\` (no runner process must be holding them). |
| `generate-jitconfig failed` / 403 | The PAT lacks scope | Use a **fine-grained** PAT with **Administration: read & write** on the target repo. |
| `forge:doctor` runner check is silent | `runner.enabled` is not `true` in `forge.json` | Add/enable the `runner` block. (For an explicit go/no-go verdict even when disabled, run `forge:runner-check` — it FAILs on a disabled block rather than staying silent.) |
| `pnpm verify` fails on doctor tests after enabling the runner in `forge.json` | (forge repo only) a test derived its fixture from the live `forge.json` (#237) | Fixed in-repo — fixtures no longer couple to the live config. |
| Hosted jobs red at ~2s: "account payments have failed" | Account-level Actions billing/spend block | This is the problem the runner solves — self-hosted jobs run regardless. Clear billing only if you still want a hosted fallback. |
| Many `offline` runners accumulate on GitHub | Interrupted/failed ephemeral jobs leave orphan registrations | Periodically delete them: `gh api repos/<owner>/<repo>/actions/runners --paginate --jq '.runners[]\|select(.status=="offline")\|.id' \| xargs -I{} gh api -X DELETE repos/<owner>/<repo>/actions/runners/{}`. |

## Operational notes

- **Supervisors must stay up.** Each OS's checks queue until that OS's supervisor is running. If the account's hosted billing is blocked, there is **no hosted fallback** — keep the supervisors running (graduate to systemd `--user` / NSSM for hands-off durability).
- **Keep the runner version current.** GitHub deprecates old `actions-runner` versions; a stale pin silently stops receiving jobs. Bump `RUNNER_VERSION` + SHA on cadence (see #233 for auto-pinning).
- **One box, many repos (personal accounts):** register the same box per private repo (`sharing: "repo"`). True shared runners need a GitHub **org** (`sharing: "org"`).
- **Isolation:** Linux jobs are one-per-container (fresh workspace); the native Windows runner has no per-job container teardown, so it relies on `--ephemeral` + `_work` wipe + the private-only guard. Never point it at untrusted code.

## Reference

- [ADR-0005 — design decisions](../decisions/0005-local-self-hosted-runner.md)
- `forge:runner-check` — end-to-end adoption-readiness preflight (READY / NOT READY); `forge:doctor` — general health check (includes the one-line runner-health summary)
- `runner/README.md` — per-repo operator instructions (generated by `forge:init --runner`)
- [Install guide](install.md) · [Handbook](handbook.md) · [Troubleshooting](troubleshooting.md)
- Open robustness follow-ups: #232, #233, #234 (parent epic #180)
