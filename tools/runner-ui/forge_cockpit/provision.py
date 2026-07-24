"""Install / uninstall a runner service FROM the cockpit (ticket #267) — secret-safe.

This module reimplements **nothing**: it stands a runner service up (or tears it
down) by shelling out to the setup scripts that are already the API —

* **Windows**: ``runner/windows/setup-runner.ps1 -InstallService`` /
  ``-UninstallService`` (the NSSM service the runner already runs under), with the
  chosen ``-Owner``/``-Repo`` (#260 repo-scoped target).
* **Linux**: ``runner/linux/install-service.sh`` / ``--uninstall`` (the systemd
  ``--user`` unit), reached over ``wsl.exe --`` interop, with ``--owner``/``--repo``.

The service NAME is the #260 repo-scoped ``forge-runner-<owner>-<repo>`` — the same
slug the scripts derive — so a second repo installs a DISTINCT service instead of
clobbering the first (:func:`service_name`).

Privilege handling (ADR-0006 Decision 4): a Windows NSSM service install/uninstall
mutates a LocalSystem service and requires administrator rights; when the cockpit
is **not** already elevated the action is routed through the SAME explicit
per-action UAC elevation seam as the #266 control actions
(:func:`forge_cockpit.control.elevate_run`), never a silent no-op. systemd
``--user`` needs no elevation.

SECRET SAFETY (AC3, ADR-0005 + ADR-0006 — non-negotiable): the runner PAT is
handled **entirely out of band**. This module NEVER accepts a token argument,
NEVER puts a token on argv, NEVER reads or writes ``~/.forge/runner.env`` or the
service environment, and NEVER logs one. The scripts themselves read the PAT from
their own out-of-band store (the service environment / the gitignored, chmod-600
``runner.env``); the cockpit only points the operator at that store
(:data:`PAT_GUIDANCE`). ``shellout.run`` additionally refuses any argv that
references ``runner.env`` as a hard backstop.

Clobber / mis-target guard (AC4): before an install the caller cross-checks the
already-discovered #264 fleet — if a service with the derived name already exists
for a DIFFERENT target (a name clash) or a running service for this repo is
mis-targeted, the guard fires and the install refuses unless ``force`` is set,
consistent with the ``-Force`` / ``--force`` guards the CLI scripts enforce.
"""

from __future__ import annotations

import os
import subprocess
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path, PureWindowsPath

from forge_cockpit import shellout
from forge_cockpit.control import Elevator, elevate_run, is_elevated
from forge_cockpit.discovery import RunnerEntry
from forge_cockpit.shellout import CommandResult

# The two provisioning verbs.
INSTALL = "install"
UNINSTALL = "uninstall"
ACTIONS: tuple[str, ...] = (INSTALL, UNINSTALL)

# Target platforms — which setup script to drive.
WINDOWS = "windows"
LINUX = "linux"
PLATFORMS: tuple[str, ...] = (WINDOWS, LINUX)

#: Repo-scoped service/unit name prefix (ADR-0005 / #260) — matches the scripts.
_SERVICE_PREFIX = "forge-runner"

# Errors that mean "the manager/shell is simply absent / could not spawn" — turned
# into a clear failure result rather than propagated as a crash.
_TOLERATED = (OSError, subprocess.SubprocessError)

#: Repo root (…/runner/windows/…): this file is forge_cockpit/provision.py, so
#: parents[3] is the repo root — the same anchor logs.py uses.
_REPO_ROOT = Path(__file__).resolve().parents[3]
WINDOWS_SCRIPT = _REPO_ROOT / "runner" / "windows" / "setup-runner.ps1"
LINUX_SCRIPT = _REPO_ROOT / "runner" / "linux" / "install-service.sh"

