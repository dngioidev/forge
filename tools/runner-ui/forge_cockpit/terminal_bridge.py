"""PTY-over-websocket terminal bridge for Cockpit v2 (ticket #353, ADR-0008).

This is the **backend** half of the Cockpit v2 terminal: a pseudo-terminal (PTY)
whose raw byte stream is pumped bidirectionally over a websocket. It replaces the
hand-rolled ``terminal.py`` that #355 deleted — the one whose home-grown ANSI
stripping and key mapping caused the #275 typing bug.

The fix for #275 is *architectural*, not a patch: this module does **no** terminal
emulation. It streams **raw bytes** in both directions —

* stdin: bytes arriving on the websocket are written straight to the PTY;
* stdout: bytes read from the PTY are sent straight back over the websocket;
* resize: a ``{"type": "resize", "cols": C, "rows": R}`` control message reflows
  the PTY (``TIOCSWINSZ`` on POSIX / ConPTY ``setwinsize`` on Windows).

The xterm.js frontend (#354) owns VT/ANSI emulation and key encoding. There is no
ANSI parser and no key map here on purpose — reintroducing either would be the
#275 mistake.

Cross-platform PTY (AC.1):

* **POSIX** — the standard library ``pty``/``os``/``termios`` (:class:`_PosixPtySession`).
* **Windows** — ConPTY via **pywinpty** (:class:`_WinPtySession`). pywinpty is MIT
  (permissive — clears the license gate) and Windows-only, re-added to the backend
  after #355 removed it with the Qt UI.

Security (ADR-0006 — AC.2): the spawned shell is a *plain* shell. We inject **no**
environment — the child inherits the user's ordinary environment and nothing more
(no PAT, no token, ``runner.env`` is never read or referenced). The websocket
upgrade itself is loopback-guarded + token-gated in
:func:`forge_cockpit.server.create_app` via :func:`forge_cockpit.security.authorize_websocket`
before a shell is ever spawned — opening a shell is a mutating capability.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import os
import sys
from collections.abc import Sequence
from dataclasses import dataclass
from typing import Protocol, runtime_checkable

#: Default PTY geometry until the client's first ``resize`` message (rows, cols).
DEFAULT_ROWS = 24
DEFAULT_COLS = 80

#: Bytes pulled from the PTY per read.
READ_SIZE = 4096


def default_shell() -> tuple[str, ...]:
    """The shell spawned when the client requests no explicit argv.

    Windows → ``powershell.exe`` (``-NoLogo`` just quiets the banner; it injects
    nothing). POSIX → ``$SHELL`` if set, else ``/bin/sh``.
    """
    if sys.platform == "win32":
        return ("powershell.exe", "-NoLogo")
    return (os.environ.get("SHELL") or "/bin/sh",)


# --------------------------------------------------------------------------- #
# Client → server message decoding (pure — no I/O, easily tested).
# --------------------------------------------------------------------------- #
@dataclass(frozen=True)
class InputMessage:
    """Raw stdin bytes to write to the PTY."""

    data: bytes


@dataclass(frozen=True)
class ResizeMessage:
    """A window-resize request — reflow the PTY to ``cols`` x ``rows``."""

    cols: int
    rows: int


def parse_client_message(raw: bytes | str | None) -> InputMessage | ResizeMessage | None:
    """Decode one websocket frame into a typed client message (AC.1).

    The wire protocol is deliberately minimal (xterm.js does the emulation):

    * a **binary** frame is raw stdin → :class:`InputMessage`;
    * a **text** frame that is a JSON object with ``{"type": "resize", "cols", "rows"}``
      is a :class:`ResizeMessage`; ``{"type": "input", "data": "..."}`` is an
      :class:`InputMessage` (``data`` UTF-8 encoded);
    * any other text (including malformed JSON) is treated as raw stdin — so a
      plain-text keystroke stream also works.

    Returns ``None`` for a frame that carries no payload.
    """
    if isinstance(raw, (bytes, bytearray)):
        return InputMessage(bytes(raw))
    if not isinstance(raw, str):
        return None
    stripped = raw.strip()
    if stripped.startswith("{"):
        try:
            obj = json.loads(stripped)
        except json.JSONDecodeError:
            return InputMessage(raw.encode("utf-8"))
        if isinstance(obj, dict):
            kind = obj.get("type")
            if kind == "resize":
                cols = _as_positive_int(obj.get("cols"), DEFAULT_COLS)
                rows = _as_positive_int(obj.get("rows"), DEFAULT_ROWS)
                return ResizeMessage(cols=cols, rows=rows)
            if kind == "input":
                return InputMessage(str(obj.get("data", "")).encode("utf-8"))
        return InputMessage(raw.encode("utf-8"))
    return InputMessage(raw.encode("utf-8"))


def _as_positive_int(value: object, fallback: int) -> int:
    """Coerce ``value`` to a >=1 int, falling back on anything unusable."""
    try:
        result = int(value)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return fallback
    return result if result >= 1 else fallback


# --------------------------------------------------------------------------- #
# The PTY session seam — one small, blocking read/write/resize/close surface,
# implemented per-platform. Injectable so tests never spawn a real shell.
# --------------------------------------------------------------------------- #
@runtime_checkable
class PtySession(Protocol):
    """The slice of a PTY the bridge drives (for typing + test fakes)."""

    def read(self, size: int) -> bytes: ...
    def write(self, data: bytes) -> int: ...
    def resize(self, rows: int, cols: int) -> None: ...
    def alive(self) -> bool: ...
    def close(self) -> None: ...


class _PosixPtySession:
    """A POSIX PTY-backed shell via the standard library ``pty``/``os`` (AC.1).

    ``pty.openpty`` gives a master/slave fd pair; the child runs on the slave in
    its own session (``start_new_session=True`` so it becomes the controlling
    terminal's session leader), and we stream the master. No ``env`` is passed —
    the child inherits the user's ordinary environment and nothing more (AC.2).
    """

    def __init__(self, argv: Sequence[str], cols: int, rows: int) -> None:
        import pty
        import subprocess

        master_fd, slave_fd = pty.openpty()
        self._master_fd = master_fd
        self._closed = False
        self._set_winsize(rows, cols)
        try:
            self._proc = subprocess.Popen(
                list(argv),
                stdin=slave_fd,
                stdout=slave_fd,
                stderr=slave_fd,
                start_new_session=True,
                close_fds=True,
            )
        finally:
            os.close(slave_fd)

    def _set_winsize(self, rows: int, cols: int) -> None:
        import fcntl
        import struct
        import termios

        with contextlib.suppress(OSError):
            fcntl.ioctl(
                self._master_fd,
                termios.TIOCSWINSZ,
                struct.pack("HHHH", rows, cols, 0, 0),
            )

    def read(self, size: int) -> bytes:
        try:
            return os.read(self._master_fd, size)
        except OSError:
            # PTY closed / child exited — surface EOF as an empty read.
            return b""

    def write(self, data: bytes) -> int:
        try:
            return os.write(self._master_fd, data)
        except OSError:
            return 0

    def resize(self, rows: int, cols: int) -> None:
        self._set_winsize(rows, cols)

    def alive(self) -> bool:
        return self._proc.poll() is None

    def close(self) -> None:
        if self._closed:
            return
        self._closed = True
        with contextlib.suppress(ProcessLookupError, OSError):
            self._proc.terminate()
        with contextlib.suppress(OSError):
            os.close(self._master_fd)


class _WinPtySession:
    """A Windows ConPTY-backed shell via pywinpty (AC.1).

    pywinpty's ``PtyProcess`` speaks ``str`` (it UTF-8 decodes the ConPTY output),
    so this adapter encodes/decodes at the boundary to keep the bridge byte-clean.
    No ``env`` is passed — the child inherits the ordinary environment (AC.2).
    """

    def __init__(self, argv: Sequence[str], cols: int, rows: int) -> None:
        from winpty import PtyProcess  # Windows-only native extension (MIT).

        self._pty = PtyProcess.spawn(list(argv), dimensions=(rows, cols))

    def read(self, size: int) -> bytes:
        try:
            data = self._pty.read(size)
        except EOFError:
            return b""
        if not data:
            return b""
        if isinstance(data, str):
            return data.encode("utf-8", errors="replace")
        return data

    def write(self, data: bytes) -> int:
        text = data.decode("utf-8", errors="replace") if isinstance(data, (bytes, bytearray)) else data
        return self._pty.write(text)

    def resize(self, rows: int, cols: int) -> None:
        with contextlib.suppress(Exception):
            self._pty.setwinsize(rows, cols)

    def alive(self) -> bool:
        try:
            return bool(self._pty.isalive())
        except Exception:
            return False

    def close(self) -> None:
        with contextlib.suppress(Exception):
            self._pty.close(force=True)


def spawn_pty(
    argv: Sequence[str] | None = None,
    *,
    cols: int = DEFAULT_COLS,
    rows: int = DEFAULT_ROWS,
) -> PtySession:
    """Spawn a PTY-backed shell for the current platform (AC.1).

    ``argv`` defaults to :func:`default_shell`. Dispatches to the ConPTY
    (pywinpty) session on Windows and the stdlib ``pty`` session on POSIX.
    """
    if argv is None:
        argv = default_shell()
    if sys.platform == "win32":
        return _WinPtySession(argv, cols, rows)
    return _PosixPtySession(argv, cols, rows)


# --------------------------------------------------------------------------- #
# The async pump — two tasks bridging the PTY and the websocket.
# --------------------------------------------------------------------------- #
class WebSocketLike(Protocol):
    """The slice of a Starlette ``WebSocket`` the pump uses (for test fakes)."""

    async def receive(self) -> dict: ...
    async def send_bytes(self, data: bytes) -> None: ...


async def bridge_session(
    websocket: WebSocketLike,
    session: PtySession,
    *,
    read_size: int = READ_SIZE,
) -> None:
    """Pump bytes between an accepted ``websocket`` and a PTY ``session`` (AC.1).

    Runs two concurrent tasks — PTY→ws and ws→PTY — until either side ends (PTY
    EOF or websocket disconnect), then cancels the other and closes the PTY. The
    blocking PTY read/write/resize calls are offloaded to the default executor so
    the event loop is never blocked. No emulation, no key mapping — raw bytes only.
    """
    loop = asyncio.get_running_loop()
    stop = asyncio.Event()

    async def pty_to_ws() -> None:
        try:
            while not stop.is_set():
                data = await loop.run_in_executor(None, session.read, read_size)
                if not data:
                    break
                await websocket.send_bytes(data)
        finally:
            stop.set()

    async def ws_to_pty() -> None:
        try:
            while not stop.is_set():
                message = await websocket.receive()
                if message.get("type") == "websocket.disconnect":
                    break
                raw = message.get("bytes")
                if raw is None:
                    raw = message.get("text")
                if raw is None:
                    continue
                parsed = parse_client_message(raw)
                if isinstance(parsed, ResizeMessage):
                    await loop.run_in_executor(None, session.resize, parsed.rows, parsed.cols)
                elif isinstance(parsed, InputMessage):
                    await loop.run_in_executor(None, session.write, parsed.data)
        finally:
            stop.set()

    reader = asyncio.ensure_future(pty_to_ws())
    writer = asyncio.ensure_future(ws_to_pty())
    try:
        await stop.wait()
    finally:
        for task in (reader, writer):
            task.cancel()
        await asyncio.gather(reader, writer, return_exceptions=True)
        await loop.run_in_executor(None, session.close)


async def serve(
    websocket: WebSocketLike,
    *,
    argv: Sequence[str] | None = None,
    cols: int = DEFAULT_COLS,
    rows: int = DEFAULT_ROWS,
) -> None:
    """Spawn a PTY shell and bridge it over an already-accepted websocket (AC.1).

    The spawn is offloaded to the executor (it touches native APIs). ``spawn_pty``
    is looked up on the module at call time so a test can monkeypatch it to inject
    a fake session instead of launching a real shell.
    """
    loop = asyncio.get_running_loop()
    session = await loop.run_in_executor(None, lambda: spawn_pty(argv, cols=cols, rows=rows))
    await bridge_session(websocket, session)
