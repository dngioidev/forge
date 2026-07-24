"""Tests for install/uninstall provisioning (ticket #267, AC1-AC4).

Hermetic: every shell-out / elevation seam is a fake, so no script, WSL, or UAC
prompt runs. Locks:

* AC1 — install drives the EXISTING scripts with the chosen owner/repo and the
  #260 repo-scoped service name (``setup-runner.ps1 -InstallService`` /
  ``install-service.sh --owner/--repo``), never reimplementing them.
* AC2 — uninstall drives the ``-UninstallService`` / ``--uninstall`` counterpart.
* AC3 — the flow NEVER passes/echoes/logs a PAT: no token argument exists, no argv
  token carries a PAT or ``runner.env``, and the guidance points at the out-of-band
  store.
* AC4 — a clobber (a service for that repo already exists) refuses the install
  unless forced, consistent with the CLI ``-Force`` / ``--force`` guard.
"""

from __future__ import annotations

import inspect

import pytest

from forge_cockpit import provision
from forge_cockpit.discovery import (
    NSSM,
    OnlineStatus,
    RunnerEntry,
    Target,
)
from forge_cockpit.provision import (
    check_guards,
    provision as run_provision,
    service_name,
)
from forge_cockpit.shellout import CommandResult

WIN_SCRIPT = "C:\\repo\\runner\\windows\\setup-runner.ps1"
LNX_SCRIPT = "/mnt/c/repo/runner/linux/install-service.sh"


def _result(argv, rc=0, out="", err="") -> CommandResult:
    return CommandResult(argv=tuple(argv), returncode=rc, stdout=out, stderr=err)


class _Recorder:
    """A fake runner/elevator that records argv and returns a canned result."""

    def __init__(self, rc: int = 0, out: str = "", err: str = "") -> None:
        self.calls: list[list[str]] = []
        self._rc, self._out, self._err = rc, out, err

    def __call__(self, argv, **_kw) -> CommandResult:
        self.calls.append(list(argv))
        return _result(argv, self._rc, self._out, self._err)


def _entry(name: str, owner: str, repo: str, state: str = "running", online=None) -> RunnerEntry:
    return RunnerEntry(
        name=name,
        mechanism=NSSM,
        service_state=state,
        target=Target(owner, repo),
        online=online or OnlineStatus.unknown(),
    )


# --------------------------------------------------------------------------- #
# #260 repo-scoped naming.
# --------------------------------------------------------------------------- #
def test_service_name_is_repo_scoped():
    assert service_name("acme", "widgets") == "forge-runner-acme-widgets"
    # Sanitised: uppercase + punctuation collapse to a single dash, edges trimmed.
    assert service_name("Acme.Co", "My_Repo") == "forge-runner-acme-co-my-repo"


# --------------------------------------------------------------------------- #
# AC1 — install drives the EXISTING scripts with the chosen repo (never reimplemented).
# --------------------------------------------------------------------------- #
def test_windows_install_argv_drives_setup_script():
    argv = provision.windows_install_argv("acme", "widgets", script=WIN_SCRIPT)
    assert argv[0] == "powershell"
    assert "-File" in argv and WIN_SCRIPT in argv
    assert "-InstallService" in argv
    assert argv[argv.index("-Owner") + 1] == "acme"
    assert argv[argv.index("-Repo") + 1] == "widgets"
    assert "-Force" not in argv


def test_windows_install_argv_force_adds_flag():
    argv = provision.windows_install_argv("acme", "widgets", script=WIN_SCRIPT, force=True)
    assert "-Force" in argv


def test_linux_install_argv_drives_install_service_script():
    argv = provision.linux_install_argv("acme", "widgets", script=LNX_SCRIPT)
    assert argv[0] == "bash" and argv[1] == LNX_SCRIPT
    assert argv[argv.index("--owner") + 1] == "acme"
    assert argv[argv.index("--repo") + 1] == "widgets"
    assert "--force" not in argv


