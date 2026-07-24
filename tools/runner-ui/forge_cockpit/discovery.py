"""Fleet discovery + status core (ticket #264) — the data layer the UI renders.

This module *enumerates* the local self-hosted runner fleet, *resolves* each
entry's target ``owner/repo``, *cross-references* GitHub's online-runner list, and
returns a **normalized, typed fleet model**. It reimplements nothing: it drives
the managers that are already the API — ``sc query`` (Windows NSSM), ``systemctl
--user`` (Linux systemd, reached over ``wsl.exe --`` interop), ``docker ps``, and
``gh api`` — all through the argv-list shell-out helper in :mod:`forge_cockpit.shellout`.

Security invariants (non-negotiable — ADR-0005 + ADR-0006):

* The **target** ``owner/repo`` is derived from the service *NAME*
  (``forge-runner-<owner>-<repo>``, per #260 repo-scoped naming), **never** from
  the service ENVIRONMENT — the environment carries the runner PAT, and reading it
  would leak the one secret this UI must never touch. The legacy bare
  ``forge-runner`` (no suffix) resolves to an "unknown/legacy" target.
* Every command run here reads service *state* only (``sc query``, ``systemctl
  list-units``, ``docker ps``, ``gh api .../actions/runners``). Nothing reads
  ``~/.forge/runner.env`` or ``sc qc`` / ``systemctl show ...Environment`` /
  ``docker inspect``, and nothing logs a token. :mod:`shellout` refuses any argv
  that references ``runner.env`` as a hard backstop.
* Every mechanism is **tolerant** when absent: a missing ``docker``, no WSL, or no
  matching services yields an empty slice, never a crash; a ``gh`` error marks the
  online count *unknown* rather than raising.
"""

from __future__ import annotations

import json
import subprocess
from collections.abc import Callable, Iterable
from dataclasses import dataclass, replace

from forge_cockpit import shellout
from forge_cockpit.shellout import CommandResult, RunnerEnvAccessError

# Errors that mean "this mechanism is simply absent on this box" — swallowed into
# an empty result rather than propagated, so one missing manager never crashes a
# fleet scan.
_TOLERATED = (OSError, subprocess.SubprocessError, RunnerEnvAccessError)

#: Repo-scoped service/unit name prefix (ADR-0005 / #260).
_SERVICE_PREFIX = "forge-runner"

# Mechanism tags for the normalized model.
NSSM = "nssm"
SYSTEMD = "systemd"
DOCKER = "docker"

# Type aliases for the injectable shell-out seams (defaulted to the real helper;
# overridden with fakes in tests so the suite stays hermetic).
Runner = Callable[..., CommandResult]
Probe = Callable[[], bool]


@dataclass(frozen=True)
class Target:
    """The ``owner/repo`` a runner serves, resolved from its NAME (never its env)."""

    owner: str | None
    repo: str | None

    @property
    def known(self) -> bool:
        """True when both owner and repo were parsed from the service name."""
        return self.owner is not None and self.repo is not None

    @property
    def slug(self) -> str:
        """``owner/repo`` for a resolved target, else the ``unknown/legacy`` sentinel."""
        return f"{self.owner}/{self.repo}" if self.known else "unknown/legacy"


#: The sentinel target for the legacy bare ``forge-runner`` service and for any
#: runner (e.g. an ephemeral docker job container) whose name carries no owner/repo.
UNKNOWN_TARGET = Target(owner=None, repo=None)


@dataclass(frozen=True)
class OnlineStatus:
    """GitHub's online/offline runner count for a repo — or *unknown* on gh error."""

    online: int | None
    offline: int | None
    total: int | None
    known: bool

    @classmethod
    def unknown(cls) -> OnlineStatus:
        """The result when gh could not tell us (no network / not authed / 404)."""
        return cls(online=None, offline=None, total=None, known=False)


@dataclass(frozen=True)
class RunnerEntry:
    """One normalized fleet entry — the typed row the UI renders (AC4)."""

    name: str
    mechanism: str  # NSSM | SYSTEMD | DOCKER
    service_state: str  # normalized lowercase: running | stopped | exited | dead | ...
    target: Target
    online: OnlineStatus

    @property
    def repo(self) -> str:
        """The ``owner/repo`` slug (or ``unknown/legacy``)."""
        return self.target.slug

    @property
    def online_count(self) -> int | None:
        """Online runner count for this entry's repo, or ``None`` when unknown."""
        return self.online.online


@dataclass(frozen=True)
class Fleet:
    """The whole normalized fleet — the discovery module's public product."""

    runners: tuple[RunnerEntry, ...]