#: Operator guidance for the PAT — the ONE secret, kept out of band (AC3). The UI
#: shows this instead of ever offering a token field. Never contains a token.
PAT_GUIDANCE = (
    "The runner PAT is handled out of band and is never entered here. Before "
    "installing, provide it to the service's own store per the runner docs:\n"
    "  • Windows: set it for the elevated install session only, from your store —\n"
    "      $env:FORGE_RUNNER_PAT = '<token>'   (never setx /M, never a committed file)\n"
    "  • Linux: write the gitignored, chmod-600 store the unit loads it from —\n"
    "      printf 'FORGE_RUNNER_PAT=<token>\\n' > ~/.forge/runner.env && chmod 600 ~/.forge/runner.env\n"
    "The cockpit never displays, logs, stores, or commits the token."
)

# Injectable seams (defaulted to the real helpers; overridden with fakes in tests).
Runner = Callable[..., CommandResult]
AdminProbe = Callable[[], bool]


# --------------------------------------------------------------------------- #
# Result + guard types.
# --------------------------------------------------------------------------- #
@dataclass(frozen=True)
class ProvisionResult:
    """The outcome of an install/uninstall, ready to surface to the operator."""

    action: str  # INSTALL | UNINSTALL
    platform: str  # WINDOWS | LINUX
    name: str  # the repo-scoped service/unit name
    owner: str
    repo: str
    ok: bool
    #: True when the action was routed through a UAC elevation (Windows, non-admin).
    elevated: bool
    #: A human-readable success/failure line for the status bar / dialog.
    message: str


@dataclass(frozen=True)
class GuardVerdict:
    """Whether an install would clobber / mis-target an existing service (AC4)."""

    #: A service with the derived name already exists (a reinstall / clash risk).
    clashes: bool
    #: The clashing/mis-targeted fleet entry, when one was found.
    existing: RunnerEntry | None
    #: A human-readable warning; empty when the install is clean.
    message: str

    @property
    def clean(self) -> bool:
        return not self.clashes


# --------------------------------------------------------------------------- #
# Name derivation — the #260 repo-scoped slug the scripts also derive.
# --------------------------------------------------------------------------- #
def _slug(value: str) -> str:
    """Lowercase; every run of non-alphanumerics -> a single '-'; trim edge '-'."""
    out: list[str] = []
    prev_dash = False
    for ch in value.lower():
        if ch.isalnum():
            out.append(ch)
            prev_dash = False
        elif not prev_dash:
            out.append("-")
            prev_dash = True
    return "".join(out).strip("-")


def service_name(owner: str, repo: str) -> str:
    """``forge-runner-<owner>-<repo>`` (#260) — the repo-scoped service/unit name."""
    name = _SERVICE_PREFIX
    o, r = _slug(owner), _slug(repo)
    if o:
        name = f"{name}-{o}"
    if r:
        name = f"{name}-{r}"
    return name


def default_platform() -> str:
    """The setup script that matches this host (Windows -> NSSM, else Linux)."""
    return WINDOWS if os.name == "nt" else LINUX


# --------------------------------------------------------------------------- #
# Per-platform argv (the scripts are the API — we never reimplement them).
# --------------------------------------------------------------------------- #
def windows_install_argv(owner: str, repo: str, *, script: str, force: bool = False) -> list[str]:
    """``setup-runner.ps1 -InstallService -Owner <o> -Repo <r>`` (AC1)."""
    argv = [
        "powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script,
        "-InstallService", "-Owner", owner, "-Repo", repo,
    ]
    if force:
        argv.append("-Force")
    return argv


def windows_uninstall_argv(owner: str, repo: str, *, script: str) -> list[str]:
    """``setup-runner.ps1 -UninstallService -Owner <o> -Repo <r>`` (AC2)."""
    return [
        "powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script,
        "-UninstallService", "-Owner", owner, "-Repo", repo,
    ]


def linux_install_argv(owner: str, repo: str, *, script: str, force: bool = False) -> list[str]:
    """``install-service.sh --owner <o> --repo <r>`` (AC1)."""
    argv = ["bash", script, "--owner", owner, "--repo", repo]
    if force:
        argv.append("--force")
    return argv


