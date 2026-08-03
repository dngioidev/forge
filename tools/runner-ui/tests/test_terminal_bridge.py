"""Tests for the Cockpit v2 PTY-over-websocket terminal bridge (ticket #353, ADR-0008).

These lock the bridge's contract (AC.4) without a real interactive terminal:

* the client-message decoder maps binary/text/JSON frames to typed messages;
* a trivial command spawned through the real PTY layer streams its output back
  (portable: the stdlib ``pty`` on POSIX, ConPTY/pywinpty on Windows — the CI
  ``cockpit-python`` job runs on the Windows runner where pywinpty is present);
* the async pump routes stdin, resize, and PTY output correctly (fake session +
  fake websocket — no real shell);
* an unauthorized websocket upgrade (forged Host / cross Origin / missing/wrong
  token) is rejected, and a genuine loopback+token upgrade is accepted (the shell
  spawn is monkeypatched to a canned session so the test never opens a real shell).

Cross-platform: the Windows-only pywinpty path is guarded so the POSIX legs never
import the native extension, and the POSIX-only stdlib-pty path is guarded off
Windows.
"""

from __future__ import annotations

import asyncio
import sys
import threading
import time

import pytest
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from forge_cockpit import security, server, terminal_bridge
from forge_cockpit.terminal_bridge import (
    DEFAULT_COLS,
    DEFAULT_ROWS,
    InputMessage,
    ResizeMessage,
    parse_client_message,
)

PORT = server.DEFAULT_PORT
LOOPBACK = f"http://127.0.0.1:{PORT}"


# --------------------------------------------------------------------------- #
# AC.1 — client message decoding (pure, no I/O).
# --------------------------------------------------------------------------- #
def test_binary_frame_is_raw_stdin():
    assert parse_client_message(b"ls -la\n") == InputMessage(b"ls -la\n")


def test_plain_text_frame_is_utf8_stdin():
    assert parse_client_message("echo hi\n") == InputMessage(b"echo hi\n")


def test_json_input_message_is_decoded():
    assert parse_client_message('{"type": "input", "data": "pwd\\n"}') == InputMessage(b"pwd\n")


def test_json_resize_message_is_decoded():
    assert parse_client_message('{"type": "resize", "cols": 120, "rows": 40}') == ResizeMessage(
        cols=120, rows=40
    )


def test_resize_with_bad_dimensions_falls_back_to_defaults():
    msg = parse_client_message('{"type": "resize", "cols": 0, "rows": "nope"}')
    assert msg == ResizeMessage(cols=DEFAULT_COLS, rows=DEFAULT_ROWS)


def test_malformed_json_is_treated_as_raw_stdin():
    # A lone '{' is not valid JSON — it must not crash; it is just keystrokes.
    assert parse_client_message("{oops") == InputMessage(b"{oops")


def test_empty_payload_is_ignored():
    assert parse_client_message(None) is None


# --------------------------------------------------------------------------- #
# AC.4 — a trivial command streams its output back through the real PTY layer.
# --------------------------------------------------------------------------- #
def _drain(session, needle: bytes, *, timeout: float = 10.0) -> bytes:
    """Read from a PTY session until ``needle`` appears or ``timeout`` elapses."""
    out = bytearray()
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        chunk = session.read(1024)
        if chunk:
            out.extend(chunk)
            if needle in out:
                break
        elif not session.alive() and needle in out:
            break
    return bytes(out)


@pytest.mark.skipif(sys.platform == "win32", reason="POSIX stdlib pty path")
def test_posix_pty_streams_command_output():
    session = terminal_bridge.spawn_pty(
        ["/bin/sh", "-c", "printf 'BRIDGE_OK\\n'"], cols=80, rows=24
    )
    try:
        assert b"BRIDGE_OK" in _drain(session, b"BRIDGE_OK")
    finally:
        session.close()


@pytest.mark.skipif(sys.platform != "win32", reason="Windows ConPTY/pywinpty path")
def test_windows_pty_streams_command_output():
    session = terminal_bridge.spawn_pty(
        ["cmd.exe", "/c", "echo BRIDGE_OK"], cols=80, rows=24
    )
    try:
        assert b"BRIDGE_OK" in _drain(session, b"BRIDGE_OK")
    finally:
        session.close()


# --------------------------------------------------------------------------- #
# AC.1 — the async pump routes stdin, resize, and PTY output (no real shell).
# --------------------------------------------------------------------------- #
class _FakeSession:
    """A canned PTY: emits ``chunks`` then either EOF or (``stay_alive``) blocks
    until :meth:`close` — modelling a live shell that has no output yet. Records
    writes/resizes/close."""

    def __init__(self, chunks: list[bytes], *, stay_alive: bool = False) -> None:
        self._chunks = list(chunks)
        self._stay_alive = stay_alive
        self.written: list[bytes] = []
        self.resizes: list[tuple[int, int]] = []
        self.closed = False
        self._done = threading.Event()

    def read(self, size: int) -> bytes:
        if self._chunks:
            return self._chunks.pop(0)
        if self._stay_alive:
            self._done.wait()  # a live shell blocks on read until it is closed
        return b""

    def write(self, data: bytes) -> int:
        self.written.append(data)
        return len(data)

    def resize(self, rows: int, cols: int) -> None:
        self.resizes.append((rows, cols))

    def alive(self) -> bool:
        return bool(self._chunks) or (self._stay_alive and not self.closed)

    def close(self) -> None:
        self.closed = True
        self._done.set()