# --------------------------------------------------------------------------- #
# Target resolution — from the NAME only (AC2 CRITICAL SAFETY).
# --------------------------------------------------------------------------- #
def parse_target(name: str) -> Target:
    """Resolve ``owner/repo`` from a service/unit/container NAME — never its env.

    ``forge-runner-<owner>-<repo>`` -> ``Target(owner, repo)``. The bare legacy
    ``forge-runner`` (optionally ``.service``), and any name that does not match
    the repo-scoped shape, resolve to :data:`UNKNOWN_TARGET`.

    Owner is the first ``-``-delimited token after the prefix; the remainder is the
    repo (so hyphenated repos like ``my-repo`` parse correctly). Hyphenated *owners*
    are ambiguous under this scheme and are not attempted — a deliberate limitation
    of the repo-scoped naming convention, not a bug here.
    """
    stem = name.strip()
    if stem.endswith(".service"):
        stem = stem[: -len(".service")]

    if stem == _SERVICE_PREFIX:  # legacy bare name
        return UNKNOWN_TARGET

    prefix = _SERVICE_PREFIX + "-"
    if not stem.startswith(prefix):
        return UNKNOWN_TARGET

    owner, sep, repo = stem[len(prefix):].partition("-")
    if not sep or not owner or not repo:
        return UNKNOWN_TARGET
    return Target(owner=owner, repo=repo)


# --------------------------------------------------------------------------- #
# Windows NSSM services via `sc query` (state only).
# --------------------------------------------------------------------------- #
def discover_windows_services(*, runner: Runner = shellout.run) -> list[RunnerEntry]:
    """Enumerate Windows NSSM ``forge-runner*`` services via ``sc query`` (AC1).

    Reads STATE only. Absent ``sc`` / no matching services -> ``[]`` (never raises).
    """
    try:
        result = runner(["sc", "query", "type=", "service", "state=", "all"])
    except _TOLERATED:
        return []
    if not result.ok:
        return []
    return _parse_sc_query(result.stdout)


def _parse_sc_query(text: str) -> list[RunnerEntry]:
    entries: list[RunnerEntry] = []
    current: str | None = None
    for raw in text.splitlines():
        line = raw.strip()
        upper = line.upper()
        if upper.startswith("SERVICE_NAME:"):
            current = line.split(":", 1)[1].strip()
        elif upper.startswith("STATE") and current is not None:
            if current.lower().startswith(_SERVICE_PREFIX):
                entries.append(
                    RunnerEntry(
                        name=current,
                        mechanism=NSSM,
                        service_state=_sc_state_word(line),
                        target=parse_target(current),
                        online=OnlineStatus.unknown(),
                    )
                )
            current = None
    return entries


def _sc_state_word(line: str) -> str:
    """``STATE : 4  RUNNING`` -> ``running`` (last token after the colon)."""
    _, _, rhs = line.partition(":")
    tokens = rhs.split()
    return tokens[-1].lower() if tokens else "unknown"


# --------------------------------------------------------------------------- #
# Linux systemd --user units via `wsl.exe -- systemctl --user list-units`.
# --------------------------------------------------------------------------- #
def discover_systemd_units(
    *,
    wsl_runner: Runner = shellout.wsl,
    wsl_available: Probe = shellout.wsl_available,
) -> list[RunnerEntry]:
    """Enumerate Linux systemd ``--user forge-runner*`` units over WSL interop (AC1).

    No WSL, absent ``systemctl``, or no matching units -> ``[]`` (never raises).
    """
    if not wsl_available():
        return []
    try:
        result = wsl_runner(
            [
                "systemctl",
                "--user",
                "list-units",
                f"{_SERVICE_PREFIX}*",
                "--type=service",
                "--all",
                "--no-legend",
                "--no-pager",
            ]
        )
    except _TOLERATED:
        return []
    if not result.ok:
        return []
    return _parse_systemd_units(result.stdout)


def _parse_systemd_units(text: str) -> list[RunnerEntry]:
    entries: list[RunnerEntry] = []
    for raw in text.splitlines():
        # `list-units` may prefix a failed unit with a bullet (● / *); drop it.
        line = raw.strip().lstrip("*● ").strip()
        if not line:
            continue
        fields = line.split(maxsplit=4)
        if len(fields) < 4:
            continue
        unit, _load, _active, sub = fields[0], fields[1], fields[2], fields[3]
        if not unit.lower().startswith(_SERVICE_PREFIX):
            continue
        entries.append(
            RunnerEntry(
                name=unit,
                mechanism=SYSTEMD,
                service_state=sub.lower(),
                target=parse_target(unit),
                online=OnlineStatus.unknown(),
            )
        )
    return entries