def test_windows_install_admin_runs_script_directly():
    runner, elevate = _Recorder(rc=0), _Recorder(rc=0)
    res = run_provision(
        provision.INSTALL, "acme", "widgets",
        platform=provision.WINDOWS, runner=runner, elevate=elevate,
        is_admin=lambda: True, windows_script=WIN_SCRIPT,
    )
    assert res.ok and res.elevated is False
    assert res.name == "forge-runner-acme-widgets"
    (argv,) = runner.calls
    assert "-InstallService" in argv and "acme" in argv and "widgets" in argv
    assert elevate.calls == []  # already admin -> no UAC


def test_windows_install_non_admin_routes_through_uac_elevation():
    runner, elevate = _Recorder(rc=0), _Recorder(rc=0)
    res = run_provision(
        provision.INSTALL, "acme", "widgets",
        platform=provision.WINDOWS, runner=runner, elevate=elevate,
        is_admin=lambda: False, windows_script=WIN_SCRIPT,
    )
    assert res.ok and res.elevated is True
    assert runner.calls == []  # never runs the mutation un-elevated
    (argv,) = elevate.calls
    assert "-InstallService" in argv


def test_linux_install_runs_over_wsl_no_elevation(tmp_path):
    wsl = _Recorder(rc=0)
    res = run_provision(
        provision.INSTALL, "acme", "widgets",
        platform=provision.LINUX, wsl_runner=wsl,
        linux_script=tmp_path / "install-service.sh",
    )
    assert res.ok and res.elevated is False
    (argv,) = wsl.calls
    assert argv[0] == "bash"
    assert "--owner" in argv and "acme" in argv and "widgets" in argv


# --------------------------------------------------------------------------- #
# AC2 — uninstall drives the counterpart.
# --------------------------------------------------------------------------- #
def test_windows_uninstall_argv_uses_uninstall_flag():
    argv = provision.windows_uninstall_argv("acme", "widgets", script=WIN_SCRIPT)
    assert "-UninstallService" in argv
    assert "-InstallService" not in argv
    assert argv[argv.index("-Owner") + 1] == "acme"


def test_linux_uninstall_argv_uses_uninstall_flag():
    argv = provision.linux_uninstall_argv("acme", "widgets", script=LNX_SCRIPT)
    assert "--uninstall" in argv
    assert argv[argv.index("--owner") + 1] == "acme"


def test_windows_uninstall_runs_counterpart():
    runner = _Recorder(rc=0)
    res = run_provision(
        provision.UNINSTALL, "acme", "widgets",
        platform=provision.WINDOWS, runner=runner,
        is_admin=lambda: True, windows_script=WIN_SCRIPT,
    )
    assert res.ok
    (argv,) = runner.calls
    assert "-UninstallService" in argv and "-InstallService" not in argv


def test_uninstall_is_not_blocked_by_existing_service():
    # Uninstall of an existing service must proceed (that's the point) — no guard.
    runner = _Recorder(rc=0)
    fleet = (_entry("forge-runner-acme-widgets", "acme", "widgets"),)
    res = run_provision(
        provision.UNINSTALL, "acme", "widgets",
        platform=provision.WINDOWS, runner=runner, is_admin=lambda: True,
        entries=fleet, windows_script=WIN_SCRIPT,
    )
    assert res.ok and runner.calls  # shelled out despite the existing service


# --------------------------------------------------------------------------- #
# AC3 — the PAT is never handled: no token param, no token/runner.env on argv.
# --------------------------------------------------------------------------- #
def test_provision_signature_has_no_pat_parameter():
    params = set(inspect.signature(run_provision).parameters)
    assert not any("pat" in p.lower() or "token" in p.lower() or "secret" in p.lower() for p in params)