class _FakeWebSocket:
    """A fake websocket feeding scripted client frames then staying open (blocking
    on receive) until the pump cancels it — collecting the bytes sent back."""

    def __init__(self, incoming: list[dict]) -> None:
        self._incoming = list(incoming)
        self.sent: list[bytes] = []

    async def receive(self) -> dict:
        if self._incoming:
            return self._incoming.pop(0)
        # Connection stays open until the pump cancels us (e.g. on PTY EOF).
        await asyncio.Event().wait()
        raise AssertionError("unreachable")  # pragma: no cover

    async def send_bytes(self, data: bytes) -> None:
        self.sent.append(data)


def test_pump_streams_pty_output_to_websocket():
    # PTY emits two chunks then EOF; the client sends nothing (stays connected).
    session = _FakeSession([b"hello ", b"world\n"])
    ws = _FakeWebSocket([])
    asyncio.run(terminal_bridge.bridge_session(ws, session))
    assert b"".join(ws.sent) == b"hello world\n"
    assert session.closed is True


def test_pump_writes_client_input_and_resize_to_pty():
    # A live shell (blocks on read); the client sends a resize then input then
    # disconnects. Assert both were routed to the PTY.
    session = _FakeSession([], stay_alive=True)
    ws = _FakeWebSocket(
        [
            {"type": "websocket.receive", "text": '{"type": "resize", "cols": 100, "rows": 30}'},
            {"type": "websocket.receive", "bytes": b"whoami\n"},
            {"type": "websocket.disconnect"},
        ]
    )
    asyncio.run(terminal_bridge.bridge_session(ws, session))
    assert (30, 100) in session.resizes
    assert b"whoami\n" in session.written
    assert session.closed is True


# --------------------------------------------------------------------------- #
# AC.2 — the websocket upgrade is loopback-guarded + token-gated.
# --------------------------------------------------------------------------- #
#: The loopback Host the browser sends. Starlette's TestClient defaults the ws
#: handshake Host to ``testserver`` regardless of base_url, so every ws test sets
#: it explicitly to model the real browser handshake (a browser sends the literal).
LOOPBACK_HOST = f"127.0.0.1:{PORT}"


@pytest.fixture
def token() -> str:
    return server.app.state.session_token


def _url(tok: str | None) -> str:
    return "/api/terminal" + (f"?token={tok}" if tok is not None else "")


def _headers(*, origin: str | None = LOOPBACK, host: str | None = LOOPBACK_HOST) -> dict:
    headers = {}
    if origin is not None:
        headers["Origin"] = origin
    if host is not None:
        headers["Host"] = host
    return headers


def test_ws_without_token_is_rejected():
    client = TestClient(server.app, base_url=LOOPBACK)
    with pytest.raises(WebSocketDisconnect):
        with client.websocket_connect(_url(None), headers=_headers()):
            pass


def test_ws_with_wrong_token_is_rejected():
    client = TestClient(server.app, base_url=LOOPBACK)
    with pytest.raises(WebSocketDisconnect):
        with client.websocket_connect(_url("not-the-real-token"), headers=_headers()):
            pass


def test_ws_cross_origin_is_rejected(token):
    client = TestClient(server.app, base_url=LOOPBACK)
    with pytest.raises(WebSocketDisconnect):
        with client.websocket_connect(
            _url(token), headers=_headers(origin="http://evil.example")
        ):
            pass


def test_ws_forged_host_is_rejected(token):
    client = TestClient(server.app, base_url=LOOPBACK)
    with pytest.raises(WebSocketDisconnect):
        with client.websocket_connect(
            _url(token), headers=_headers(origin="http://evil.example", host="evil.example")
        ):
            pass


def test_ws_missing_origin_is_rejected(token):
    # Browsers always send Origin on a ws handshake; its absence is treated as a
    # non-browser/cross context and rejected (stricter than the HTTP path).
    client = TestClient(server.app, base_url=LOOPBACK)
    with pytest.raises(WebSocketDisconnect):
        with client.websocket_connect(_url(token), headers=_headers(origin=None)):
            pass


def test_ws_valid_loopback_and_token_is_accepted(token, monkeypatch):
    """The happy path: loopback Host+Origin AND the valid capability token — the
    upgrade is accepted and the (fake) PTY's bytes stream back. The shell spawn is
    monkeypatched so no real shell is opened."""
    monkeypatch.setattr(
        terminal_bridge,
        "spawn_pty",
        lambda argv=None, *, cols=DEFAULT_COLS, rows=DEFAULT_ROWS: _FakeSession([b"READY$ "]),
    )
    client = TestClient(server.app, base_url=LOOPBACK)
    with client.websocket_connect(_url(token), headers=_headers()) as ws:
        assert ws.receive_bytes() == b"READY$ "


# --------------------------------------------------------------------------- #
# AC.2 — unit coverage of the websocket authorization helper.
# --------------------------------------------------------------------------- #
def test_authorize_websocket_accepts_loopback_origin_and_token():
    assert security.authorize_websocket(
        host=f"127.0.0.1:{PORT}",
        origin=LOOPBACK,
        token="secret",
        expected_port=PORT,
        expected_token="secret",
    )


@pytest.mark.parametrize(
    "host,origin,token",
    [
        ("evil.example", LOOPBACK, "secret"),           # forged Host
        (f"127.0.0.1:{PORT}", "http://evil.example", "secret"),  # cross Origin
        (f"127.0.0.1:{PORT}", None, "secret"),          # missing Origin
        (f"127.0.0.1:{PORT}", LOOPBACK, "wrong"),       # wrong token
        (f"127.0.0.1:{PORT}", LOOPBACK, None),          # no token
    ],
)
def test_authorize_websocket_rejects(host, origin, token):
    assert not security.authorize_websocket(
        host=host,
        origin=origin,
        token=token,
        expected_port=PORT,
        expected_token="secret",
    )
