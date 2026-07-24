#!/usr/bin/env python3
"""THROWAWAY SPIKE PROOF for ticket #263 (AC2). NOT production code.

Proves the recommended Runner-UI stack can list at least one REAL forge-runner
service's state cross-platform by shelling out to the existing managers -- it
does NOT reimplement any service manager, and it NEVER reads ~/.forge/runner.env
or surfaces the FORGE_RUNNER_PAT (it queries service *state* only).

What it shells out to (discover, never reimplement):
  - Windows  : `sc.exe query`  (or PowerShell `Get-Service`) for `forge-runner*`
  - Linux    : `systemctl --user list-units` for `forge-runner*`
  - Docker   : `docker ps`     for the ephemeral `*-runner-run-*` job containers

Cross-boundary reach (the key cross-platform finding): one Python process can
drive BOTH OSes on a single Windows+WSL2 box via two-way interop --
  - from WSL2  -> Windows services through `sc.exe` / `powershell.exe` on PATH
  - from Windows -> Linux services through `wsl.exe -- systemctl --user ...`

Run:  python3 probe.py        (dispose of tools/runner-ui/spike/ after the spike)
"""
from __future__ import annotations

import platform
import shutil
import subprocess
import sys

TIMEOUT = 20


def run(argv: list[str]) -> tuple[int, str]:
    """Shell out with an argv list (never shell=True, never a secret on argv).

    Returns (exit_code, combined_text). Missing binary -> (127, "").
    """
    try:
        p = subprocess.run(
            argv,
            capture_output=True,
            text=True,
            timeout=TIMEOUT,
            check=False,
        )
    except FileNotFoundError:
        return 127, ""
    except subprocess.TimeoutExpired:
        return 124, "(timed out)"
    return p.returncode, (p.stdout or "") + (p.stderr or "")


def have(name: str) -> bool:
    return shutil.which(name) is not None


def section(title: str) -> None:
    print(f"\n== {title} ==")


def list_windows_services() -> None:
    """List forge-runner* Windows services (NSSM-registered) via sc.exe."""
    section("Windows services (forge-runner*) via sc.exe")
    if not have("sc") and not have("sc.exe"):
        print("  sc.exe not on PATH (not on Windows / no interop) -- skipped")
        return
    # `sc query state= all` lists all; filter to forge-runner* by name locally.
    code, out = run(["sc.exe", "query", "type=", "service", "state=", "all"])
    if code != 0 and not out:
        print(f"  sc.exe query failed (exit {code}) -- skipped")
        return
    name = None
    found = 0
    for line in out.splitlines():
        s = line.strip()
        if s.startswith("SERVICE_NAME:"):
            name = s.split(":", 1)[1].strip()
        elif s.startswith("STATE") and name and name.lower().startswith("forge-runner"):
            # e.g. "STATE : 4  RUNNING"
            state = s.split(":", 1)[1].strip()
            print(f"  {name:38s} {state}")
            found += 1
    if not found:
        print("  no forge-runner* Windows service registered")


def list_linux_user_services() -> None:
    """List forge-runner* systemd --user units (Linux/WSL)."""
    section("Linux systemd --user units (forge-runner*)")
    if not have("systemctl"):
        print("  systemctl not on PATH (not Linux) -- skipped")
        return
    code, out = run(
        ["systemctl", "--user", "list-units", "--type=service", "--all", "--no-legend"]
    )
    if code != 0 and not out.strip():
        print(f"  systemctl --user failed (exit {code}) -- skipped")
        return
    found = 0
    for line in out.splitlines():
        # systemctl may prefix a status-dot glyph on some units; drop any
        # leading non-ASCII marker so the unit name lands in cols[0].
        cols = "".join(c if ord(c) < 128 else " " for c in line).split()
        if cols and cols[0].startswith("forge-runner"):
            unit = cols[0]
            active = cols[2] if len(cols) > 2 else "?"
            sub = cols[3] if len(cols) > 3 else "?"
            print(f"  {unit:42s} {active}/{sub}")
            found += 1
    if not found:
        print("  no forge-runner* --user unit loaded")


def list_docker_job_containers() -> None:
    """List the ephemeral runner job containers via docker ps."""
    section("Docker ephemeral job containers (*runner-run*)")
    if not have("docker"):
        print("  docker not on PATH -- skipped")
        return
    code, out = run(["docker", "ps", "--format", "{{.Names}}\t{{.Status}}"])
    if code != 0:
        print(f"  docker ps failed (exit {code}) -- skipped")
        return
    found = 0
    for line in out.splitlines():
        if "runner-run" in line or "runner" in line:
            print(f"  {line}")
            found += 1
    if not found:
        print("  no runner job container currently up")


def main() -> int:
    print("forge runner-ui spike probe (#263 AC2) -- read-only service state, no PAT")
    print(f"host: {platform.system()} {platform.release()}  python {platform.python_version()}")
    list_windows_services()
    list_linux_user_services()
    list_docker_job_containers()
    print("\n(done -- throwaway proof; never reads runner.env, never prints the PAT)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
