"""The "Terminal" tab — a real embedded terminal via pywinpty/ConPTY (ticket #275).

This is the Wave-3 panel that lands the last piece of the ADR-0006 cockpit: an
actual interactive terminal embedded in the window, backed by a **ConPTY**
pseudo-terminal (pywinpty's :class:`winpty.PtyProcess`). It runs a *real* shell —
keystrokes are written to the pty and the pty's output is rendered back — not a
faked transcript.

Two sessions are offered so BOTH runner OS contexts are reachable from one window
(AC1 + AC2):

* **PowerShell** — a native Windows shell (ConPTY), for the Windows runner side;
* **WSL (Linux)** — ``wsl.exe``, dropping into the WSL2 Linux side.

Threading: a pty ``read`` blocks, so each session runs a daemon **reader thread**
that pulls bytes off the pty and marshals them to the GUI thread via a queued Qt
signal (:pydata:`PtySession.output`). The GUI thread never blocks on I/O. Widget
resizes are translated to pty ``setwinsize(rows, cols)`` so the shell reflows.

Security (AC3): this is a PLAIN interactive shell. It pre-types nothing, injects
no environment (``env=None`` — the child simply inherits the user's normal
environment; no PAT is added), and it NEVER reads ``~/.forge/runner.env`` or any
secret store. There is no auto-run command and no echoed token — the module has no
notion of a PAT at all. A full VT100 emulator is out of scope; output is rendered
pragmatically (ANSI control sequences stripped, newlines normalised) into a
monospaced view, which is enough for an interactive session.

A note on portability: :mod:`winpty` is Windows-only and imported LAZILY inside
:func:`default_spawn`, so importing this module (and mocking the pty in tests)
never requires the native extension. The ``cockpit-python`` CI job runs on Windows
and mocks the pty; it never spawns a real shell.
"""

from __future__ import annotations

import re
import threading
from collections.abc import Sequence
from dataclasses import dataclass
from typing import Protocol, runtime_checkable

from PySide6.QtCore import QObject, Qt, Signal
from PySide6.QtGui import QFont, QFontDatabase, QFontMetrics, QKeyEvent
from PySide6.QtWidgets import (
    QLabel,
    QPlainTextEdit,
    QTabWidget,
    QVBoxLayout,
    QWidget,
)

# --------------------------------------------------------------------------- #
# Shells (AC1 Windows shell, AC2 WSL Linux shell).
# --------------------------------------------------------------------------- #

#: The Windows shell session (AC1). ``-NoLogo`` keeps the banner quiet; it is NOT
#: a secret and injects nothing — just a cleaner prompt.
WINDOWS_SHELL: tuple[str, ...] = ("powershell.exe", "-NoLogo")

#: The WSL2 Linux shell session (AC2) — drops straight into the default distro.
WSL_SHELL: tuple[str, ...] = ("wsl.exe",)

#: Default pty geometry until the widget's first real resize (rows, cols).
DEFAULT_ROWS = 24
DEFAULT_COLS = 80

#: How many bytes a reader pulls per ``read`` call.
READ_SIZE = 4096

#: Cap on the rendered scrollback so a chatty shell can't grow the view unbounded.
MAX_SCROLLBACK_BLOCKS = 10_000


@dataclass(frozen=True)
class ShellSpec:
    """One selectable shell: a display name + the argv to spawn for it."""

    name: str
    argv: tuple[str, ...]


#: The shells offered in the Terminal tab, in display order: the Windows shell
#: (AC1) first, then the WSL Linux shell (AC2).
DEFAULT_SHELLS: tuple[ShellSpec, ...] = (
    ShellSpec("PowerShell", WINDOWS_SHELL),
    ShellSpec("WSL (Linux)", WSL_SHELL),
)


# --------------------------------------------------------------------------- #
# The pty spawn seam.
# --------------------------------------------------------------------------- #


@runtime_checkable
class PtyLike(Protocol):
    """The slice of :class:`winpty.PtyProcess` this module drives (for typing/mocks)."""

    def read(self, size: int) -> str | bytes: ...
    def write(self, data: str) -> int: ...
    def setwinsize(self, rows: int, cols: int) -> None: ...
    def isalive(self) -> bool: ...
    def close(self, force: bool = ...) -> None: ...


class Spawn(Protocol):
    """The seam a session spawns through: ``(argv, cols, rows) -> PtyLike``.

    Injectable so tests supply a fake pty and NEVER launch a real shell in CI.
    """

    def __call__(self, argv: Sequence[str], cols: int, rows: int) -> PtyLike: ...