def linux_uninstall_argv(owner: str, repo: str, *, script: str) -> list[str]:
    """``install-service.sh --uninstall --owner <o> --repo <r>`` (AC2)."""
    return ["bash", script, "--uninstall", "--owner", owner, "--repo", repo]


def _to_wsl_path(path: Path) -> str:
    """``C:\\mywp\\forge\\...`` -> ``/mnt/c/mywp/forge/...`` for a bash-over-WSL call."""
    win = PureWindowsPath(str(path))
    drive = win.drive  # e.g. "C:"
    if len(drive) >= 2 and drive[1] == ":":
        tail = "/".join(win.parts[1:])
        return f"/mnt/{drive[0].lower()}/{tail}"
    return str(path).replace("\\", "/")


# --------------------------------------------------------------------------- #
# Clobber / mis-target guard (AC4).
# --------------------------------------------------------------------------- #
def _is_mistargeted(entry: RunnerEntry) -> bool:
    """A *running* service whose known repo has a *known* online count of 0 (#260).

    Mirrors :func:`forge_cockpit.fleet_view.is_mistargeted`; inlined here to keep
    :mod:`provision` free of a GUI-module import (avoids an import cycle).
    """
    return (
        entry.service_state == "running"
        and entry.target.known
        and entry.online.known
        and entry.online_count == 0
    )


def check_guards(owner: str, repo: str, entries: tuple[RunnerEntry, ...]) -> GuardVerdict:
    """Would installing ``owner/repo`` clobber or mis-target an existing service?

    Cross-references the already-discovered #264 fleet by the derived repo-scoped
    NAME. A same-name entry means an install would reinstall/clobber it; if that
    entry is *running* and its repo shows 0 online runners it is the #260
    mis-target the fleet view flags. Returns a :class:`GuardVerdict` the caller
    surfaces (and refuses on, unless ``force``), consistent with the CLI guards.
    """
    name = service_name(owner, repo).lower()
    for entry in entries:
        if entry.name.lower() != name:
            continue
        mistargeted = _is_mistargeted(entry)
        message = (
            f"A service '{entry.name}' for {owner}/{repo} already exists "
            f"(state: {entry.service_state})."
        )
        if mistargeted:
            message += (
                f" It is running but its repo reports 0 online runners — likely "
                f"mis-targeted (#260)."
            )
        message += " Re-installing will replace it; enable Force to proceed."
        return GuardVerdict(clashes=True, existing=entry, message=message)
    return GuardVerdict(clashes=False, existing=None, message="")


# --------------------------------------------------------------------------- #
# Orchestration.
# --------------------------------------------------------------------------- #
def provision(
    action: str,
    owner: str,
    repo: str,
    *,
    platform: str | None = None,
    force: bool = False,
    entries: tuple[RunnerEntry, ...] = (),
    runner: Runner = shellout.run,
    wsl_runner: Runner = shellout.wsl,
    is_admin: AdminProbe = is_elevated,
    elevate: Elevator = elevate_run,
    windows_script: Path = WINDOWS_SCRIPT,
    linux_script: Path = LINUX_SCRIPT,
) -> ProvisionResult:
    """Install / uninstall the ``owner/repo`` runner service by driving the scripts.

    Routes by ``platform`` (defaulting to this host): Windows drives
    ``setup-runner.ps1`` (elevated via UAC when not already admin), Linux drives
    ``install-service.sh`` over WSL (no elevation). Never handles the PAT (AC3).
    An install refuses when :func:`check_guards` flags a clobber/mis-target and
    ``force`` is not set (AC4).
    """
    if action not in ACTIONS:
        raise ValueError(f"unknown action {action!r}; expected one of {ACTIONS}")
    if not owner or not repo:
        raise ValueError("owner and repo are both required")
    plat = platform or default_platform()
    if plat not in PLATFORMS:
        raise ValueError(f"unknown platform {plat!r}; expected one of {PLATFORMS}")

    name = service_name(owner, repo)

    # AC4: refuse a clobber/mis-target install unless forced — same bar as the CLI.
    if action == INSTALL and not force:
        verdict = check_guards(owner, repo, entries)
        if verdict.clashes:
            return ProvisionResult(
                action, plat, name, owner, repo, ok=False, elevated=False,
                message=verdict.message + " (refused — no changes made)",
            )

    if plat == WINDOWS:
        return _provision_windows(
            action, owner, repo, name, force, runner, is_admin, elevate, windows_script
        )
    return _provision_linux(action, owner, repo, name, force, wsl_runner, linux_script)


