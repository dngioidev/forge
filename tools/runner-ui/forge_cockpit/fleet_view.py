"""The "Runner fleet" tab — the main view over the #264 discovery core (ticket #265).

This is the read-only overview screen: a table over the normalized
:class:`~forge_cockpit.discovery.Fleet` model that lists every runner with its
target repo, OS/mechanism, service state, and online-runner count (AC1); flags a
mis-targeted service — one that is *running* yet whose configured repo shows **0**
online runners — with a warning icon, a highlighted row, and an explanatory
tooltip (AC2, the #260 diagnosability made visual); and refreshes on demand (a
Refresh button) and on an optional interval **without blocking the UI** (AC3).

Threading (AC3): discovery shells out (``sc query`` / ``systemctl`` / ``docker
ps`` / ``gh api``) and can be slow, so it runs in a :class:`QRunnable` on the
global :class:`QThreadPool`; the result is marshalled back to the GUI thread via a
queued signal. The GUI thread never calls :func:`discovery.discover_fleet`
directly, so the window stays responsive during a scan.

This module renders ONLY the already-normalized, PAT-free #264 model. It never
reads a service environment, ``~/.forge/runner.env``, or any secret store.
"""

from __future__ import annotations

from collections.abc import Callable
from threading import get_ident

from PySide6.QtCore import QAbstractTableModel, QModelIndex, QObject, QRunnable, Qt, QThreadPool, QTimer, Signal
from PySide6.QtGui import QBrush, QColor, QIcon
from PySide6.QtWidgets import (
    QHBoxLayout,
    QHeaderView,
    QLabel,
    QMessageBox,
    QPushButton,
    QStyle,
    QTableView,
    QVBoxLayout,
    QWidget,
)

from forge_cockpit import control, discovery, logs
from forge_cockpit.control import ActionResult
from forge_cockpit.discovery import NSSM, SYSTEMD, Fleet, RunnerEntry
from forge_cockpit.log_view import LogViewer
from forge_cockpit.logs import LogRead

#: The discovery entry point the tab drives; injectable so tests stay hermetic.
Discover = Callable[[], Fleet]

#: Control seam: (entry, action) -> ActionResult. Injectable for hermetic tests.
Controller = Callable[[RunnerEntry, str], ActionResult]

#: Log-read seam: (entry) -> LogRead. Injectable for hermetic tests.
ReadLogs = Callable[[RunnerEntry], LogRead]

#: User-notification seam: (level, title, text) -> None. Defaults to a QMessageBox;
#: tests inject a recorder so no modal dialog blocks the offscreen suite.
Notifier = Callable[[str, str, str], None]

#: Mechanisms whose service can be started/stopped/restarted (AC1). Docker job
#: containers are ephemeral one-job runners — not controllable as a service.
_CONTROLLABLE = frozenset({NSSM, SYSTEMD})

#: Mechanisms that have a viewable service log source (AC2).
_LOGGABLE = frozenset({NSSM, SYSTEMD})

#: Column order for the fleet table (AC1: every field the overview must show).
_COLUMNS: tuple[str, ...] = (
    "Runner",
    "Target repo",
    "OS / mechanism",
    "Service state",
    "Online runners",
)

#: Row-highlight tint for a mis-targeted entry (AC2). A semi-transparent amber so
#: it reads as a warning under both light and dark palettes.
_WARN_BRUSH = QBrush(QColor(220, 120, 0, 70))


def is_mistargeted(entry: RunnerEntry) -> bool:
    """True when a *running* service's known repo has a *known* online count of 0.

    This is the #260 mis-target signal (AC2): the service is up, GitHub answered,
    and yet **no** runner for its configured ``owner/repo`` is online — the runner
    is almost certainly registered against the wrong repo (or not registered at
    all). An *unknown* online count (gh error / no network) is never flagged: we
    only warn when we positively know the repo has zero online runners.
    """
    return (
        entry.service_state == "running"
        and entry.target.known
        and entry.online.known
        and entry.online_count == 0
    )


