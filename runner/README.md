# forge local self-hosted runner

Scaffolded by `forge:init --runner` (ADR-0005). **Private repositories only** — a
self-hosted runner must never process fork/public-repo PRs (GitHub's documented
fork-PR RCE risk), which is why `forge:init --runner` refuses on a public repo and
why `verify.yml` keeps the `forge-local` runner off any untrusted code path.

Free CI for private repos: Linux legs run at $0 on a local ephemeral container
runner. The Windows leg runs as a normal per-PR check on hosted `windows-latest`
(billed per PR); flip it to a native self-hosted Windows runner (default when a
box is present) to make it free too.

## The one secret — never committed

Steady state uses **just-in-time (JIT) + `--ephemeral`**: a supervisor mints a
one-hour, single-job runner config per job, so no runner credential outlives a
job. The only stored secret is a **fine-grained PAT with just
`Administration: read & write`, scoped to this one private repo**, used solely to
mint JIT configs.

It lives **only** in a gitignored, `chmod 600` file loaded as the runner
service's environment — never in `forge.json`, a Docker `secret:`/build arg, a
machine-level env var (`setx /M`, `/etc/environment`), or an interactive shell.

`~/.forge/runner.env`:

```
FORGE_RUNNER_PAT=github_pat_xxxxxxxx   # fine-grained, Administration-only, this repo
```

```sh
mkdir -p ~/.forge && chmod 700 ~/.forge
# create the file, paste the token, then:
chmod 600 ~/.forge/runner.env
```

`forge:init --runner` added `**/.forge/`, `runner.env`, and `*.runner.env` to
`.gitignore` and the gitleaks allowlist context so the store can never be
committed. `forge:doctor` (ticket #225) asserts it is gitignored, untracked, and
`chmod 600`.

## Confirm readiness — `forge:runner-check`

Once you've done the host setup below, run **`/forge:runner-check`** for a single
go/no-go preflight: it resolves this `runner` block and checks the whole setup
end-to-end — private-repo guard, block valid, host prerequisites (`git`/`gh`/`node`
≥ 22.13, `docker` reachable), PAT-store safety, the runner registered + online for
your labels (plus the windows label when `windows: native`), the `runner/` scaffold,
and the pinned `actions-runner` version — then prints one **READY / NOT READY**
verdict with a fix hint per line. It never reads or prints the PAT. Re-run until READY.

## Enable — Linux / WSL2 (containerized runner)

1. Build the image (`cd runner/linux && docker compose build`) and confirm
   Docker + `gh` are on PATH. The build needs no JIT config — compose uses a
   build-safe default and the per-job config is required only at run time
   (enforced by `entrypoint.sh`).
2. Put the PAT in `~/.forge/runner.env` (chmod 600) — see "The one secret" above.
3. **Install the durable service (the default):**

   ```sh
   cd runner/linux
   bash install-service.sh
   ```

   It writes `~/.config/systemd/user/forge-runner.service` with
   `EnvironmentFile=%h/.forge/runner.env`, `Environment=FORGE_RUNNER_CONCURRENCY=1`,
   `ExecStart=/usr/bin/env node <abs>/supervisor.mjs`, `Restart=on-failure`,
   `RestartSec=10`, `WantedBy=default.target`; runs `systemctl --user daemon-reload`
   then `systemctl --user enable --now forge-runner`; and attempts
   `loginctl enable-linger "$USER"` so the service survives logout/reboot. If linger
   needs privileges it prints the exact `sudo loginctl enable-linger <you>` to run
   (it does not hard-fail). It warns if `~/.forge/runner.env` is missing (the
   service would fail to start). Check it:

   ```sh
   systemctl --user status forge-runner
   journalctl --user -u forge-runner -f
   ```

   Remove it with `bash install-service.sh --uninstall` (disable --now + delete the
   unit; your `~/.forge/runner.env` is left untouched).
4. **Quick test (foreground)** — to sanity-check the supervisor before installing
   the service:

   ```sh
   set -a; . ~/.forge/runner.env; set +a
   FORGE_RUNNER_CONCURRENCY=1 node supervisor.mjs
   ```

   The supervisor reads `FORGE_RUNNER_PAT` from its process environment only.

## Enable — native Windows host runner (default when a Windows box is present)

> Windows PowerShell blocks unsigned scripts by default (`Restricted` policy). Run
> the steps in a session that allows them:
> `Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass` (session-scoped, no
> admin), or invoke via `powershell -ExecutionPolicy Bypass -File .\setup-runner.ps1 …`.

1. `cd runner/windows; .\setup-runner.ps1 -Install` (downloads + checksum-verifies
   the runner binary).
2. **Install the durable service (the default).** Needs an **elevated** shell and
   `nssm` on PATH (`winget install NSSM.NSSM` or `choco install nssm`):

   ```powershell
   $env:FORGE_RUNNER_PAT = '<token>'   # THIS session only, from your out-of-band store
   .\setup-runner.ps1 -InstallService
   ```

   This registers a `forge-runner` Windows service via NSSM that runs
   `.\setup-runner.ps1 -Serve` with `AppDirectory = runner\windows`,
   `Start = SERVICE_AUTO_START`, restart-on-exit, and
   `AppEnvironmentExtra=FORGE_RUNNER_PAT=<value from $env:FORGE_RUNNER_PAT>`. The PAT
   is read from the session env at install time and **never** written to a committed
   file, `setx /M`, or this repo; the command errors if `$env:FORGE_RUNNER_PAT` is
   unset or the shell isn't elevated. Remove it with
   `.\setup-runner.ps1 -UninstallService` (elevated).
3. **Quick test (foreground)** — before installing the service:

   ```powershell
   $env:FORGE_RUNNER_PAT = '<token>'
   .\setup-runner.ps1 -Serve
   ```
4. To route `verify.yml`'s Windows leg to this native runner, change the
   `test-windows` job's `runs-on` to `[self-hosted, windows, forge-local]` — that
   makes the per-PR Windows check free too.

## Isolation notes

- **Linux:** ephemeral one-job-per-container (`docker compose run --rm`), fresh
  workspace every job. The docker socket bind-mount is root-equivalent on the
  host — acceptable only because the private-only guard keeps untrusted code off
  the runner.
- **Windows (native):** no per-job container teardown, so collaborator code runs
  on the host. Mitigations: `--ephemeral` (one job per registration), `_work`
  wiped between jobs, the hard private-only guard, and the concurrency cap.
- **Concurrency cap:** set `FORGE_RUNNER_CONCURRENCY` (default 1) so a job can't
  starve the box.