def test_no_argv_carries_a_pat_or_runner_env():
    runner, wsl, elevate = _Recorder(), _Recorder(), _Recorder()
    for platform, kw in ((provision.WINDOWS, {"runner": runner, "elevate": elevate}),
                         (provision.LINUX, {"wsl_runner": wsl})):
        for action in (provision.INSTALL, provision.UNINSTALL):
            run_provision(
                action, "acme", "widgets", platform=platform, force=True,
                is_admin=lambda: True, windows_script=WIN_SCRIPT,
                linux_script="/mnt/c/repo/runner/linux/install-service.sh", **kw,
            )
    for rec in (runner, wsl, elevate):
        for argv in rec.calls:
            joined = " ".join(argv).lower()
            assert "forge_runner_pat" not in joined
            assert "runner.env" not in joined
            assert "-pat" not in joined


def test_pat_guidance_points_at_out_of_band_store_without_a_token():
    text = provision.PAT_GUIDANCE
    assert "runner.env" in text and "out of band" in text.lower()
    # Guidance is instructional only — it carries a <token> placeholder, never a real one.
    assert "<token>" in text


# --------------------------------------------------------------------------- #
# AC4 — clobber / mis-target guard.
# --------------------------------------------------------------------------- #
def test_check_guards_flags_existing_service():
    fleet = (_entry("forge-runner-acme-widgets", "acme", "widgets"),)
    verdict = check_guards("acme", "widgets", fleet)
    assert verdict.clashes and not verdict.clean
    assert "already exists" in verdict.message


def test_check_guards_flags_mistarget():
    online_zero = OnlineStatus(online=0, offline=0, total=0, known=True)
    fleet = (_entry("forge-runner-acme-widgets", "acme", "widgets", online=online_zero),)
    verdict = check_guards("acme", "widgets", fleet)
    assert verdict.clashes and "mis-target" in verdict.message.lower()


def test_check_guards_clean_when_no_match():
    fleet = (_entry("forge-runner-other-repo", "other", "repo"),)
    assert check_guards("acme", "widgets", fleet).clean


def test_install_refuses_clobber_without_force():
    runner = _Recorder(rc=0)
    fleet = (_entry("forge-runner-acme-widgets", "acme", "widgets"),)
    res = run_provision(
        provision.INSTALL, "acme", "widgets",
        platform=provision.WINDOWS, runner=runner, is_admin=lambda: True,
        entries=fleet, force=False, windows_script=WIN_SCRIPT,
    )
    assert res.ok is False
    assert "refused" in res.message.lower()
    assert runner.calls == []  # never shelled out — no silent clobber


def test_install_with_force_overrides_guard_and_passes_force_flag():
    runner = _Recorder(rc=0)
    fleet = (_entry("forge-runner-acme-widgets", "acme", "widgets"),)
    res = run_provision(
        provision.INSTALL, "acme", "widgets",
        platform=provision.WINDOWS, runner=runner, is_admin=lambda: True,
        entries=fleet, force=True, windows_script=WIN_SCRIPT,
    )
    assert res.ok
    (argv,) = runner.calls
    assert "-Force" in argv  # forwards the override to the script's own guard


# --------------------------------------------------------------------------- #
# Failure surfacing + validation.
# --------------------------------------------------------------------------- #
def test_non_admin_install_failure_gives_clear_elevation_message():
    runner = _Recorder(rc=0)
    elevate = _Recorder(rc=1223)  # ERROR_CANCELLED — UAC declined
    res = run_provision(
        provision.INSTALL, "acme", "widgets",
        platform=provision.WINDOWS, runner=runner, elevate=elevate,
        is_admin=lambda: False, windows_script=WIN_SCRIPT,
    )
    assert res.ok is False and res.elevated is True
    assert "administrator" in res.message.lower() and "1223" in res.message


def test_unknown_action_raises():
    with pytest.raises(ValueError):
        run_provision("pause", "acme", "widgets")


def test_missing_owner_or_repo_raises():
    with pytest.raises(ValueError):
        run_provision(provision.INSTALL, "", "widgets")
    with pytest.raises(ValueError):
        run_provision(provision.INSTALL, "acme", "")