def _mistarget_tooltip(entry: RunnerEntry) -> str:
    return (
        f"Mis-target: the '{entry.name}' service is running, but its configured "
        f"repo {entry.repo} reports 0 online runners. The runner is likely "
        f"registered against the wrong repository (see #260)."
    )


class FleetTableModel(QAbstractTableModel):
    """A :class:`QAbstractTableModel` bound to the normalized #264 fleet model.

    Holds an immutable snapshot of :class:`RunnerEntry` rows and renders each
    field for :data:`_COLUMNS`. A mis-targeted row (:func:`is_mistargeted`) carries
    a warning icon on its first cell, an amber background across the row, and an
    explanatory tooltip — the AC2 visual.
    """

    def __init__(self, parent: QObject | None = None) -> None:
        super().__init__(parent)
        self._rows: tuple[RunnerEntry, ...] = ()
        self._warn_icon: QIcon | None = None

    # -- population -------------------------------------------------------- #
    def set_fleet(self, fleet: Fleet) -> None:
        """Replace the whole snapshot with ``fleet``'s runners (a full reset)."""
        self.beginResetModel()
        self._rows = fleet.runners
        self.endResetModel()

    def entry_at(self, row: int) -> RunnerEntry:
        """The :class:`RunnerEntry` backing ``row`` (for tests / row-level logic)."""
        return self._rows[row]

    # -- Qt model contract ------------------------------------------------- #
    def rowCount(self, parent: QModelIndex = QModelIndex()) -> int:  # noqa: B008
        return 0 if parent.isValid() else len(self._rows)

    def columnCount(self, parent: QModelIndex = QModelIndex()) -> int:  # noqa: B008
        return 0 if parent.isValid() else len(_COLUMNS)

    def headerData(
        self,
        section: int,
        orientation: Qt.Orientation,
        role: int = Qt.ItemDataRole.DisplayRole,
    ) -> object:
        if role != Qt.ItemDataRole.DisplayRole:
            return None
        if orientation == Qt.Orientation.Horizontal and 0 <= section < len(_COLUMNS):
            return _COLUMNS[section]
        return None

    def data(self, index: QModelIndex, role: int = Qt.ItemDataRole.DisplayRole) -> object:
        if not index.isValid() or not (0 <= index.row() < len(self._rows)):
            return None
        entry = self._rows[index.row()]
        col = index.column()
        flagged = is_mistargeted(entry)

        if role == Qt.ItemDataRole.DisplayRole:
            return _cell_text(entry, col)
        if role == Qt.ItemDataRole.DecorationRole and col == 0 and flagged:
            return self._warning_icon()
        if role == Qt.ItemDataRole.BackgroundRole and flagged:
            return _WARN_BRUSH
        if role == Qt.ItemDataRole.ToolTipRole and flagged:
            return _mistarget_tooltip(entry)
        return None

    def _warning_icon(self) -> QIcon:
        if self._warn_icon is None:
            from PySide6.QtWidgets import QApplication

            app = QApplication.instance()
            style = app.style() if app is not None else None
            self._warn_icon = (
                style.standardIcon(QStyle.StandardPixmap.SP_MessageBoxWarning)
                if style is not None
                else QIcon()
            )
        return self._warn_icon


def _cell_text(entry: RunnerEntry, col: int) -> str:
    if col == 0:
        return entry.name
    if col == 1:
        return entry.repo
    if col == 2:
        return entry.mechanism
    if col == 3:
        return entry.service_state
    if col == 4:
        return str(entry.online_count) if entry.online.known else "?"
    return ""


class _WorkerSignals(QObject):
    """Signals emitted from the discovery worker back onto the GUI thread."""

    finished = Signal(object)  # Fleet
    failed = Signal(str)


class _DiscoveryWorker(QRunnable):
    """Runs :func:`discovery.discover_fleet` off the GUI thread (AC3).

    ``discover`` is called on a thread-pool thread; its result — or the string of
    any exception — is emitted via :class:`_WorkerSignals`, which Qt delivers to
    the connected slots on the receiver's (GUI) thread via a queued connection.
    """

    def __init__(self, discover: Discover) -> None:
        super().__init__()
        self._discover = discover
        self.signals = _WorkerSignals()

    def run(self) -> None:  # pragma: no cover - exercised via the thread pool
        try:
            fleet = self._discover()
        except Exception as exc:  # never let a scan crash the worker thread
            self.signals.failed.emit(f"{type(exc).__name__}: {exc}")
            return
        self.signals.finished.emit(fleet)


