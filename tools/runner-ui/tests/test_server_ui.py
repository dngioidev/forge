"""Tests for the Cockpit v2 browser UI static serving (ticket #354, ADR-0008).

The browser behaviour (Variant C layout, xterm.js, live wiring, the a11y
contract) is validated by the design-reviewer against the visual spec
(`docs/design/2026-08-03-cockpit-ui.md`). What is unit-testable at the HTTP
boundary — and locked here — is the serving contract (AC.1/AC.2/AC.5):

* ``GET /`` returns the UI shell (200, HTML) with the per-session capability
  token injected in place of the placeholder (never the raw placeholder), and
  the injected token equals ``app.state.session_token``;
* the shell contains the key regions the frontend mounts into — the fleet
  sidebar, the mode bar (tablist), and the terminal mount;
* the CSS / ES-module / vendored xterm.js assets are served from ``/static``
  as JavaScript / CSS;
* the terminal websocket upgrade still rejects a tokenless client (the #352/#353
  guard is unweakened by adding the UI on the same origin).

Every request sets the loopback ``base_url`` so the ``LoopbackGuardMiddleware``
Host check passes — the TestClient otherwise defaults Host to ``testserver``,
which the DNS-rebinding guard (correctly) rejects.
"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from forge_cockpit import server

PORT = server.DEFAULT_PORT
LOOPBACK = f"http://127.0.0.1:{PORT}"


@pytest.fixture
def client() -> TestClient:
    return TestClient(server.app, base_url=LOOPBACK)


# --------------------------------------------------------------------------- #
# AC.1 — the shell is served with the token injected.
# --------------------------------------------------------------------------- #
def test_index_served_with_token_injected(client):
    res = client.get("/")
    assert res.status_code == 200
    assert res.headers["content-type"].startswith("text/html")
    body = res.text
    # The placeholder is gone and the real token is present.
    assert "__FORGE_SESSION_TOKEN__" not in body
    assert server.app.state.session_token in body


def test_index_contains_the_key_regions(client):
    body = client.get("/").text
    # Fleet sidebar, mode bar (tablist), and the terminal mount — the three
    # regions the frontend renders/mounts into (AC.5 smoke assertion).
    assert 'aria-label="Fleet health"' in body
    assert 'role="tablist"' in body
    assert 'id="term-mount"' in body
    # Terminal is the default main view (Variant C).
    assert 'id="tab-term"' in body and 'aria-selected="true"' in body


def test_index_actually_loads_the_vendored_terminal_scripts(client):
    """#395 regression guard: the vendor xterm.js/fit-addon bundles were served
    correctly from /static (see test_static_assets_served below) but index.html
    never had a <script> tag pulling them in — app.mjs's `startTerminal()` found
    `window.Terminal` undefined and bailed before ever opening the websocket, so
    the terminal never worked in the browser. This asserts the actual load path,
    not just that the files are servable."""
    body = client.get("/").text
    assert '/static/vendor/xterm.js"' in body
    assert '/static/vendor/xterm-addon-fit.js"' in body
    # The vendor scripts must appear as plain (non-module) tags BEFORE app.mjs —
    # they're UMD bundles that self-attach to `window`, and app.mjs (a deferred
    # module script) reads `window.Terminal`/`window.FitAddon` at call time.
    xterm_pos = body.index("vendor/xterm.js")
    fit_pos = body.index("vendor/xterm-addon-fit.js")
    app_pos = body.index('src="/static/app.mjs"')
    assert xterm_pos < app_pos and fit_pos < app_pos


# --------------------------------------------------------------------------- #
# AC.1/AC.3 — the static assets (app + vendored xterm.js) are served.
# --------------------------------------------------------------------------- #
@pytest.mark.parametrize(
    "path,ctype",
    [
        ("/static/app.mjs", "javascript"),
        ("/static/format.mjs", "javascript"),
        ("/static/app.css", "css"),
        ("/static/vendor/xterm.js", "javascript"),
        ("/static/vendor/xterm.css", "css"),
        ("/static/vendor/xterm-addon-fit.js", "javascript"),
    ],
)
def test_static_assets_served(client, path, ctype):
    res = client.get(path)
    assert res.status_code == 200, path
    assert ctype in res.headers["content-type"], (path, res.headers["content-type"])
    assert res.content, path


def test_vendored_xterm_is_the_real_umd_build(client):
    # Guards against a truncated / wrong vendored asset — the UMD build defines
    # the AMD branch and is non-trivial in size.
    body = client.get("/static/vendor/xterm.js").text
    assert "define.amd" in body
    assert len(body) > 100_000


# --------------------------------------------------------------------------- #
# AC.2 — adding the UI did not weaken the ws token gate.
# --------------------------------------------------------------------------- #
def test_terminal_ws_still_rejects_tokenless_upgrade(client):
    headers = {"Origin": LOOPBACK, "Host": f"127.0.0.1:{PORT}"}
    with pytest.raises(WebSocketDisconnect):
        with client.websocket_connect("/api/terminal", headers=headers):
            pass