def default_spawn(argv: Sequence[str], cols: int, rows: int) -> PtyLike:
    """Spawn a real ConPTY shell via pywinpty (the production seam).

    ``winpty`` is imported here, lazily, because it is a Windows-only native
    extension — importing this module stays portable and unit-testable.

    AC3: ``env=None`` means the child inherits the user's ordinary environment; we
    add NOTHING — no PAT, no token, no ``runner.env`` — this is a plain shell.
    """
    from winpty import PtyProcess  # lazy, Windows-only native extension

    return PtyProcess.spawn(list(argv), dimensions=(rows, cols), env=None)


# --------------------------------------------------------------------------- #
# Output rendering — pragmatic, not a full VT100 emulator.
# --------------------------------------------------------------------------- #

#: ANSI CSI / SGR sequences (colours, cursor moves, erases). Stripped for display.
_CSI_RE = re.compile(r"\x1b\[[0-9;?]*[ -/]*[@-~]")
#: OSC sequences (e.g. window-title sets), terminated by BEL or ST.
_OSC_RE = re.compile(r"\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)")
#: Remaining lone escapes (single-char / charset selects) we don't interpret.
_OTHER_ESC_RE = re.compile(r"\x1b[()#][0-9A-Za-z]|\x1b[=>]")


def render_output(text: str) -> str:
    """Reduce raw pty bytes to displayable text (pragmatic ANSI handling, AC1).

    Strips ANSI CSI/OSC control sequences, normalises CRLF/CR to LF, applies
    backspaces, and drops the remaining C0 control bytes except tab/newline. This
    is deliberately NOT a full terminal emulator — it is enough to read an
    interactive session in a monospaced pane.
    """
    text = _OSC_RE.sub("", text)
    text = _CSI_RE.sub("", text)
    text = _OTHER_ESC_RE.sub("", text)
    text = text.replace("\r\n", "\n").replace("\r", "\n")

    # Apply backspaces so line edits / prompts read sensibly.
    out: list[str] = []
    for ch in text:
        if ch == "\b" or ch == "\x7f":
            if out and out[-1] != "\n":
                out.pop()
            continue
        if ch == "\t" or ch == "\n":
            out.append(ch)
            continue
        if ord(ch) < 0x20:  # other C0 controls (BEL, etc.) — not rendered
            continue
        out.append(ch)
    return "".join(out)


# --------------------------------------------------------------------------- #
# Keystroke -> pty bytes.
# --------------------------------------------------------------------------- #

#: Special keys that don't map to a printable ``text()`` — sent as their terminal
#: control sequences so the shell sees Enter, arrows, etc.
_KEY_SEQUENCES: dict[int, str] = {
    Qt.Key.Key_Return: "\r",
    Qt.Key.Key_Enter: "\r",
    Qt.Key.Key_Backspace: "\x7f",
    Qt.Key.Key_Tab: "\t",
    Qt.Key.Key_Escape: "\x1b",
    Qt.Key.Key_Up: "\x1b[A",
    Qt.Key.Key_Down: "\x1b[B",
    Qt.Key.Key_Right: "\x1b[C",
    Qt.Key.Key_Left: "\x1b[D",
    Qt.Key.Key_Home: "\x1b[H",
    Qt.Key.Key_End: "\x1b[F",
    Qt.Key.Key_Delete: "\x1b[3~",
    Qt.Key.Key_PageUp: "\x1b[5~",
    Qt.Key.Key_PageDown: "\x1b[6~",
}


def key_to_bytes(event: QKeyEvent) -> str:
    """Translate a Qt key event to the string to write to the pty (AC1 input).

    Printable keys forward their ``text()`` (which already carries Ctrl-combos such
    as Ctrl+C -> ``\\x03``); the named editing/navigation keys map to their control
    sequences. Returns ``""`` for a keypress with nothing to send (bare modifiers).
    """
    seq = _KEY_SEQUENCES.get(Qt.Key(event.key()))
    if seq is not None:
        return seq
    return event.text()


# --------------------------------------------------------------------------- #
# The pty session — pty process + reader thread, off the GUI thread.
# --------------------------------------------------------------------------- #