# --------------------------------------------------------------------------- #
# Docker container runners via `docker ps` (over WSL when present).
# --------------------------------------------------------------------------- #
def discover_docker_runners(
    *,
    runner: Runner = shellout.run,
    wsl_runner: Runner = shellout.wsl,
    wsl_available: Probe = shellout.wsl_available,
) -> list[RunnerEntry]:
    """Enumerate Docker runner job containers via ``docker ps`` (AC1).

    On this box Docker lives inside WSL, so the call is routed over ``wsl.exe --``
    when WSL is present, else attempted natively. Absent ``docker`` / no containers
    -> ``[]`` (never raises).
    """
    argv = ["docker", "ps", "--all", "--no-trunc", "--format", "{{json .}}"]
    try:
        result = wsl_runner(argv) if wsl_available() else runner(argv)
    except _TOLERATED:
        return []
    if not result.ok:
        return []
    return _parse_docker_ps(result.stdout)


def _parse_docker_ps(text: str) -> list[RunnerEntry]:
    entries: list[RunnerEntry] = []
    for raw in text.splitlines():
        line = raw.strip()
        if not line:
            continue
        try:
            obj = json.loads(line)
        except (json.JSONDecodeError, ValueError):
            continue  # tolerate a malformed line rather than crash the scan
        name = str(obj.get("Names", ""))
        image = str(obj.get("Image", "")).lower()
        if "runner-run" not in name and not image.startswith("forge-local-runner"):
            continue
        state = str(obj.get("State", "") or _docker_state_from_status(obj.get("Status", "")))
        entries.append(
            RunnerEntry(
                name=name,
                mechanism=DOCKER,
                service_state=state.lower() or "unknown",
                target=parse_target(name),  # ephemeral job names carry no owner/repo
                online=OnlineStatus.unknown(),
            )
        )
    return entries


def _docker_state_from_status(status: object) -> str:
    text = str(status).lower()
    if text.startswith("up"):
        return "running"
    if text.startswith("exited"):
        return "exited"
    return "unknown"


# --------------------------------------------------------------------------- #
# GitHub online-runner cross-reference via `gh api` (AC3).
# --------------------------------------------------------------------------- #
def cross_reference_online(
    targets: Iterable[Target], *, gh_runner: Runner = shellout.run
) -> dict[str, OnlineStatus]:
    """Map each distinct known target ``slug`` -> its online/offline count via gh.

    gh errors (no network / not authed / repo not found / bad JSON) yield
    :meth:`OnlineStatus.unknown` for that repo, never an exception (AC3).
    """
    counts: dict[str, OnlineStatus] = {}
    for target in targets:
        if not target.known or target.slug in counts:
            continue
        counts[target.slug] = _query_repo_runners(target, gh_runner)
    return counts


def _query_repo_runners(target: Target, gh_runner: Runner) -> OnlineStatus:
    try:
        result = gh_runner(
            ["gh", "api", f"repos/{target.owner}/{target.repo}/actions/runners?per_page=100"]
        )
    except _TOLERATED:
        return OnlineStatus.unknown()
    if not result.ok:
        return OnlineStatus.unknown()
    try:
        data = json.loads(result.stdout)
    except (json.JSONDecodeError, ValueError):
        return OnlineStatus.unknown()

    runners = data.get("runners") if isinstance(data, dict) else None
    if not isinstance(runners, list):
        return OnlineStatus.unknown()
    online = sum(1 for r in runners if isinstance(r, dict) and r.get("status") == "online")
    offline = sum(1 for r in runners if isinstance(r, dict) and r.get("status") == "offline")
    return OnlineStatus(online=online, offline=offline, total=len(runners), known=True)


# --------------------------------------------------------------------------- #
# Orchestration — enumerate + resolve + cross-ref -> normalized Fleet (AC4).
# --------------------------------------------------------------------------- #
def discover_fleet(
    *,
    runner: Runner = shellout.run,
    wsl_runner: Runner = shellout.wsl,
    wsl_available: Probe = shellout.wsl_available,
    gh_runner: Runner = shellout.run,
) -> Fleet:
    """Discover the whole fleet and return the normalized :class:`Fleet` model.

    Enumerates all three mechanisms (each tolerant of absence), resolves every
    entry's target from its NAME, cross-references GitHub once per distinct known
    repo, and attaches the online count to each matching entry. Docker/legacy
    entries (unknown target) keep :meth:`OnlineStatus.unknown`.
    """
    entries: list[RunnerEntry] = []
    entries += discover_windows_services(runner=runner)
    entries += discover_systemd_units(wsl_runner=wsl_runner, wsl_available=wsl_available)
    entries += discover_docker_runners(
        runner=runner, wsl_runner=wsl_runner, wsl_available=wsl_available
    )

    distinct = {e.target.slug: e.target for e in entries if e.target.known}
    counts = cross_reference_online(distinct.values(), gh_runner=gh_runner)

    resolved = tuple(
        replace(entry, online=counts.get(entry.target.slug, OnlineStatus.unknown()))
        for entry in entries
    )
    return Fleet(runners=resolved)