class _Job(QRunnable):
    """Runs an arbitrary callable off the GUI thread (control actions, AC1/AC3).

    Reuses the #265 worker pattern: the callable runs on a thread-pool thread and
    its result — or the string of any exception — is emitted via
    :class:`_WorkerSignals`, delivered to the GUI thread by a queued connection so
    a slow ``nssm``/``systemctl`` mutation never blocks the window.
    """

    def __init__(self, fn: Callable[[], object]) -> None:
        super().__init__()
        self._fn = fn
        self.signals = _WorkerSignals()

    def run(self) -> None:  # pragma: no cover - exercised via the thread pool
        try:
            result = self._fn()
        except Exception as exc:  # never let an action crash the worker thread
            self.signals.failed.emit(f"{type(exc).__name__}: {exc}")
            return
        self.signals.finished.emit(result)


class FleetTab(QWidget):
    """The "Runner fleet" tab: a table over the fleet model + async refresh.

    :param discover: the discovery callable (default :func:`discovery.discover_fleet`;
        overridden with a fixture in tests).
    :param auto_refresh_ms: if > 0, poll the fleet on this interval (AC3). Default
        0 (off) so tests are deterministic; the app enables it.
    :param pool: the :class:`QThreadPool` to run discovery on (default the global
        pool); injectable for tests.
    :param initial_refresh: kick a first refresh on construction (default True so
        the tab self-populates in the app; tests may pass False).
    """

    #: Emitted on the GUI thread after a successful refresh has updated the model.
    fleet_loaded = Signal()
    #: Emitted on the GUI thread when a refresh failed (carries the error string).
    refresh_failed = Signal(str)
    #: Emitted on the GUI thread after a control action completes (carries the
    #: :class:`ActionResult`) — the test seam for AC1/AC3 success+failure surfacing.
    action_completed = Signal(object)
    #: Emitted on the GUI thread when a control action's worker itself errored.
    action_failed = Signal(str)
    #: Emitted on the GUI thread when a log viewer is opened (carries the viewer).
    log_viewer_opened = Signal(object)

    def __init__(
        self,
        discover: Discover = discovery.discover_fleet,
        *,
        auto_refresh_ms: int = 0,
        pool: QThreadPool | None = None,
        initial_refresh: bool = True,
        controller: Controller = control.control,
        read_logs: ReadLogs = logs.read_logs,
        notifier: Notifier | None = None,
        log_tail_lines: int = logs.DEFAULT_TAIL_LINES,
        parent: QWidget | None = None,
    ) -> None:
        super().__init__(parent)
        self._discover = discover
        self._pool = pool or QThreadPool.globalInstance()
        self._busy = False
        self._controller = controller
        self._read_logs = read_logs
        self._notifier = notifier or self._default_notifier
        self._log_tail_lines = log_tail_lines
        #: Live references to opened log viewers so they are not GC'd (AC2).
        self._log_viewers: list[LogViewer] = []
        #: Thread ident of the last discovery call — proves it ran off the GUI
        #: thread (AC3). ``None`` until the first refresh runs.
        self.last_discovery_thread_ident: int | None = None
        self._gui_thread_ident = get_ident()

        self._model = FleetTableModel(self)
        self._build_ui()

        self._timer = QTimer(self)
        self._timer.timeout.connect(self.refresh)
        if auto_refresh_ms > 0:
            self._timer.start(auto_refresh_ms)

        if initial_refresh:
            self.refresh()

    # -- UI ---------------------------------------------------------------- #
    def _build_ui(self) -> None:
        layout = QVBoxLayout(self)

        bar = QHBoxLayout()
        self.refresh_button = QPushButton("Refresh")
        self.refresh_button.setToolTip("Re-scan the runner fleet now")
        self.refresh_button.clicked.connect(self.refresh)
        self.status_label = QLabel("")
        bar.addWidget(self.refresh_button)
        bar.addWidget(self.status_label)
        bar.addStretch(1)
        layout.addLayout(bar)

        self.table = QTableView()
        self.table.setModel(self._model)
        self.table.setSelectionBehavior(QTableView.SelectionBehavior.SelectRows)
        self.table.setSelectionMode(QTableView.SelectionMode.SingleSelection)
        self.table.setEditTriggers(QTableView.EditTrigger.NoEditTriggers)
        self.table.setAlternatingRowColors(True)
        self.table.verticalHeader().setVisible(False)
        header = self.table.horizontalHeader()
        header.setStretchLastSection(True)
        header.setSectionResizeMode(0, QHeaderView.ResizeMode.Stretch)
        layout.addWidget(self.table)

        # -- control bar (AC1/AC2/AC3): act on the selected runner ---------- #
        controls = QHBoxLayout()
        self.start_button = QPushButton("Start")
        self.start_button.setToolTip("Start the selected runner service")
        self.start_button.clicked.connect(lambda: self._do_control(control.START))
        self.stop_button = QPushButton("Stop")
        self.stop_button.setToolTip("Stop the selected runner service")
        self.stop_button.clicked.connect(lambda: self._do_control(control.STOP))
        self.restart_button = QPushButton("Restart")
        self.restart_button.setToolTip("Restart the selected runner service")
        self.restart_button.clicked.connect(lambda: self._do_control(control.RESTART))
        self.logs_button = QPushButton("View logs")
        self.logs_button.setToolTip("View + tail the selected runner's logs")
        self.logs_button.clicked.connect(self._view_logs)
        for btn in (self.start_button, self.stop_button, self.restart_button, self.logs_button):
            controls.addWidget(btn)
        controls.addStretch(1)
        layout.addLayout(controls)

        self.table.selectionModel().selectionChanged.connect(self._sync_controls)
        self._sync_controls()

    # -- accessors (for tests / callers) ---------------------------------- #
    @property
    def model(self) -> FleetTableModel:
        return self._model

    def mistarget_rows(self) -> list[int]:
        """Row indices currently flagged as mis-targeted (AC2)."""
        return [
            r for r in range(self._model.rowCount()) if is_mistargeted(self._model.entry_at(r))
        ]

    @property
    def discovery_ran_off_gui_thread(self) -> bool:
        """True once a scan has run and it ran off the GUI thread (AC3)."""
        return (
            self.last_discovery_thread_ident is not None
            and self.last_discovery_thread_ident != self._gui_thread_ident
        )

    # -- refresh (AC3) ----------------------------------------------------- #
    def refresh(self) -> None:
        """Kick an off-thread fleet scan; results land back on the GUI thread.

        A refresh already in flight is a no-op (the interval timer and the button
        can't stack scans). Never blocks: the actual :func:`discover_fleet` call
        happens on a thread-pool thread.
        """
        if self._busy:
            return
        self._busy = True
        self.refresh_button.setEnabled(False)
        self.status_label.setText("Scanning fleet…")

        worker = _DiscoveryWorker(self._instrumented_discover)
        worker.signals.finished.connect(self._on_finished)
        worker.signals.failed.connect(self._on_failed)
        self._pool.start(worker)

    def _instrumented_discover(self) -> Fleet:
        # Runs on the worker thread — record which thread, so AC3 (off-GUI-thread)
        # is assertable, then delegate to the real discovery.
        self.last_discovery_thread_ident = get_ident()
        return self._discover()

    def _on_finished(self, fleet: Fleet) -> None:
        self._model.set_fleet(fleet)
        flagged = len(self.mistarget_rows())
        n = self._model.rowCount()
        note = f"{n} runner(s)"
        if flagged:
            note += f" — {flagged} mis-targeted"
        self.status_label.setText(note)
        self._end_refresh()
        self.fleet_loaded.emit()

    def _on_failed(self, message: str) -> None:
        self.status_label.setText(f"Scan failed: {message}")
        self._end_refresh()
        self.refresh_failed.emit(message)

    def _end_refresh(self) -> None:
        self._busy = False
        self.refresh_button.setEnabled(True)
        self._sync_controls()

    # -- selection + control state (AC1/AC2) ------------------------------- #
    def selected_entry(self) -> RunnerEntry | None:
        """The :class:`RunnerEntry` for the selected row, or ``None`` if none."""
        rows = self.table.selectionModel().selectedRows()
        if not rows:
            return None
        row = rows[0].row()
        if 0 <= row < self._model.rowCount():
            return self._model.entry_at(row)
        return None

    def _sync_controls(self, *_args: object) -> None:
        """Enable start/stop/restart/logs for the selected row, per mechanism.

        No selection -> all disabled. A docker job container is not a controllable
        service and has no service log source, so its controls stay disabled.
        """
        entry = self.selected_entry()
        controllable = entry is not None and entry.mechanism in _CONTROLLABLE
        loggable = entry is not None and entry.mechanism in _LOGGABLE
        for btn in (self.start_button, self.stop_button, self.restart_button):
            btn.setEnabled(controllable)
        self.logs_button.setEnabled(loggable)

    # -- control actions (AC1/AC3) ----------------------------------------- #
    def _do_control(self, action: str) -> None:
        """Run ``action`` on the selected runner off the GUI thread (AC1/AC3).

        Disables the control bar while the action is in flight, then surfaces the
        :class:`ActionResult` — a status line on success, and additionally a
        warning dialog on failure. The action itself (``nssm`` / ``systemctl`` /
        UAC elevation) runs on a thread-pool thread so the window never blocks.
        """
        entry = self.selected_entry()
        if entry is None or entry.mechanism not in _CONTROLLABLE:
            return
        self._set_control_buttons_enabled(False)
        self.status_label.setText(f"{action.capitalize()}ing '{entry.name}'…")

        job = _Job(lambda: self._controller(entry, action))
        job.signals.finished.connect(self._on_control_done)
        job.signals.failed.connect(self._on_control_error)
        self._pool.start(job)

    def _on_control_done(self, result: ActionResult) -> None:
        self.status_label.setText(result.message)
        if not result.ok:
            self._notifier("warning", f"{result.action.capitalize()} failed", result.message)
        self._sync_controls()
        self.action_completed.emit(result)

    def _on_control_error(self, message: str) -> None:
        text = f"The control action could not run: {message}"
        self.status_label.setText(text)
        self._notifier("critical", "Control action error", text)
        self._sync_controls()
        self.action_failed.emit(message)

    def _set_control_buttons_enabled(self, on: bool) -> None:
        for btn in (self.start_button, self.stop_button, self.restart_button, self.logs_button):
            btn.setEnabled(on)

    def _default_notifier(self, level: str, title: str, text: str) -> None:
        """Surface a message via a modal dialog (the real, non-test notifier)."""
        fn = getattr(QMessageBox, level, QMessageBox.information)
        fn(self, title, text)

    # -- log viewing (AC2) ------------------------------------------------- #
    def _view_logs(self) -> None:
        """Open a log viewer for the selected runner (reads off the GUI thread)."""
        entry = self.selected_entry()
        if entry is None or entry.mechanism not in _LOGGABLE:
            return
        viewer = self.open_log_viewer(entry)
        viewer.show()

    def open_log_viewer(self, entry: RunnerEntry) -> LogViewer:
        """Build (but do not show) a :class:`LogViewer` for ``entry``.

        The viewer is handed a reader bound to this entry + the configured tail
        depth; it reads on the shared thread pool. A live reference is retained so
        the dialog is not garbage-collected while open.
        """
        def read() -> LogRead:
            return self._read_logs(entry, lines=self._log_tail_lines)

        title = f"Logs — {entry.name} ({entry.mechanism})"
        viewer = LogViewer(title, read, pool=self._pool, parent=self)
        self._log_viewers.append(viewer)
        viewer.destroyed.connect(lambda *_: self._forget_viewer(viewer))
        self.log_viewer_opened.emit(viewer)
        return viewer

    def _forget_viewer(self, viewer: LogViewer) -> None:
        if viewer in self._log_viewers:
            self._log_viewers.remove(viewer)
