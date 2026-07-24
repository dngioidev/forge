"""Tests for the log viewer dialog (ticket #266, AC2).

Hermetic + headless (offscreen): the reader is a fake, so no file/journal is
touched. Locks: the viewer reads OFF the GUI thread, renders the text, surfaces a
source line, handles a failed read without crashing, and the "Tail" toggle arms
the poll timer.
"""

from __future__ import annotations

from threading import get_ident

import pytest

from forge_cockpit.log_view import LogViewer
from forge_cockpit.logs import LogRead


@pytest.fixture
def _app(qapp):
    return qapp


class RecordingRead:
    """A fake bound reader: records the thread it ran on, returns a canned read."""

    def __init__(self, result: LogRead) -> None:
        self.result = result
        self.calls = 0
        self.thread_idents: list[int] = []

    def __call__(self) -> LogRead:
        self.calls += 1
        self.thread_idents.append(get_ident())
        return self.result


def _make(qtbot, read) -> LogViewer:
    viewer = LogViewer("Logs — test", read, initial_read=False)
    qtbot.addWidget(viewer)
    return viewer


def test_reads_off_the_gui_thread_and_renders(_app, qtbot):
    read = RecordingRead(LogRead(ok=True, text="line a\nline b", source="C:/logs"))
    viewer = _make(qtbot, read)
    gui_thread = get_ident()

    with qtbot.waitSignal(viewer.logs_loaded, timeout=5000):
        viewer.refresh()

    assert read.calls == 1
    assert read.thread_idents[0] != gui_thread  # ran off the GUI thread (AC2)
    assert "line a" in viewer.text.toPlainText()
    assert viewer.status_label.text() == "C:/logs"


def test_failed_read_result_is_surfaced(_app, qtbot):
    read = RecordingRead(LogRead(ok=False, text="No service log files", source="C:/logs"))
    viewer = _make(qtbot, read)

    with qtbot.waitSignal(viewer.logs_loaded, timeout=5000):
        viewer.refresh()

    assert "No service log files" in viewer.text.toPlainText()
    assert "No logs" in viewer.status_label.text()


def test_reader_exception_is_caught_not_raised(_app, qtbot):
    def boom() -> LogRead:
        raise RuntimeError("journal exploded")

    viewer = _make(qtbot, boom)

    with qtbot.waitSignal(viewer.load_failed, timeout=5000) as sig:
        viewer.refresh()

    assert "journal exploded" in sig.args[0]
    assert "failed" in viewer.status_label.text().lower()


def test_tail_toggle_arms_the_timer(_app, qtbot):
    read = RecordingRead(LogRead(ok=True, text="x", source="s"))
    viewer = _make(qtbot, read)

    assert viewer.tailing is False
    # Toggling on both reads immediately and starts the poll timer.
    with qtbot.waitSignal(viewer.logs_loaded, timeout=5000):
        viewer.tail_checkbox.setChecked(True)
    assert viewer.tailing is True

    viewer.tail_checkbox.setChecked(False)
    assert viewer.tailing is False