def _provision_windows(
    action: str,
    owner: str,
    repo: str,
    name: str,
    force: bool,
    runner: Runner,
    is_admin: AdminProbe,
    elevate: Elevator,
    script: Path,
) -> ProvisionResult:
    script_str = str(script)
    if action == INSTALL:
        argv = windows_install_argv(owner, repo, script=script_str, force=force)
    else:
        argv = windows_uninstall_argv(owner, repo, script=script_str)

    admin = is_admin()
    try:
        res = runner(argv) if admin else elevate(argv)
    except _TOLERATED as exc:
        return ProvisionResult(
            action, WINDOWS, name, owner, repo, ok=False, elevated=not admin,
            message=f"Could not {action} '{name}': {exc}",
        )

    if res.ok:
        note = " (elevated via UAC)" if not admin else ""
        tail = _install_tail(action)
        return ProvisionResult(
            action, WINDOWS, name, owner, repo, ok=True, elevated=not admin,
            message=f"{action.capitalize()} succeeded for service '{name}'{note}.{tail}",
        )

    # Failed. A non-admin failure is almost certainly a declined/failed elevation:
    # make the "run elevated" requirement EXPLICIT rather than a silent no-op.
    if not admin:
        message = (
            f"{action.capitalize()} of '{name}' needs Windows administrator rights "
            f"and the elevation was declined or failed (exit {res.returncode}). "
            "Re-run and accept the UAC prompt, or launch the cockpit as administrator."
        )
    else:
        detail = (res.stderr or res.stdout or "").strip() or f"script exited {res.returncode}"
        message = f"{action.capitalize()} failed for '{name}': {detail}"
    return ProvisionResult(action, WINDOWS, name, owner, repo, ok=False, elevated=not admin, message=message)


def _provision_linux(
    action: str,
    owner: str,
    repo: str,
    name: str,
    force: bool,
    wsl_runner: Runner,
    script: Path,
) -> ProvisionResult:
    script_wsl = _to_wsl_path(script)
    if action == INSTALL:
        argv = linux_install_argv(owner, repo, script=script_wsl, force=force)
    else:
        argv = linux_uninstall_argv(owner, repo, script=script_wsl)

    try:
        res = wsl_runner(argv)
    except _TOLERATED as exc:
        return ProvisionResult(
            action, LINUX, name, owner, repo, ok=False, elevated=False,
            message=f"Could not {action} '{name}' over WSL: {exc}",
        )

    if res.ok:
        tail = _install_tail(action)
        return ProvisionResult(
            action, LINUX, name, owner, repo, ok=True, elevated=False,
            message=f"{action.capitalize()} succeeded for systemd --user unit '{name}'.{tail}",
        )
    detail = (res.stderr or res.stdout or "").strip() or f"install-service.sh exited {res.returncode}"
    return ProvisionResult(
        action, LINUX, name, owner, repo, ok=False, elevated=False,
        message=f"{action.capitalize()} failed for '{name}': {detail}",
    )


def _install_tail(action: str) -> str:
    """A reminder pointing at the out-of-band PAT store after an install (AC3)."""
    if action == INSTALL:
        return " The service loads the PAT from its own out-of-band store (see the PAT guidance)."
    return ""