class PtySession(QObject):
    """A ConPTY-backed shell session: a pty process + a reader thread (AC1).

    The reader thread blocks on ``pty.read`` and emits :pydata:`output` for every
    chunk; Qt delivers it to the GUI thread via a queued connection, so decoding
    and rendering never block on I/O. :meth:`write` forwards keystrokes, and
    :meth:`resize` propagates the new geometry to the pty.

    :param argv: the shell command to spawn.
    :param spawn: the pty spawn seam (default :func:`default_spawn`; a fake in tests).
    :param cols/rows: initial pty geometry.
    """

    #: Emitted (queued, on the GUI thread) with each decoded chunk of pty output.
    output = Signal(str)
    #: Emitted (queued) once the shell has exited / the pty closed.
    exited = Signal()

    def __init__(
        self,
        argv: Sequence[str],
        *,
        spawn: Spawn = default_spawn,
        cols: int = DEFAULT_COLS,
        rows: int = DEFAULT_ROWS,
        read_size: int = READ_SIZE,
        parent: QObject | None = None,
    ) -> None:
        super().__init__(parent)
        self._argv = tuple(argv)
        self._spawn = spawn
        self._cols = max(1, cols)
        self._rows = max(1, rows)
        self._read_size = read_size
        self._pty: PtyLike | None = None
        self._reader: threading.Thread | None = None
        self._stop = threading.Event()

    @property
    def argv(self) -> tuple[str, ...]:
        return self._argv

    @property
    def started(self) -> bool:
        return self._pty is not None

    def start(self) -> None:
        """Spawn the shell and launch the reader thread. Idempotent."""
        if self._pty is not None:
            return
        self._pty = self._spawn(self._argv, self._cols, self._rows)
        self._reader = threading.Thread(
            target=self._read_loop, name=f"pty-reader:{self._argv[0]}", daemon=True
        )
        self._reader.start()

    def _read_loop(self) -> None:  # pragma: no cover - exercised via the reader thread
        pty = self._pty
        assert pty is not None
        while not self._stop.is_set():
            try:
                data = pty.read(self._read_size)
            except EOFError:
                break
            except Exception:
                break
            if not data:
                break
            text = data if isinstance(data, str) else data.decode("utf-8", "replace")
            self.output.emit(text)
        self.exited.emit()

    def write(self, data: str) -> None:
        """Forward a keystroke / paste to the pty (AC1 input). No-op before start."""
        if not data or self._pty is None:
            return
        try:
            self._pty.write(data)
        except Exception:
            pass  # a write after the shell exits must not crash the GUI

    def resize(self, cols: int, rows: int) -> None:
        """Propagate a new geometry to the pty so the shell reflows (AC1 resize)."""
        self._cols = cols = max(1, cols)
        self._rows = rows = max(1, rows)
        if self._pty is None:
            return
        try:
            self._pty.setwinsize(rows, cols)
        except Exception:
            pass

    @property
    def size(self) -> tuple[int, int]:
        """Current ``(cols, rows)`` geometry."""
        return (self._cols, self._rows)

    def close(self) -> None:
        """Stop the reader and terminate the shell. Safe to call repeatedly."""
        self._stop.set()
        if self._pty is not None:
            try:
                self._pty.close(force=True)
            except Exception:
                pass
            self._pty = None


# --------------------------------------------------------------------------- #
# The terminal view — a monospaced pane that renders output + captures keys.
# --------------------------------------------------------------------------- #


