"""Tests for the install/uninstall dialog + fleet wiring (ticket #267, AC1-AC4).

Hermetic + headless (offscreen): the provisioner, fleet snapshot, and notifier are
fakes, so no script, WSL, UAC prompt, or modal dialog runs. Locks:

* AC1 — Install runs the provisioner for the chosen owner/repo OFF the GUI thread.
* AC2 — Uninstall runs the provisioner with the UNINSTALL action.
* AC3 — the dialog has NO PAT/token input field; it shows out-of-band guidance, and
  the provisioner is never handed a token.
* AC4 — an un-forced install against an existing service is blocked pre-flight
  (guard fires, notifier warns, provisioner NOT called); Force overrides it.
"""

from __future__ import annotations

from threading import get_ident

import pytest
from PySide6.QtWidgets import QLineEdit

from forge_cockpit import provision
from forge_cockpit.discovery import (
    NSSM,
    Fleet,
    OnlineStatus,
    RunnerEntry,
    Target,
)
from forge_cockpit.fleet_view import FleetTab
from forge_cockpit.provision import ProvisionResult
from forge_cockpit.provision_view import ProvisionDialog


@pytest.fixture
def _app(qapp):
    return qapp


def _entry(name: str, owner: str, repo: str, online=None) -> RunnerEntry:
    return RunnerEntry(
        name=name,
        mechanism=NSSM,
        service_state="running",
        target=Target(owner, repo),
        online=online or OnlineStatus.unknown(),
    )


class RecordingProvisioner:
    """Fake provisioner: records call + thread, returns a canned ProvisionResult."""

    def __init__(self, ok: bool = True, message: str = "done") -> None:
        self.calls: list[tuple] = []
        self.kwargs: list[dict] = []
        self.thread_idents: list[int] = []
        self._ok, self._message = ok, message

    def __call__(self, action, owner, repo, **kw) -> ProvisionResult:
        self.calls.append((action, owner, repo))
        self.kwargs.append(kw)
        self.thread_idents.append(get_ident())
        return ProvisionResult(
            action=action, platform=kw.get("platform", provision.WINDOWS),
            name=provision.service_name(owner, repo), owner=owner, repo=repo,
            ok=self._ok, elevated=False, message=self._message,
        )


class RecordingNotifier:
    def __init__(self) -> None:
        self.calls: list[tuple[str, str, str]] = []

    def __call__(self, level, title, text) -> None:
        self.calls.append((level, title, text))


def _dialog(qtbot, *, provisioner=None, entries=(), notifier=None,
            owner="acme", repo="widgets") -> ProvisionDialog:
    dlg = ProvisionDialog(
        provisioner=provisioner or RecordingProvisioner(),
        fleet_entries=lambda: entries,
        notifier=notifier or RecordingNotifier(),
        default_owner=owner,
        default_repo=repo,
        default_platform=provision.WINDOWS,
    )
    qtbot.addWidget(dlg)
    return dlg


# --------------------------------------------------------------------------- #
# AC3 — no PAT field; out-of-band guidance shown; provisioner never gets a token.
# --------------------------------------------------------------------------- #
def test_dialog_has_no_pat_or_token_input_field(_app, qtbot):
    dlg = _dialog(qtbot)
    edits = dlg.findChildren(QLineEdit)
    # Exactly the owner + repo fields — no PAT/token/secret entry, and none masked.
    assert set(edits) == {dlg.owner_edit, dlg.repo_edit}
    for e in edits:
        assert e.echoMode() == QLineEdit.EchoMode.Normal  # nothing password-masked
        name = (e.objectName() + e.placeholderText()).lower()
        assert "pat" not in name and "token" not in name and "secret" not in name


def test_dialog_shows_out_of_band_pat_guidance(_app, qtbot):
    dlg = _dialog(qtbot)
    from PySide6.QtWidgets import QPlainTextEdit

    texts = " ".join(w.toPlainText() for w in dlg.findChildren(QPlainTextEdit))
    assert "runner.env" in texts and "out of band" in texts.lower()


def test_provisioner_never_receives_a_pat(_app, qtbot):
    prov = RecordingProvisioner()
    dlg = _dialog(qtbot, provisioner=prov)
    with qtbot.waitSignal(dlg.provision_done, timeout=5000):
        dlg.install_button.click()
    for kw in prov.kwargs:
        assert not any(k.lower() in {"pat", "token", "secret"} for k in kw)


