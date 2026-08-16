# Local self-hosted runner — adoption guide & runbook

How to give a **private** repo free CI on a local self-hosted GitHub Actions runner, and how to get past the issues you'll hit doing it. Design rationale lives in [ADR-0005](../decisions/0005-local-self-hosted-runner.md); the scaffolded per-repo operator notes live in `runner/README.md` after you run `forge:init --runner`. This guide is the cross-project adoption + troubleshooting layer, written from a real end-to-end dogfood (epic #180).

> **Private repos only.** A self-hosted runner must never process fork/public-repo PRs — forks can run untrusted code on your machine (GitHub's documented fork-PR RCE). `forge:init --runner` **refuses on a public repo**, and `forge:doctor` fails if the feature is on while the repo is public. When a repo goes public, remove the runner.

> **This repo is hosted-only since [#426](https://github.com/dngioidev/forge/issues/426) (2026-08-16, #462 annotation).** `dngioidev/forge` went public, so `.claude/forge.json` `runner.enabled` was flipped to `false` and CI now runs entirely on GitHub-hosted runners — see `.github/workflows/verify.yml`'s header comment (`:1-11`), which explains the swap-back. This guide's runbook remains the adoption path for **private repos and private forks** that want the $0 self-hosted opt-in; it does not describe this repo's current CI.

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
3. **Install the durable service (the default):**
   ```bash
   cd runner/linux
   bash install-service.sh
   ```
   It writes a **repo-scoped** `systemd --user` unit `forge-runner-<owner>-<repo>.service` (`EnvironmentFile=%h/.forge/runner.env`, `Environment=FORGE_RUNNER_OWNER=<owner> FORGE_RUNNER_REPO=<repo>`, `Environment=FORGE_RUNNER_CONCURRENCY=1`, `ExecStart=/usr/bin/env node <abs>/supervisor.mjs`, `Restart=on-failure`, `RestartSec=10`, `WantedBy=default.target`), runs `systemctl --user daemon-reload` + `enable --now <unit>`, and attempts `loginctl enable-linger "$USER"` for boot/logout persistence (it prints the `sudo loginctl enable-linger <you>` fallback if that needs privileges, rather than hard-failing). It warns if `~/.forge/runner.env` is missing, and warns (never blocks) if the target differs from `gh repo view` for the current dir. The target is resolved from `--owner`/`--repo` → `FORGE_RUNNER_OWNER`/`FORGE_RUNNER_REPO` → scaffold defaults; `--name <unit>` overrides the unit name. A **second repo installs a distinct unit** (no clobber); the installer **refuses** to overwrite a same-named unit targeting a *different* repo unless `--force`. Check with `systemctl --user status forge-runner-<owner>-<repo>` / `journalctl --user -u forge-runner-<owner>-<repo> -f`; remove with `bash install-service.sh --uninstall` (add `--name <unit>` for a specific unit).
4. **Quick test (foreground)** — to sanity-check before installing the service:
   ```bash
   cd runner/linux
   set -a; . ~/.forge/runner.env; set +a
   FORGE_RUNNER_CONCURRENCY=1 node supervisor.mjs
   ```
   It builds the image on first run, mints a JIT config per job, and runs one ephemeral container per job.

### Windows leg (native host runner)

1. **Execution policy** blocks unsigned scripts by default: `Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass` (session-scoped, no admin), or invoke via `powershell -ExecutionPolicy Bypass -File .\setup-runner.ps1 …`.
2. `cd runner\windows; .\setup-runner.ps1 -Install` — downloads + checksum-verifies + unpacks the runner binary.
3. **Install the durable service (the default).** Needs an **elevated** shell and `nssm` on PATH (`winget install NSSM.NSSM` or `choco install nssm`):
   ```powershell
   $env:FORGE_RUNNER_PAT = '<token>'   # THIS session only; or pull from WSL: (wsl -d <distro> bash -lc 'grep -oP "(?<=FORGE_RUNNER_PAT=).*" ~/.forge/runner.env')
   .\setup-runner.ps1 -InstallService
   ```
   Registers a **repo-scoped** `forge-runner-<owner>-<repo>` NSSM service (override with `-ServiceName`) running `-Serve` (`AppDirectory=runner\windows`, `Start=SERVICE_AUTO_START`, restart-on-exit) with `AppEnvironmentExtra=FORGE_RUNNER_PAT=<value>;FORGE_RUNNER_OWNER=<owner>;FORGE_RUNNER_REPO=<repo>;PATH=…` — the explicit owner/repo make the service target *explicit* (so `-Serve` registers to that repo, not the checkout the script lives in), and the PAT is read from the session env at install time and never written to a committed file, `setx /M`, or this repo. It errors clearly if `$env:FORGE_RUNNER_PAT` is unset or the shell isn't elevated, and warns (never blocks) on a `gh repo view` target mismatch. A **second repo installs a distinct service** (no clobber); it **refuses** to overwrite a same-named service targeting a *different* repo unless `-Force`. Remove with `.\setup-runner.ps1 -UninstallService` (elevated; add `-ServiceName <name>` for a specific service).
4. **Quick test (foreground)** — before installing the service:
   ```powershell
   $env:FORGE_RUNNER_PAT = '<token>'
   .\setup-runner.ps1 -Serve
   ```
   It prepends Git Bash to PATH (so `bash`-shebang tools resolve to Git Bash, not WSL), mints a JIT config per job, and runs one ephemeral job at a time.
5. Route the Windows leg to it: set `test-windows`'s `runs-on` to `[self-hosted, windows, forge-local]` and `forge.json` `runner.windows` to `"native"`. Keep a nightly hosted `windows-latest` run if you want a clean-image drift check.

## Managing the service

Once the durable service is installed (systemd `--user` on Linux, NSSM on Windows),
this is the day-to-day runbook for operating it by hand. The **cockpit**
(`tools/runner-ui/`, #262) is the visual, one-window version of everything in this
section — see [The cockpit](#the-cockpit-toolsrunner-ui-262) below. Every service is **repo-scoped**:
the name is `forge-runner-<owner>-<repo>` (#260), e.g. `forge-runner-dngioidev-forge`,
so one host can serve several repos side by side. Substitute your own `<owner>`/`<repo>`
(and `-ServiceName` / `--name` if you installed under a custom name) below.

> **Ephemeral-JIT, so "nothing running" is normal.** The supervisor mints a one-hour,
> single-job runner per job, so **between jobs the repo shows 0 online runners** even
> though the service is healthy. Judge health by the *service* being Running, not by a
> momentary online count.

### Check status

Confirm the service is up:

- **Windows (per-repo + any legacy):** `Get-Service forge-runner*`
- **Linux:** `systemctl --user status forge-runner-<owner>-<repo>`

Confirm GitHub sees a runner online for this repo (online count; expect 0 at rest, 1
mid-job):

```sh
gh api repos/<owner>/<repo>/actions/runners --jq '[.runners[] | select(.status=="online")] | length'
```

For the full go/no-go across the whole setup (private-repo guard, prerequisites, PAT
store, registration, scaffold, version), run the preflight:

```sh
forge:runner-check     # or /forge:runner-check inside Claude Code; prints one READY / NOT READY verdict
```

### View / tail logs

- **Windows:** NSSM captures the service's stdout/stderr under `runner\windows\logs\`
  (`service.out.log`, `service.err.log`). Tail the error log:

  ```powershell
  Get-Content runner\windows\logs\service.err.log -Tail 50 -Wait
  ```

- **Linux:** the unit logs to the journal:

  ```sh
  journalctl --user -u forge-runner-<owner>-<repo> -f
  ```

### Start / stop / restart

- **Windows (elevated shell):**

  ```powershell
  Restart-Service forge-runner-<owner>-<repo>   # or Stop-Service / Start-Service
  ```

  (Equivalently `nssm restart|stop|start forge-runner-<owner>-<repo>`.)

- **Linux (no elevation needed for `--user`):**

  ```sh
  systemctl --user restart forge-runner-<owner>-<repo>   # or stop / start
  ```

### Inspect the service's target

Useful when a service is running but the repo shows 0 online runners even mid-job -
the service may be registered to a *different* repo (the classic #260 mis-target the
ephemeral-JIT model otherwise hides). Read back the resolved `FORGE_RUNNER_OWNER` /
`FORGE_RUNNER_REPO`:

- **Windows:**

  ```powershell
  nssm dump forge-runner-<owner>-<repo>                       # full config, INCLUDING the secret
  nssm get forge-runner-<owner>-<repo> AppEnvironmentExtra    # owner/repo/PATH - INCLUDING the secret
  ```

  > **Do NOT print the PAT.** `nssm dump` and `nssm get ... AppEnvironmentExtra` both
  > echo the service environment, which contains `FORGE_RUNNER_PAT=<token>` in the
  > clear. Never run these where the output is shared, screen-recorded, pasted into an
  > issue, or written to a log. If you only need the target, eyeball the
  > `FORGE_RUNNER_OWNER` / `FORGE_RUNNER_REPO` fields and discard the rest; if a PAT is
  > exposed, revoke it (it is single-repo, Administration-only, and cheap to rotate).
  > `forge:doctor` / `forge:runner-check` surface the resolved owner/repo **without**
  > ever reading or printing the PAT - prefer them for a routine target check.

- **Linux:** the PAT lives in the gitignored `~/.forge/runner.env` (loaded via
  `EnvironmentFile=`), **not** inline in the unit, so viewing the unit is safe:

  ```sh
  systemctl --user cat forge-runner-<owner>-<repo>   # shows Environment=FORGE_RUNNER_OWNER/REPO; PAT stays in the env file
  ```

### Uninstall

Removes the service (stop + disable/remove + delete the unit). Your PAT store
(`~/.forge/runner.env`) is left untouched.

- **Windows (elevated shell):**

  ```powershell
  cd runner\windows
  .\setup-runner.ps1 -UninstallService                          # add -ServiceName <name> for a specific service
  ```

- **Linux:**

  ```sh
  cd runner/linux
  bash install-service.sh --uninstall                           # add --name <unit> for a specific unit
  ```

### Spotting and removing a redundant legacy `forge-runner`

The default service name changed from a bare `forge-runner` to the repo-scoped
`forge-runner-<owner>-<repo>` (#260), and **nothing is renamed automatically** - an
install from before the change keeps its old bare `forge-runner` until you re-install.
After adopting the repo-scoped name you can end up with **both** a `forge-runner` and a
`forge-runner-<owner>-<repo>` serving the same repo (double registration). Spot it:

- **Windows:** `Get-Service forge-runner*` - a bare `forge-runner` **alongside** the
  repo-scoped one is the redundant legacy service.
- **Linux:** `systemctl --user list-units 'forge-runner*'` (or
  `ls ~/.config/systemd/user/forge-runner*.service`) - a bare `forge-runner.service`
  next to the repo-scoped unit is the leftover.

Remove the legacy one by passing the old name to the normal uninstaller:

- **Windows (elevated):** `.\setup-runner.ps1 -UninstallService -ServiceName forge-runner`
- **Linux:** `bash install-service.sh --uninstall --name forge-runner`

(To deliberately *keep* the old bare name instead, pass `-ServiceName forge-runner` /
`--name forge-runner` at install time - see "Serving multiple repos from one host" in
`runner/README.md`.)

## The cockpit (`tools/runner-ui/`, #262)

Once you are running more than a service or two, the by-hand runbook above gets
tedious. The **cockpit** puts the whole fleet in one place — the visual version of
the "Managing the service" section, decided in
[ADR-0006](../decisions/0006-runner-ui.md) and re-architected as a local web app
in [ADR-0008](../decisions/0008-cockpit-local-web-app.md). Full operator docs live
in [`tools/runner-ui/README.md`](../../tools/runner-ui/README.md).

> **Interim: no runnable cockpit UI (#355).** The original native **PySide6 (Qt)
> desktop app** and its PyInstaller packaging were **removed** in
> [#355](https://github.com/dngioidev/forge/issues/355) to drop the LGPLv3
> dependency ahead of the OSS/MIT flip. There is **no `uv run forge-cockpit`
> launcher right now.** The framework-agnostic Python cores (discovery, control,
> logs, provision, usage, shellout) are retained, and the FastAPI web app
> ([#351](https://github.com/dngioidev/forge/issues/351), cockpit v2) rebuilds the
> UI — fleet view, control, logs, install/uninstall, usage/cost, and an xterm.js
> terminal — on them. **Until #351 lands, use the by-hand runbook above.** When the
> web app ships, this section documents its launch command.

### What the cockpit shows / does (returns with the web app, #351)

- **Fleet view + mis-target flags** — every `forge-runner-<owner>-<repo>` service
  across both OS legs, with target repo, OS/mechanism, service state, and online
  count; a *running* service whose repo shows **0** online runners is flagged
  (the #260 mis-target class made visible).
- **Start / stop / restart** a selected service (Windows NSSM mutations prompt a
  per-action UAC elevation; Linux systemd `--user` needs none).
- **Logs** — read a service's logs (Windows NSSM out/err log; Linux
  `journalctl --user`).
- **Install / uninstall** — a secret-safe flow that drives `setup-runner.ps1` /
  `install-service.sh`; it shows PAT *guidance* only and has **no token field**.

**Secret posture (consistent with ADR-0005/0006):** the cores read service
state only. They never read `~/.forge/runner.env`, never surface the PAT, and
never use a shell — the same non-negotiable invariant as the scaffold.

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
| Repo shows **0 runners** but a service is running; jobs never pick up — no visible error | The service was installed from the wrong checkout / targets a different repo; ephemeral-JIT means nothing shows at rest (#260) | `forge:doctor` / `forge:runner-check` now surface the service's *resolved* owner/repo and warn on this exact case. Re-install with the right `-Owner`/`-Repo` (`--owner`/`--repo`), or inspect: Windows `nssm get <svc> AppEnvironmentExtra`, Linux the unit's `Environment=`. A second repo gets its own repo-scoped service; use `-Force`/`--force` only to deliberately retarget a same-named one. |
| `forge:doctor` runner check is silent | `runner.enabled` is not `true` in `forge.json` | Add/enable the `runner` block. (For an explicit go/no-go verdict even when disabled, run `forge:runner-check` — it FAILs on a disabled block rather than staying silent.) |
| `pnpm verify` fails on doctor tests after enabling the runner in `forge.json` | (forge repo only) a test derived its fixture from the live `forge.json` (#237) | Fixed in-repo — fixtures no longer couple to the live config. |
| Hosted jobs red at ~2s: "account payments have failed" | Account-level Actions billing/spend block | This is the problem the runner solves — self-hosted jobs run regardless. Clear billing only if you still want a hosted fallback. |
| Many `offline` runners accumulate on GitHub | Interrupted/failed ephemeral jobs leave orphan registrations | Periodically delete them: `gh api repos/<owner>/<repo>/actions/runners --paginate --jq '.runners[]\|select(.status=="offline")\|.id' \| xargs -I{} gh api -X DELETE repos/<owner>/<repo>/actions/runners/{}`. |

## Operational notes

- **Supervisors must stay up.** Each OS's checks queue until that OS's supervisor is running. If the account's hosted billing is blocked, there is **no hosted fallback** — keep the supervisors running (graduate to systemd `--user` / NSSM for hands-off durability).
- **Keep the runner version current.** GitHub deprecates old `actions-runner` versions; a stale pin silently stops receiving jobs. Bump `RUNNER_VERSION` + SHA on cadence (see #233 for auto-pinning).
- **One box, many repos (personal accounts):** the service/unit name is **repo-derived** (`forge-runner-<owner>-<repo>`), so installing for a second private repo creates a *distinct* service instead of clobbering the first — one host durably serves several repos at once (`sharing: "repo"`). Each service pins its own explicit target in its environment, so a runner always registers to the repo it was installed for. One fine-grained PAT scoped to `Administration: read & write` on **all** the served repos works for every service. **Backward-compat:** existing installs keep their old bare `forge-runner` service until re-installed — pass `-ServiceName forge-runner` / `--name forge-runner` to keep the old name (also when uninstalling a legacy service). True shared runners still need a GitHub **org** (`sharing: "org"`).
- **Isolation:** Linux jobs are one-per-container (fresh workspace); the native Windows runner has no per-job container teardown, so it relies on `--ephemeral` + `_work` wipe + the private-only guard. Never point it at untrusted code.

## Reference

- [ADR-0005 — design decisions](../decisions/0005-local-self-hosted-runner.md)
- `forge:runner-check` — end-to-end adoption-readiness preflight (READY / NOT READY); `forge:doctor` — general health check (includes the one-line runner-health summary)
- `runner/README.md` — per-repo operator instructions (generated by `forge:init --runner`)
- [ADR-0006 — runner fleet cockpit](../decisions/0006-runner-ui.md) · [`tools/runner-ui/README.md`](../../tools/runner-ui/README.md) — the desktop cockpit that automates this runbook (#262)
- [Install guide](install.md) · [Handbook](handbook.md) · [Troubleshooting](troubleshooting.md)
- Open robustness follow-ups: #232, #233, #234 (parent epic #180)
