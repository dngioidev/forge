"""Tests for the embedded pywinpty/ConPTY terminal (ticket #275).

Hermetic + headless (offscreen): pywinpty is NEVER used — every session spawns
through a fake pty (:class:`FakePty`) injected via the ``spawn`` seam, so no real
shell is launched on the CI runner. The suite locks the ACs:

* AC1 — a Windows PTY session spawns the expected shell (``powershell.exe``),
  keystrokes are written to the pty, pty output is rendered into the view, and a
  resize propagates the new ``(cols, rows)`` to the pty.
* AC2 — a second session spawns ``wsl.exe``, reaching the WSL2 Linux side.
* AC3 — the terminal injects NO secret: the real spawn seam passes ``env=None``
  (nothing added to the child env), the module never references ``runner.env`` /
  any PAT, and starting a session reads no such file.
"""

from __future__ import annotations

from collections.abc import Sequence

import pytest
from PySide6.QtCore import QSize, Qt
from PySide6.QtGui import QKeyEvent, QResizeEvent

from forge_cockpit import terminal
from forge_cockpit.terminal import (
    WINDOWS_SHELL,
    WSL_SHELL,
    PtySession,
    ShellSpec,
    TerminalPage,
    TerminalTab,
    TerminalView,
    key_to_bytes,
    render_output,
)


@pytest.fixture
def _app(qapp):
    """Reuse pytest-qt's offscreen QApplication (conftest forces offscreen)."""
    return qapp


# --------------------------------------------------------------------------- #
# A fake pty — records everything; never touches the OS.
# --------------------------------------------------------------------------- #
class FakePty:
    """A stand-in for :class:`winpty.PtyProcess`.

    ``read`` serves the queued ``chunks`` one at a time, then raises ``EOFError``
    (as pywinpty does on close), which ends the reader thread cleanly. Writes and
    resizes are recorded for assertions.
    """

    def __init__(self, chunks: Sequence[str] = ()) -> None:
        self._chunks = list(chunks)
        self.writes: list[str] = []
        self.winsizes: list[tuple[int, int]] = []  # (rows, cols)
        self.closed = False

    def read(self, size: int) -> str:
        if self._chunks:
            return self._chunks.pop(0)
        raise EOFError("pty closed")

    def write(self, data: str) -> int:
        self.writes.append(data)
        return len(data)

    def setwinsize(self, rows: int, cols: int) -> None:
        self.winsizes.append((rows, cols))

    def isalive(self) -> bool:
        return not self.closed

    def close(self, force: bool = False) -> None:
        self.closed = True


class RecordingSpawn:
    """A spawn seam that records each call and returns a pre-seeded :class:`FakePty`."""

    def __init__(self, *, chunks: Sequence[str] = ()) -> None:
        self._chunks = chunks
        self.calls: list[tuple[tuple[str, ...], int, int]] = []
        self.ptys: list[FakePty] = []

    def __call__(self, argv: Sequence[str], cols: int, rows: int) -> FakePty:
        self.calls.append((tuple(argv), cols, rows))
        pty = FakePty(self._chunks)
        self.ptys.append(pty)
        return pty


def _press(key: Qt.Key, text: str = "") -> QKeyEvent:
    return QKeyEvent(QKeyEvent.Type.KeyPress, key, Qt.KeyboardModifier.NoModifier, text)


# --------------------------------------------------------------------------- #
# AC1 — Windows session spawns the expected shell.
# --------------------------------------------------------------------------- #
def test_windows_session_spawns_powershell(_app):
    spawn = RecordingSpawn()
    session = PtySession(WINDOWS_SHELL, spawn=spawn, cols=100, rows=30)
    session.start()

    assert len(spawn.calls) == 1
    argv, cols, rows = spawn.calls[0]
    assert argv[0] == "powershell.exe"
    assert (cols, rows) == (100, 30)
    session.close()


def test_default_shells_offer_windows_then_wsl():
    tab_shells = terminal.DEFAULT_SHELLS
    assert tab_shells[0].argv == WINDOWS_SHELL
    assert tab_shells[0].argv[0] == "powershell.exe"
    assert WSL_SHELL[0] == "wsl.exe"