class TerminalView(QPlainTextEdit):
    """A monospaced pane wired to one :class:`PtySession` (render out, capture in).

    Output arrives via the session's queued :pydata:`PtySession.output` signal and
    is appended (AC1 render). Keystrokes are captured in :meth:`keyPressEvent` and
    written to the pty rather than edited locally — the shell echoes them back
    (AC1 input). A resize recomputes the character grid and tells the pty (AC1
    resize).
    """

    def __init__(self, session: PtySession, parent: QWidget | None = None) -> None:
        super().__init__(parent)
        self._session = session
        self.setReadOnly(False)
        self.setUndoRedoEnabled(False)
        self.setLineWrapMode(QPlainTextEdit.LineWrapMode.NoWrap)
        self.setMaximumBlockCount(MAX_SCROLLBACK_BLOCKS)
        self.setCursorWidth(8)

        font = QFontDatabase.systemFont(QFontDatabase.SystemFont.FixedFont)
        font.setStyleHint(QFont.StyleHint.Monospace)
        self.setFont(font)

        session.output.connect(self._append_output)

    def _append_output(self, text: str) -> None:
        self.moveCursor(self.textCursor().MoveOperation.End)
        self.insertPlainText(render_output(text))
        self.moveCursor(self.textCursor().MoveOperation.End)
        bar = self.verticalScrollBar()
        bar.setValue(bar.maximum())

    # -- input (AC1) ------------------------------------------------------- #
    def keyPressEvent(self, event: QKeyEvent) -> None:  # noqa: N802 - Qt override
        data = key_to_bytes(event)
        if data:
            self._session.write(data)
            event.accept()
            return
        # Bare modifier presses (no text) — swallow so nothing is edited locally.
        event.accept()

    # -- geometry (AC1) ---------------------------------------------------- #
    def grid_size(self) -> tuple[int, int]:
        """The current ``(cols, rows)`` the pane can show, from font metrics."""
        fm = QFontMetrics(self.font())
        char_w = fm.horizontalAdvance("M") or 1
        line_h = fm.lineSpacing() or 1
        vp = self.viewport()
        cols = max(1, vp.width() // char_w)
        rows = max(1, vp.height() // line_h)
        return (cols, rows)

    def resizeEvent(self, event) -> None:  # noqa: N802 - Qt override
        super().resizeEvent(event)
        cols, rows = self.grid_size()
        self._session.resize(cols, rows)


# --------------------------------------------------------------------------- #
# The tab — a sub-tab per shell (PowerShell + WSL).
# --------------------------------------------------------------------------- #


class TerminalPage(QWidget):
    """One shell's page: its :class:`PtySession` + :class:`TerminalView`.

    The session is spawned lazily via :meth:`start` (idempotent), so opening the
    cockpit doesn't launch every shell at once — a page starts when it is first
    shown.
    """

    def __init__(
        self,
        shell: ShellSpec,
        *,
        spawn: Spawn = default_spawn,
        parent: QWidget | None = None,
    ) -> None:
        super().__init__(parent)
        self.shell = shell
        self.session = PtySession(shell.argv, spawn=spawn, parent=self)
        self.view = TerminalView(self.session)

        layout = QVBoxLayout(self)
        layout.setContentsMargins(0, 0, 0, 0)
        layout.addWidget(self.view)
        self.session.exited.connect(self._on_exited)

    def start(self) -> None:
        """Spawn the shell if it hasn't started yet, sized to the current view."""
        if self.session.started:
            return
        cols, rows = self.view.grid_size()
        self.session.resize(cols, rows)
        self.session.start()

    def _on_exited(self) -> None:
        self.view.appendPlainText("\n[process exited]")

    def close_session(self) -> None:
        self.session.close()


class TerminalTab(QWidget):
    """The "Terminal" cockpit tab: a sub-tab per shell (AC1 Windows + AC2 WSL).

    :param shells: the shells to offer (default :data:`DEFAULT_SHELLS`).
    :param spawn: the pty spawn seam (default :func:`default_spawn`; a fake in tests
        so CI never launches a real shell).
    :param autostart: spawn the visible shell on construction and start each other
        shell when its sub-tab is first selected (default True). Tests pass False to
        stay fully hermetic and drive :meth:`TerminalPage.start` explicitly.
    """

    def __init__(
        self,
        *,
        shells: Sequence[ShellSpec] = DEFAULT_SHELLS,
        spawn: Spawn = default_spawn,
        autostart: bool = True,
        parent: QWidget | None = None,
    ) -> None:
        super().__init__(parent)
        self._autostart = autostart
        self.pages: list[TerminalPage] = []

        layout = QVBoxLayout(self)
        note = QLabel(
            "Plain interactive shells (ConPTY / WSL). No secrets are injected — "
            "your PAT and runner.env are never read or echoed here."
        )
        note.setWordWrap(True)
        layout.addWidget(note)

        self.shell_tabs = QTabWidget()
        for shell in shells:
            page = TerminalPage(shell, spawn=spawn)
            self.pages.append(page)
            self.shell_tabs.addTab(page, shell.name)
        layout.addWidget(self.shell_tabs, 1)

        self.shell_tabs.currentChanged.connect(self._on_current_changed)
        if autostart and self.pages:
            self.pages[0].start()

    def _on_current_changed(self, index: int) -> None:
        if not self._autostart or not (0 <= index < len(self.pages)):
            return
        self.pages[index].start()

    def page_for(self, name: str) -> TerminalPage | None:
        """The page whose shell has this display name (or None)."""
        for page in self.pages:
            if page.shell.name == name:
                return page
        return None

    def close_all(self) -> None:
        for page in self.pages:
            page.close_session()

    def closeEvent(self, event) -> None:  # noqa: N802 - Qt override
        self.close_all()
        super().closeEvent(event)