# --------------------------------------------------------------------------- #
# AC1 — Install runs the provisioner off the GUI thread for the chosen target.
# --------------------------------------------------------------------------- #
def test_install_runs_provisioner_off_gui_thread(_app, qtbot):
    prov = RecordingProvisioner(ok=True, message="install ok")
    dlg = _dialog(qtbot, provisioner=prov)
    gui = get_ident()

    with qtbot.waitSignal(dlg.provision_done, timeout=5000) as sig:
        dlg.install_button.click()

    assert prov.calls == [(provision.INSTALL, "acme", "widgets")]
    assert prov.thread_idents[0] != gui  # ran off the GUI thread (AC1)
    assert sig.args[0].ok is True
    assert dlg.status_label.text() == "install ok"


def test_install_missing_target_warns_and_does_not_run(_app, qtbot):
    prov = RecordingProvisioner()
    notifier = RecordingNotifier()
    dlg = _dialog(qtbot, provisioner=prov, notifier=notifier, owner="", repo="")
    dlg.install_button.click()
    assert prov.calls == []
    assert notifier.calls and notifier.calls[0][0] == "warning"


# --------------------------------------------------------------------------- #
# AC2 — Uninstall runs the provisioner with the UNINSTALL action.
# --------------------------------------------------------------------------- #
def test_uninstall_runs_provisioner_with_uninstall_action(_app, qtbot):
    prov = RecordingProvisioner(ok=True, message="uninstall ok")
    dlg = _dialog(qtbot, provisioner=prov)
    with qtbot.waitSignal(dlg.provision_done, timeout=5000):
        dlg.uninstall_button.click()
    assert prov.calls == [(provision.UNINSTALL, "acme", "widgets")]


# --------------------------------------------------------------------------- #
# AC4 — clobber guard blocks an un-forced install; Force overrides it.
# --------------------------------------------------------------------------- #
def test_install_blocked_by_guard_when_service_exists(_app, qtbot):
    prov = RecordingProvisioner()
    notifier = RecordingNotifier()
    existing = (_entry("forge-runner-acme-widgets", "acme", "widgets"),)
    dlg = _dialog(qtbot, provisioner=prov, entries=existing, notifier=notifier)

    with qtbot.waitSignal(dlg.guard_blocked, timeout=5000):
        dlg.install_button.click()

    assert prov.calls == []  # refused pre-flight — no silent clobber (AC4)
    assert notifier.calls and notifier.calls[0][0] == "warning"
    assert "already exists" in notifier.calls[0][2]


def test_force_checkbox_overrides_guard(_app, qtbot):
    prov = RecordingProvisioner(ok=True)
    existing = (_entry("forge-runner-acme-widgets", "acme", "widgets"),)
    dlg = _dialog(qtbot, provisioner=prov, entries=existing)
    dlg.force_checkbox.setChecked(True)

    with qtbot.waitSignal(dlg.provision_done, timeout=5000):
        dlg.install_button.click()

    assert prov.calls == [(provision.INSTALL, "acme", "widgets")]
    assert prov.kwargs[0]["force"] is True


def test_failed_provision_surfaces_via_notifier(_app, qtbot):
    prov = RecordingProvisioner(ok=False, message="needs administrator rights")
    notifier = RecordingNotifier()
    dlg = _dialog(qtbot, provisioner=prov, notifier=notifier)
    with qtbot.waitSignal(dlg.provision_done, timeout=5000):
        dlg.install_button.click()
    assert notifier.calls and notifier.calls[0][0] == "warning"
    assert "administrator" in notifier.calls[0][2]


# --------------------------------------------------------------------------- #
# Fleet wiring — the button opens a prefilled, guard-wired dialog (#267).
# --------------------------------------------------------------------------- #
NSSM_ENTRY = _entry("forge-runner-acme-widgets", "acme", "widgets")
FLEET = Fleet(runners=(NSSM_ENTRY,))


def test_fleet_button_opens_prefilled_dialog(_app, qtbot):
    prov = RecordingProvisioner()
    # Inject a recording notifier so the guard-blocked path never opens a real
    # (blocking) QMessageBox in the offscreen suite.
    tab = FleetTab(
        lambda: FLEET, initial_refresh=False, provisioner=prov, notifier=RecordingNotifier()
    )
    qtbot.addWidget(tab)
    with qtbot.waitSignal(tab.fleet_loaded, timeout=5000):
        tab.refresh()
    tab.table.selectRow(0)

    with qtbot.waitSignal(tab.provision_dialog_opened, timeout=5000) as sig:
        tab.provision_button.click()

    dlg = sig.args[0]
    qtbot.addWidget(dlg)
    assert isinstance(dlg, ProvisionDialog)
    # Prefilled from the selected runner's target (AC1 target selection).
    assert dlg.owner_edit.text() == "acme"
    assert dlg.repo_edit.text() == "widgets"
    # And it carries the live fleet for its guard: an un-forced install is blocked.
    with qtbot.waitSignal(dlg.guard_blocked, timeout=5000):
        dlg.install_button.click()
    assert prov.calls == []
