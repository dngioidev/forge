"""The install / uninstall dialog (ticket #267) — stand a runner up/down, secret-safe.

A small modal to pick the target ``owner``/``repo`` and Install or Uninstall the
repo-scoped runner service by driving the setup scripts via
:mod:`forge_cockpit.provision`. The work runs OFF the GUI thread (the same
:class:`QThreadPool` worker pattern as the #265 fleet refresh / #266 control
actions) so a slow ``setup-runner.ps1`` / UAC prompt / ``install-service.sh`` never
blocks the window.

Secret safety (AC3): the dialog shows read-only PAT *guidance*
(:data:`~forge_cockpit.provision.PAT_GUIDANCE`) pointing the operator at the
out-of-band store. It has **no token field** — nothing here accepts, echoes, logs,
persists, or commits a PAT.

Clobber/mis-target guard (AC4): before an un-forced install the dialog cross-checks
the current fleet via :func:`provision.check_guards` and, when a service for that
repo already exists, warns via the notifier and does NOT proceed unless "Force
(override an existing service)" is ticked.
"""

from __future__ import annotations

from collections.abc import Callable

from PySide6.QtCore import QObject, QRunnable, QThreadPool, Signal
from PySide6.QtWidgets import (
    QCheckBox,
    QComboBox,
    QDialog,
    QFormLayout,
    QHBoxLayout,
    QLabel,
    QLineEdit,
    QMessageBox,
    QPlainTextEdit,
    QPushButton,
    QVBoxLayout,
    QWidget,
)

from forge_cockpit import provision
from forge_cockpit.discovery import RunnerEntry
from forge_cockpit.provision import ProvisionResult

#: The provisioning callable seam: (action, owner, repo, **kw) -> ProvisionResult.
Provisioner = Callable[..., ProvisionResult]

#: Supplies the current fleet snapshot for the clobber guard (injectable in tests).
FleetEntries = Callable[[], tuple[RunnerEntry, ...]]

#: User-notification seam: (level, title, text) -> None. Defaults to a QMessageBox;
#: tests inject a recorder so no modal blocks the offscreen suite.
Notifier = Callable[[str, str, str], None]

_PLATFORM_LABELS: tuple[tuple[str, str], ...] = (
    (provision.WINDOWS, "Windows (NSSM service)"),
    (provision.LINUX, "Linux (systemd --user, over WSL)"),
)


class _JobSignals(QObject):
    finished = Signal(object)  # ProvisionResult
    failed = Signal(str)


class _Job(QRunnable):
    """Runs a callable off the GUI thread; marshals the result/error back."""

    def __init__(self, fn: Callable[[], object]) -> None:
        super().__init__()
        self._fn = fn
        self.signals = _JobSignals()

    def run(self) -> None:  # pragma: no cover - exercised via the thread pool
        try:
            result = self._fn()
        except Exception as exc:  # never let a run crash the worker thread
            self.signals.failed.emit(f"{type(exc).__name__}: {exc}")
            return
        self.signals.finished.emit(result)


