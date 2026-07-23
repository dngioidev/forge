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

## Enable — Linux / WSL2 (containerized runner)

1. Build the image and confirm Docker + `gh` are on PATH.
2. Register the supervisor as a **systemd** service that loads the secret as its
   environment (never an interactive shell):

   ```ini
   # /etc/systemd/system/forge-runner.service
   [Service]
   EnvironmentFile=%h/.forge/runner.env
   ExecStart=/usr/bin/node %h/<repo>/runner/linux/supervisor.mjs
   Restart=always
   ```

   `systemctl --user enable --now forge-runner` (or a system unit under the
   service account). The supervisor reads `FORGE_RUNNER_PAT` from the service
   environment only.

## Enable — native Windows host runner (default when a Windows box is present)

> Windows PowerShell blocks unsigned scripts by default (`Restricted` policy). Run
> the steps in a session that allows them:
> `Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass` (session-scoped, no
> admin), or invoke via `powershell -ExecutionPolicy Bypass -File .\setup-runner.ps1 …`.

1. `cd runner/windows; .\setup-runner.ps1 -Install` (downloads + checksum-verifies
   the runner binary).
2. Register a Windows service (e.g. NSSM) that runs `.\setup-runner.ps1 -Serve`
   with the PAT supplied via the **service environment** — NSSM
   `AppEnvironmentExtra=FORGE_RUNNER_PAT=<token>` reading your out-of-band store —
   not `setx`, not this repo.
3. To route `verify.yml`'s Windows leg to this native runner, change the
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