# --------------------------------------------------------------------------- #
# AC1 — keystrokes are written to the pty.
# --------------------------------------------------------------------------- #
def test_keystrokes_are_written_to_the_pty(_app):
    spawn = RecordingSpawn()
    session = PtySession(WINDOWS_SHELL, spawn=spawn)
    session.start()
    pty = spawn.ptys[0]

    session.write("l")
    session.write("s")
    session.write("\r")

    assert pty.writes == ["l", "s", "\r"]
    session.close()


def test_view_keypress_writes_to_the_pty(_app, qtbot):
    spawn = RecordingSpawn()
    session = PtySession(WSL_SHELL, spawn=spawn)
    view = TerminalView(session)
    qtbot.addWidget(view)
    session.start()
    pty = spawn.ptys[0]

    view.keyPressEvent(_press(Qt.Key.Key_A, "a"))
    view.keyPressEvent(_press(Qt.Key.Key_Return))

    assert "a" in pty.writes
    assert "\r" in pty.writes  # Enter maps to CR (AC1 input)
    session.close()


def test_key_to_bytes_maps_special_keys():
    assert key_to_bytes(_press(Qt.Key.Key_Return)) == "\r"
    assert key_to_bytes(_press(Qt.Key.Key_Backspace)) == "\x7f"
    assert key_to_bytes(_press(Qt.Key.Key_Up)) == "\x1b[A"
    assert key_to_bytes(_press(Qt.Key.Key_Left)) == "\x1b[D"
    assert key_to_bytes(_press(Qt.Key.Key_X, "x")) == "x"


# --------------------------------------------------------------------------- #
# AC1 — pty output is rendered into the view (off the GUI thread).
# --------------------------------------------------------------------------- #
def test_pty_output_is_rendered_into_the_view(_app, qtbot):
    spawn = RecordingSpawn(chunks=["hello ", "world\n"])
    session = PtySession(WINDOWS_SHELL, spawn=spawn)
    view = TerminalView(session)
    qtbot.addWidget(view)

    # The reader thread emits `output` (queued) for each chunk; wait for both.
    with qtbot.waitSignal(session.exited, timeout=5000):
        session.start()

    assert "hello world" in view.toPlainText()
    session.close()


def test_render_output_strips_ansi_and_normalises_newlines():
    raw = "\x1b[32mgreen\x1b[0m\r\nline2\r\n"
    rendered = render_output(raw)
    assert "green" in rendered
    assert "\x1b" not in rendered  # colour codes stripped
    assert "\r" not in rendered  # CRLF normalised to LF
    assert rendered.count("\n") == 2


def test_render_output_applies_backspace():
    assert render_output("abc\b\bZ") == "aZ"


# --------------------------------------------------------------------------- #
# AC1 — resize propagates new (cols, rows) to the pty.
# --------------------------------------------------------------------------- #
def test_resize_propagates_cols_and_rows_to_the_pty(_app):
    spawn = RecordingSpawn()
    session = PtySession(WINDOWS_SHELL, spawn=spawn)
    session.start()
    pty = spawn.ptys[0]

    session.resize(cols=120, rows=40)

    assert pty.winsizes[-1] == (40, 120)  # setwinsize(rows, cols) — AC1 resize
    assert session.size == (120, 40)
    session.close()


def test_view_resize_event_propagates_to_the_pty(_app, qtbot):
    spawn = RecordingSpawn()
    session = PtySession(WSL_SHELL, spawn=spawn)
    view = TerminalView(session)
    qtbot.addWidget(view)
    session.start()
    pty = spawn.ptys[0]

    # Drive the override directly (a hidden offscreen widget won't emit a live
    # resizeEvent) — this is the exact path Qt calls when the pane is resized.
    view.resizeEvent(QResizeEvent(QSize(640, 480), QSize(0, 0)))

    assert pty.winsizes, "a widget resize must propagate a winsize to the pty"
    rows, cols = pty.winsizes[-1]
    assert rows >= 1 and cols >= 1
    session.close()


