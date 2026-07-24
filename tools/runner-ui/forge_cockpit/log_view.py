"""The log viewer dialog (ticket #266, AC2) — read + tail a runner's logs.

Reads happen OFF the GUI thread (the same :class:`QThreadPool` worker pattern as
the #265 fleet refresh) so the window never blocks; a Refresh button reads once
and a "Tail" toggle re-reads the last N lines on an interval for a live tail.

It renders read-only text only — it never fetches the service ENVIRONMENT or a
PAT; it shows exactly what the runner already wrote to its own logs/journal, via
the PAT-free :func:`forge_cockpit.logs.read_logs` seam.
"""

from __future__ import annotations

from collections.abc import Callable

from PySide6.QtCore import QObject, QRunnable, Qt, QThreadPool, QTimer, Signal
from PySide6.QtWidgets import (
    QCheckBox,
    QDialog,
    QHBoxLayout,
    QLabel,
    QPlainTextEdit,
    QPushButton,
    QVBoxLayout,
    QWidget,
)

from forge_cockpit.logs import LogRead

#: A bound reader: returns the current tail for one runner. Injectable for tests.
ReadLogs = Callable[[], LogRead]

#: Default tail poll interval when the "Tail" toggle is on (ms).
TAIL_INTERVAL_MS = 3000


class _ReadSignals(QObject):
    finished = Signal(object)  # LogRead
    failed = Signal(str)


class _ReadJob(QRunnable):
    """Runs a :data:`ReadLogs` off the GUI thread and marshals the result back."""

    def __init__(self, read: ReadLogs) -> None:
        super().__init__()
        self._read = read
        self.signals = _ReadSignals()

    def run(self) -> None:  # pragma: no cover - exercised via the thread pool
        try:
            result = self._read()
        except Exception as exc:  # never let a read crash the worker thread
            self.signals.failed.emit(f"{type(exc).__name__}: {exc}")
            return
        self.signals.finished.emit(result)


class LogViewer(QDialog):
    """A dialog that shows + tails one runner's logs, reading off the GUI thread.

    :param title: window title (usually the runner name + source).
    :param read: the bound reader callable (default binds :func:`logs.read_logs`).
    :param pool: thread pool to read on (default the global pool); injectable.
    :param tail_ms: interval for the "Tail" toggle (default :data:`TAIL_INTERVAL_MS`).
    :param initial_read: kick a first read on construction (default True; tests may
        pass False for determinism).
    """

    #: Emitted on the GUI thread after a read has updated the pane.
    logs_loaded = Signal()
    #: Emitted on the GUI thread when a read failed (carries the error string).
    load_failed = Signal(str)

    def __init__(
        self,
        title: str,
        read: ReadLogs,
        *,
        pool: QThreadPool | None = None,
        tail_ms: int = TAIL_INTERVAL_MS,
        initial_read: bool = True,
        parent: QWidget | None = None,
    ) -> None:
        super().__init__(parent)
        self._read = read
        self._pool = pool or QThreadPool.globalInstance()
        self._busy = False
        self.setWindowTitle(title)
        self.resize(820, 560)

        self._build_ui()

        self._timer = QTimer(self)
        self._timer.setInterval(tail_ms)
        self._timer.timeout.connect(self.refresh)

        if initial_read:
            self.refresh()

    # -- UI ---------------------------------------------------------------- #
    def _build_ui(self) -> None:
        layout = QVBoxLayout(self)

        bar = QHBoxLayout()
        self.refresh_button = QPushButton("Refresh")
        self.refresh_button.setToolTip("Re-read the last lines of the log now")
        self.refresh_button.clicked.connect(self.refresh)
        self.tail_checkbox = QCheckBox("Tail")
        self.tail_checkbox.setToolTip("Automatically re-read the log on an interval")
        self.tail_checkbox.toggled.connect(self._on_tail_toggled)
        self.status_label = QLabel("")
        bar.addWidget(self.refresh_button)
        bar.addWidget(self.tail_checkbox)
        bar.addWidget(self.status_label)
        bar.addStretch(1)
        layout.addLayout(bar)

        self.text = QPlainTextEdit()
        self.text.setReadOnly(True)
        self.text.setLineWrapMode(QPlainTextEdit.LineWrapMode.NoWrap)
        # A monospaced-ish, log-friendly view; keep a bounded scrollback.
        self.text.setMaximumBlockCount(20_000)
        layout.addWidget(self.text)

    # -- tail toggle ------------------------------------------------------- #
    def _on_tail_toggled(self, on: bool) -> None:
        if on:
            self._timer.start()
            self.refresh()
        else:
            self._timer.stop()

    @property
    def tailing(self) -> bool:
        """True when the tail timer is active."""
        return self._timer.isActive()

    # -- read (off the GUI thread) ----------------------------------------- #
    def refresh(self) -> None:
        """Kick an off-thread log read; the result lands back on the GUI thread."""
        if self._busy:
            return
        self._busy = True
        self.refresh_button.setEnabled(False)
        self.status_label.setText("Reading…")

        job = _ReadJob(self._read)
        job.signals.finished.connect(self._on_finished)
        job.signals.failed.connect(self._on_failed)
        self._pool.start(job)

    def _on_finished(self, result: LogRead) -> None:
        self.text.setPlainText(result.text)
        self._scroll_to_end()
        if result.ok:
            self.status_label.setText(result.source)
        else:
            self.status_label.setText(f"No logs: {result.source}")
        self._end()
        self.logs_loaded.emit()

    def _on_failed(self, message: str) -> None:
        self.status_label.setText(f"Read failed: {message}")
        self._end()
        self.load_failed.emit(message)

    def _scroll_to_end(self) -> None:
        self.text.moveCursor(self.text.textCursor().MoveOperation.End)
        bar = self.text.verticalScrollBar()
        bar.setValue(bar.maximum())

    def _end(self) -> None:
        self._busy = False
        self.refresh_button.setEnabled(True)

    # -- lifecycle --------------------------------------------------------- #
    def closeEvent(self, event) -> None:  # noqa: N802 - Qt override
        self._timer.stop()
        super().closeEvent(event)
