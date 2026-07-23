<#
  forge native Windows host runner (ADR-0005 decision 4, owner-amended).

  When a Windows box is present this is the DEFAULT path for the Windows leg: a
  native runner (no container) running `pnpm verify` on real Windows exactly as
  the developer does. It registers `--ephemeral` (one job per registration) and
  wipes _work between jobs; the hard private-only guard (never fork/public PRs)
  plus the Decision-3 concurrency cap are the isolation contract for host-level
  execution. Routing verify.yml's Windows leg here makes the per-PR Windows check
  free instead of billing on hosted windows-latest.

  SECRET HANDLING (critical): the Administration-only PAT is read ONLY from this
  process's environment ($env:FORGE_RUNNER_PAT), which the Windows *service*
  supplies (the service's own environment, or NSSM `AppEnvironmentExtra`) from an
  out-of-band store - NEVER from this script, `forge.json`, a machine-level
  `setx /M`, or an interactive-shell-global var. This script never writes the
  secret. It is handed to `gh` via the child env (GH_TOKEN), never on argv, and
  never logged.

  Enable (run once to install the runner binary, then register the service):
    1. gh auth is NOT used for minting - the service provides $env:FORGE_RUNNER_PAT.
    2. .\setup-runner.ps1 -Install            # downloads + unpacks the runner
    3. Register a Windows service (e.g. NSSM) that runs:  .\setup-runner.ps1 -Serve
       with AppEnvironmentExtra=FORGE_RUNNER_PAT=<token from your secret store>
  See runner/README.md for the full per-OS instructions.
#>
[CmdletBinding()]
param(
  [switch]$Install,
  [switch]$Serve,
  [string]$Owner = '{{OWNER}}',
  [string]$Repo = '{{REPO}}',
  [string]$Label = '{{LABEL}}',
  [string]$RunnerVersion = '2.336.0',
  # Pin the published SHA-256 for actions-runner-win-x64-<version>.zip. Keep current
  # (GitHub deprecates old runner versions); see #233 for auto-pinning at scaffold time.
  [string]$RunnerSha256 = 'd59123a43003e357b0805b5d0f611d0bd2f65ab67d51bd070dd4e7a0f685c162'
)

$ErrorActionPreference = 'Stop'
$RunnerDir = Join-Path $PSScriptRoot 'actions-runner'

function Write-Log([string]$Message) {
  # Never interpolate the PAT or a JIT config into a log line.
  Write-Host "[forge-runner $([DateTime]::UtcNow.ToString('o'))] $Message"
}

function Install-Runner {
  New-Item -ItemType Directory -Force -Path $RunnerDir | Out-Null
  $zip = Join-Path $env:TEMP "actions-runner-win-x64-$RunnerVersion.zip"
  $url = "https://github.com/actions/runner/releases/download/v$RunnerVersion/actions-runner-win-x64-$RunnerVersion.zip"
  Write-Log "downloading actions runner $RunnerVersion"
  Invoke-WebRequest -Uri $url -OutFile $zip
  $actual = (Get-FileHash -Path $zip -Algorithm SHA256).Hash
  if ($actual -ne $RunnerSha256.ToUpper()) {
    throw "runner checksum mismatch: got $actual, expected $RunnerSha256 (supply-chain guard - refusing to install)"
  }
  Expand-Archive -Path $zip -DestinationPath $RunnerDir -Force
  Remove-Item $zip -Force
  Write-Log "runner unpacked to $RunnerDir"
}

function New-JitConfig {
  $name = "forge-local-win-$([Guid]::NewGuid().ToString('N').Substring(0,8))"
  # PAT to gh via child env (GH_TOKEN), never on the command line.
  $prev = $env:GH_TOKEN
  $env:GH_TOKEN = $env:FORGE_RUNNER_PAT
  try {
    $jit = & gh api -X POST "/repos/$Owner/$Repo/actions/runners/generate-jitconfig" `
      -f "name=$name" -F 'runner_group_id=1' `
      -f 'labels[]=self-hosted' -f 'labels[]=windows' -f "labels[]=$Label" `
      -f 'work_folder=_work' --jq '.encoded_jit_config'
    if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($jit)) {
      throw "generate-jitconfig failed (exit $LASTEXITCODE)"
    }
    return $jit.Trim()
  } finally {
    $env:GH_TOKEN = $prev
  }
}

function Serve-Runner {
  if (-not $env:FORGE_RUNNER_PAT) {
    throw 'FORGE_RUNNER_PAT is not set - the service must supply it (NSSM AppEnvironmentExtra). Refusing to start.'
  }
  if ($Owner -like '{{*') { throw 'owner/repo not substituted - re-run forge:init --runner in the target repo.' }
  Write-Log "serving $Owner/$Repo on label `"$Label`" (native ephemeral, one job per registration)"
  Push-Location $RunnerDir
  try {
    while ($true) {
      $jit = New-JitConfig
      Write-Log 'minted JIT config - running one job'
      # --jitconfig implies a single ephemeral job; the runner auto-deregisters after.
      & .\run.cmd --jitconfig $jit
      # Wipe the workspace between jobs (no per-job container teardown on native).
      $work = Join-Path $RunnerDir '_work'
      if (Test-Path $work) { Remove-Item $work -Recurse -Force -ErrorAction SilentlyContinue }
    }
  } finally {
    Pop-Location
  }
}

if ($Install) { Install-Runner }
elseif ($Serve) { Serve-Runner }
else { Write-Log 'nothing to do - pass -Install or -Serve (see runner/README.md)' }