# --------------------------------------------------------------------------- #
# AC2 — a second session reaches the WSL2 Linux side (wsl.exe).
# --------------------------------------------------------------------------- #
def test_wsl_session_spawns_wsl_exe(_app):
    spawn = RecordingSpawn()
    session = PtySession(WSL_SHELL, spawn=spawn)
    session.start()

    argv, _cols, _rows = spawn.calls[0]
    assert argv[0] == "wsl.exe"
    session.close()


def test_terminal_tab_wires_windows_and_wsl_pages(_app, qtbot):
    spawn = RecordingSpawn()
    tab = TerminalTab(spawn=spawn, autostart=False)
    qtbot.addWidget(tab)

    names = [tab.shell_tabs.tabText(i) for i in range(tab.shell_tabs.count())]
    assert names == ["PowerShell", "WSL (Linux)"]

    # Starting each page spawns exactly its own shell (AC1 + AC2).
    tab.page_for("PowerShell").start()
    tab.page_for("WSL (Linux)").start()
    spawned = [call[0][0] for call in spawn.calls]
    assert "powershell.exe" in spawned
    assert "wsl.exe" in spawned
    tab.close_all()


def test_terminal_tab_autostart_starts_only_the_first_shell(_app, qtbot):
    spawn = RecordingSpawn()
    tab = TerminalTab(spawn=spawn, autostart=True)
    qtbot.addWidget(tab)

    # Autostart spawns just the visible (Windows) shell, not WSL (lazy per-tab).
    assert len(spawn.calls) == 1
    assert spawn.calls[0][0][0] == "powershell.exe"

    # Selecting the WSL sub-tab starts it on demand.
    tab.shell_tabs.setCurrentIndex(1)
    assert any(call[0][0] == "wsl.exe" for call in spawn.calls)
    tab.close_all()


# --------------------------------------------------------------------------- #
# AC3 — no secret / PAT injected; runner.env is never read.
# --------------------------------------------------------------------------- #
def test_default_spawn_injects_no_env(monkeypatch):
    """The real spawn seam passes env=None: nothing (no PAT) is added to the child."""
    captured: dict[str, object] = {}

    class _FakePtyProcess:
        @staticmethod
        def spawn(argv, dimensions=None, env="__unset__"):
            captured["argv"] = argv
            captured["dimensions"] = dimensions
            captured["env"] = env
            return FakePty()

    import sys
    import types

    fake_winpty = types.ModuleType("winpty")
    fake_winpty.PtyProcess = _FakePtyProcess
    monkeypatch.setitem(sys.modules, "winpty", fake_winpty)

    terminal.default_spawn(["powershell.exe"], cols=80, rows=24)

    assert captured["env"] is None  # AC3: no env injected — no PAT set into the child
    assert captured["dimensions"] == (24, 80)  # (rows, cols)


def test_starting_a_session_opens_no_files(_app, monkeypatch):
    """AC3: spawning a session reads no file (so runner.env can't be read)."""
    import builtins

    opened: list[object] = []
    real_open = builtins.open

    def _tracking_open(file, *args, **kwargs):
        opened.append(file)
        return real_open(file, *args, **kwargs)

    monkeypatch.setattr(builtins, "open", _tracking_open)

    spawn = RecordingSpawn()
    session = PtySession(WINDOWS_SHELL, spawn=spawn)
    session.start()
    session.write("echo hi\r")
    session.close()

    assert opened == []  # nothing on disk was read to start the shell


def test_pages_do_not_start_until_asked(_app, qtbot):
    spawn = RecordingSpawn()
    page = TerminalPage(ShellSpec("PowerShell", WINDOWS_SHELL), spawn=spawn)
    qtbot.addWidget(page)

    assert spawn.calls == []  # constructing a page spawns nothing
    page.start()
    assert len(spawn.calls) == 1
    page.start()  # idempotent
    assert len(spawn.calls) == 1
    page.close_session()