class ProvisionDialog(QDialog):
    """Pick owner/repo + Install/Uninstall the repo-scoped runner service (secret-safe)."""

    #: Emitted on the GUI thread after a provision action completes (ProvisionResult).
    provision_done = Signal(object)
    #: Emitted on the GUI thread when the provision worker itself errored.
    provision_failed = Signal(str)
    #: Emitted when an install was refused pre-flight by the clobber guard (AC4).
    guard_blocked = Signal(str)

    def __init__(
        self,
        *,
        provisioner: Provisioner = provision.provision,
        fleet_entries: FleetEntries = lambda: (),
        notifier: Notifier | None = None,
        default_owner: str = "",
        default_repo: str = "",
        default_platform: str | None = None,
        pool: QThreadPool | None = None,
        parent: QWidget | None = None,
    ) -> None:
        super().__init__(parent)
        self._provisioner = provisioner
        self._fleet_entries = fleet_entries
        self._notifier = notifier or self._default_notifier
        self._pool = pool or QThreadPool.globalInstance()
        self._busy = False
        self.setWindowTitle("Install / uninstall a runner service")
        self.resize(560, 440)
        self._build_ui(default_owner, default_repo, default_platform or provision.default_platform())

    # -- UI ---------------------------------------------------------------- #
    def _build_ui(self, owner: str, repo: str, platform: str) -> None:
        layout = QVBoxLayout(self)

        form = QFormLayout()
        self.owner_edit = QLineEdit(owner)
        self.owner_edit.setPlaceholderText("owner (e.g. dngioidev)")
        self.repo_edit = QLineEdit(repo)
        self.repo_edit.setPlaceholderText("repo (e.g. forge)")
        self.platform_combo = QComboBox()
        for value, label in _PLATFORM_LABELS:
            self.platform_combo.addItem(label, value)
        idx = self.platform_combo.findData(platform)
        if idx >= 0:
            self.platform_combo.setCurrentIndex(idx)
        form.addRow("Owner", self.owner_edit)
        form.addRow("Repository", self.repo_edit)
        form.addRow("Platform", self.platform_combo)
        layout.addLayout(form)

        self.name_label = QLabel("")
        self.name_label.setToolTip("The #260 repo-scoped service name the scripts derive")
        layout.addWidget(self.name_label)
        self.owner_edit.textChanged.connect(self._sync_name)
        self.repo_edit.textChanged.connect(self._sync_name)
        self._sync_name()

        self.force_checkbox = QCheckBox("Force (override an existing service for this repo)")
        self.force_checkbox.setToolTip(
            "Maps to setup-runner.ps1 -Force / install-service.sh --force. Needed to "
            "replace an existing (possibly mis-targeted) service for this repo."
        )
        layout.addWidget(self.force_checkbox)

        # PAT guidance — READ-ONLY, no token field (AC3).
        guidance = QPlainTextEdit()
        guidance.setReadOnly(True)
        guidance.setPlainText(provision.PAT_GUIDANCE)
        guidance.setMaximumHeight(150)
        layout.addWidget(QLabel("PAT (handled out of band — never entered here):"))
        layout.addWidget(guidance)

        self.status_label = QLabel("")
        self.status_label.setWordWrap(True)
        layout.addWidget(self.status_label)

        buttons = QHBoxLayout()
        self.install_button = QPushButton("Install")
        self.install_button.setToolTip("Run the setup script's install for this repo")
        self.install_button.clicked.connect(self._on_install)
        self.uninstall_button = QPushButton("Uninstall")
        self.uninstall_button.setToolTip("Run the setup script's uninstall for this repo")
        self.uninstall_button.clicked.connect(self._on_uninstall)
        self.close_button = QPushButton("Close")
        self.close_button.clicked.connect(self.reject)
        buttons.addWidget(self.install_button)
        buttons.addWidget(self.uninstall_button)
        buttons.addStretch(1)
        buttons.addWidget(self.close_button)
        layout.addLayout(buttons)

    # -- accessors --------------------------------------------------------- #
    def _target(self) -> tuple[str, str, str]:
        return (
            self.owner_edit.text().strip(),
            self.repo_edit.text().strip(),
            self.platform_combo.currentData(),
        )

    def _sync_name(self) -> None:
        owner, repo, _ = self._target()
        if owner and repo:
            self.name_label.setText(f"Service name: {provision.service_name(owner, repo)}")
        else:
            self.name_label.setText("Service name: (enter owner + repo)")

    # -- actions ----------------------------------------------------------- #
    def _on_install(self) -> None:
        owner, repo, platform = self._target()
        if not owner or not repo:
            self._notifier("warning", "Missing target", "Enter both an owner and a repo.")
            return
        force = self.force_checkbox.isChecked()

        # AC4: pre-flight the clobber/mis-target guard against the live fleet. When it
        # fires and Force is off, warn and do NOT proceed (no silent clobber).
        if not force:
            verdict = provision.check_guards(owner, repo, tuple(self._fleet_entries()))
            if verdict.clashes:
                self._notifier("warning", "Service already exists", verdict.message)
                self.status_label.setText(verdict.message)
                self.guard_blocked.emit(verdict.message)
                return
        self._run(provision.INSTALL, owner, repo, platform, force)

    def _on_uninstall(self) -> None:
        owner, repo, platform = self._target()
        if not owner or not repo:
            self._notifier("warning", "Missing target", "Enter both an owner and a repo.")
            return
        self._run(provision.UNINSTALL, owner, repo, platform, force=False)

    def _run(self, action: str, owner: str, repo: str, platform: str, force: bool) -> None:
        if self._busy:
            return
        self._busy = True
        self._set_buttons_enabled(False)
        self.status_label.setText(f"{action.capitalize()}ing '{provision.service_name(owner, repo)}'…")

        entries = tuple(self._fleet_entries())

        def work() -> ProvisionResult:
            return self._provisioner(
                action, owner, repo, platform=platform, force=force, entries=entries
            )

        job = _Job(work)
        job.signals.finished.connect(self._on_done)
        job.signals.failed.connect(self._on_error)
        self._pool.start(job)

    def _on_done(self, result: ProvisionResult) -> None:
        self.status_label.setText(result.message)
        if not result.ok:
            self._notifier("warning", f"{result.action.capitalize()} failed", result.message)
        self._end()
        self.provision_done.emit(result)

    def _on_error(self, message: str) -> None:
        text = f"The provisioning action could not run: {message}"
        self.status_label.setText(text)
        self._notifier("critical", "Provisioning error", text)
        self._end()
        self.provision_failed.emit(message)

    def _end(self) -> None:
        self._busy = False
        self._set_buttons_enabled(True)

    def _set_buttons_enabled(self, on: bool) -> None:
        self.install_button.setEnabled(on)
        self.uninstall_button.setEnabled(on)

    def _default_notifier(self, level: str, title: str, text: str) -> None:
        fn = getattr(QMessageBox, level, QMessageBox.information)
        fn(self, title, text)
