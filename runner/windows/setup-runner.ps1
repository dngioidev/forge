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
    3. $env:FORGE_RUNNER_PAT = '<token>'      # this session only, from your store
       .\setup-runner.ps1 -InstallService     # registers the durable NSSM service
       (foreground .\setup-runner.ps1 -Serve is now just the quick-test path.)
  -InstallService reads the PAT from the current session env and hands it to the
  service as AppEnvironmentExtra=FORGE_RUNNER_PAT - never written to a committed
  file, setx /M, or this repo. See runner/README.md for the full instructions.
#>
[CmdletBinding()]
param(
  [switch]$Install,
  [switch]$Serve,
  [switch]$InstallService,
  [switch]$UninstallService,
  [string]$Owner = 'dngioidev',
  [string]$Repo = 'forge',
  [string]$Label = 'forge-local',
  [string]$RunnerVersion = '2.336.0',
  # Pin the published SHA-256 for actions-runner-win-x64-<version>.zip before enabling (#227).
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
  # Prefer Git Bash's bash over WSL's System32 bash.exe. forge ships a bash-script
  # dispatcher (plugin/bin/forge) and its tests shell out to `bash`; if WSL bash wins
  # on PATH it can't run a C:\ path and those jobs fail (hosted windows-latest uses
  # Git Bash). Prepend Git's bin so this native runner matches hosted behaviour.
  $gitCmd = (Get-Command git -ErrorAction SilentlyContinue).Source
  if ($gitCmd) {
    $gitBin = Join-Path (Split-Path (Split-Path $gitCmd -Parent) -Parent) 'bin'
    if (Test-Path (Join-Path $gitBin 'bash.exe')) { $env:PATH = "$gitBin;$env:PATH" }
  }
  Write-Log "serving $Owner/$Repo on label `"$Label`" (native ephemeral, one job per registration)"
  Push-Location $RunnerDir
  try {
    while ($true) {
      # Clear config remnants from a previous interrupted job (a Ctrl-C mid-job
      # leaves .runner/.credentials*, and the next run.cmd --jitconfig then fails
      # with "Access to the path '...\.runner' is denied"). Start every job clean.
      foreach ($f in '.runner', '.credentials', '.credentials_rsaparams') {
        $p = Join-Path $RunnerDir $f
        if (Test-Path $p) { Remove-Item $p -Force -ErrorAction SilentlyContinue }
      }
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

$ServiceName = 'forge-runner'

function Assert-Admin {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = New-Object Security.Principal.WindowsPrincipal($identity)
  if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw 'Service install/uninstall requires an elevated session. Re-run PowerShell as Administrator.'
  }
}

function Get-Nssm {
  # NSSM (the Non-Sucking Service Manager) wraps a console app as a Windows service
  # (ADR-0005). Require it on PATH rather than downloading a third-party binary into
  # the repo tree: one less pinned SHA to keep current, nothing new to gitignore.
  # Give a concrete install hint when it is absent.
  $cmd = (Get-Command nssm -ErrorAction SilentlyContinue).Source
  if (-not $cmd) {
    throw 'nssm was not found on PATH. Install it (e.g. `winget install NSSM.NSSM` or `choco install nssm`), open a new elevated shell, then re-run. ADR-0005 registers the runner service via NSSM.'
  }
  return $cmd
}

function Install-Service {
  Assert-Admin
  # The one secret is read from THIS session's environment at install time and handed
  # to the service as its own environment (NSSM AppEnvironmentExtra). It is NEVER
  # written to a committed file, setx /M, or this repo. Error clearly when the session
  # does not carry it.
  if (-not $env:FORGE_RUNNER_PAT) {
    throw 'FORGE_RUNNER_PAT is not set in this session. Set it for THIS install session only (from your out-of-band store): $env:FORGE_RUNNER_PAT = ''<token>'' - never setx /M, never a committed file - then re-run -InstallService.'
  }
  $nssm = Get-Nssm
  $psExe = (Get-Command powershell -ErrorAction SilentlyContinue).Source
  if (-not $psExe) { $psExe = 'powershell' }
  $script = Join-Path $PSScriptRoot 'setup-runner.ps1'
  # NSSM writes progress to stderr; under $ErrorActionPreference='Stop' that native
  # stderr becomes a terminating error (PS 5.1 NativeCommandError). Run the nssm calls
  # non-terminating and verify the result explicitly. Only pre-clean when the service
  # already exists - nssm stop/remove on a missing service prints "Can't open service!".
  $prevEAP = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    if (Get-Service $ServiceName -ErrorAction SilentlyContinue) {
      Write-Log "existing '$ServiceName' found - removing before reinstall"
      & $nssm stop $ServiceName confirm 2>&1 | Out-Null
      & $nssm remove $ServiceName confirm 2>&1 | Out-Null
    }
    & $nssm install $ServiceName $psExe '-NoProfile' '-ExecutionPolicy' 'Bypass' '-File' $script '-Serve'
    & $nssm set $ServiceName AppDirectory $PSScriptRoot
    & $nssm set $ServiceName Start SERVICE_AUTO_START
    & $nssm set $ServiceName AppExit Default Restart
    & $nssm set $ServiceName AppRestartDelay 10000
    # AppEnvironmentExtra = the PAT from the current session env (never a literal, never a file).
    & $nssm set $ServiceName AppEnvironmentExtra "FORGE_RUNNER_PAT=$env:FORGE_RUNNER_PAT"
    & $nssm start $ServiceName
  } finally {
    $ErrorActionPreference = $prevEAP
  }
  Start-Sleep -Seconds 2
  $svc = Get-Service $ServiceName -ErrorAction SilentlyContinue
  if (-not $svc) { throw "service '$ServiceName' was not created - run 'nssm install $ServiceName ...' manually to see the error." }
  Write-Log "installed service '$ServiceName' (NSSM: auto-start, restart-on-exit); status: $($svc.Status)"
  Write-Log "status:  nssm status $ServiceName   |   stop/edit: nssm stop|edit $ServiceName"
}

function Uninstall-Service {
  Assert-Admin
  $nssm = Get-Nssm
  if (-not (Get-Service $ServiceName -ErrorAction SilentlyContinue)) {
    Write-Log "service '$ServiceName' not installed - nothing to remove."
    return
  }
  $prevEAP = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    & $nssm stop $ServiceName confirm 2>&1 | Out-Null
    & $nssm remove $ServiceName confirm 2>&1 | Out-Null
  } finally {
    $ErrorActionPreference = $prevEAP
  }
  Write-Log "removed service '$ServiceName'"
}

if ($Install) { Install-Runner }
elseif ($Serve) { Serve-Runner }
elseif ($InstallService) { Install-Service }
elseif ($UninstallService) { Uninstall-Service }
else { Write-Log 'nothing to do - pass -Install, -Serve, -InstallService, or -UninstallService (see runner/README.md)' }
