"""Tests for the "Usage / cost" QtCharts dashboard tab (ticket #274).

Hermetic + headless: the usage loader is replaced with an in-memory fixture
snapshot (no transcript under ``~/.claude/projects`` is ever read, no pricing is
recomputed — the panel renders the #273 aggregates as-is), and every widget is
built under the offscreen Qt platform (conftest). The suite locks the ACs:

* AC1 — the charts populate from the aggregates: a tokens+cost time series, a
  per-model breakdown, and a today/all-time summary all render.
* AC2 — Refresh re-queries the loader **off the GUI thread** and updates the
  charts without blocking (we assert the worker/signal path + the recorded
  thread, never a direct GUI-thread parse).
* AC3 — the estimate labelling renders, and turns on an unknown/unpriced model
  are surfaced honestly (a visible indicator with the count + model), never
  hidden.
"""

from __future__ import annotations

from threading import get_ident

import pytest

from forge_cockpit.usage import UsageAggregate
from forge_cockpit.usage_view import (
    ESTIMATE_NOTE,
    UsageSnapshot,
    UsageTab,
    default_load_usage,
    grand_totals,
    today_totals,
)


# --------------------------------------------------------------------------- #
# Fixture snapshot — two priced models across two days + one UNPRICED model.
# --------------------------------------------------------------------------- #
TODAY = "2026-07-25"
YESTERDAY = "2026-07-24"


def _agg(
    key: str,
    *,
    turns: int,
    input_tokens: int = 0,
    output_tokens: int = 0,
    cost_input: float = 0.0,
    cost_output: float = 0.0,
    unpriced_turns: int = 0,
    unpriced_models: set[str] | None = None,
) -> UsageAggregate:
    return UsageAggregate(
        key=key,
        turns=turns,
        input_tokens=input_tokens,
        output_tokens=output_tokens,
        cost_input=cost_input,
        cost_output=cost_output,
        unpriced_turns=unpriced_turns,
        unpriced_models=set(unpriced_models or ()),
    )


# by_day: yesterday (priced) + today (priced + one unpriced turn).
DAY_YESTERDAY = _agg(
    YESTERDAY, turns=2, input_tokens=1_000_000, output_tokens=200_000,
    cost_input=5.0, cost_output=5.0,
)
DAY_TODAY = _agg(
    TODAY, turns=3, input_tokens=2_000_000, output_tokens=100_000,
    cost_input=6.0, cost_output=2.5,
    unpriced_turns=1, unpriced_models={"claude-mystery-9"},
)

# by_model: two priced models + one unknown/unpriced model (tokens counted, no cost).
MODEL_OPUS = _agg(
    "claude-opus-4-8", turns=3, input_tokens=2_000_000, output_tokens=250_000,
    cost_input=10.0, cost_output=6.25,
)
MODEL_HAIKU = _agg(
    "claude-haiku-4-5", turns=1, input_tokens=1_000_000, output_tokens=50_000,
    cost_input=1.0, cost_output=1.25,
)
MODEL_UNKNOWN = _agg(
    "claude-mystery-9", turns=1, input_tokens=500_000, output_tokens=0,
    unpriced_turns=1, unpriced_models={"claude-mystery-9"},
)

# by_session: two sessions.
SESSION_A = _agg("sess-a", turns=4, input_tokens=3_000_000)
SESSION_B = _agg("sess-b", turns=1, input_tokens=500_000)

FIXTURE_SNAPSHOT = UsageSnapshot(
    by_day={YESTERDAY: DAY_YESTERDAY, TODAY: DAY_TODAY},
    by_model={
        "claude-opus-4-8": MODEL_OPUS,
        "claude-haiku-4-5": MODEL_HAIKU,
        "claude-mystery-9": MODEL_UNKNOWN,
    },
    by_session={"sess-a": SESSION_A, "sess-b": SESSION_B},
)


class RecordingLoad:
    """A usage-loader stand-in: records call count + the thread it ran on."""

    def __init__(self, snapshot: UsageSnapshot) -> None:
        self.snapshot = snapshot
        self.calls = 0
        self.thread_idents: list[int] = []

    def __call__(self) -> UsageSnapshot:
        self.calls += 1
        self.thread_idents.append(get_ident())
        return self.snapshot


@pytest.fixture
def _app(qapp):
    return qapp


def _make_tab(qtbot, load, **kwargs) -> UsageTab:
    tab = UsageTab(load, initial_refresh=False, today=TODAY, **kwargs)
    qtbot.addWidget(tab)
    return tab


def _load(qtbot, tab) -> None:
    with qtbot.waitSignal(tab.usage_loaded, timeout=5000):
        tab.refresh()


# --------------------------------------------------------------------------- #
# Pure summary math (no widgets) — the totals the panel renders.
# --------------------------------------------------------------------------- #
def test_grand_totals_sum_every_model_bucket():
    totals = grand_totals(FIXTURE_SNAPSHOT)
    # 3 + 1 + 1 turns across the three model buckets.
    assert totals.turns == 5
    assert totals.total_tokens == (
        MODEL_OPUS.total_tokens + MODEL_HAIKU.total_tokens + MODEL_UNKNOWN.total_tokens
    )
    assert totals.total_cost == pytest.approx(
        MODEL_OPUS.total_cost + MODEL_HAIKU.total_cost
    )
    # The unknown model surfaces as unpriced, not hidden (AC3).
    assert totals.has_unpriced is True
    assert totals.unpriced_turns == 1
    assert "claude-mystery-9" in totals.unpriced_models


def test_today_totals_pick_the_today_bucket_only():
    totals = today_totals(FIXTURE_SNAPSHOT, TODAY)
    assert totals.total_tokens == DAY_TODAY.total_tokens
    assert totals.total_cost == pytest.approx(DAY_TODAY.total_cost)
    # A day with no turns yields empty totals, never a crash.
    assert today_totals(FIXTURE_SNAPSHOT, "1999-01-01").total_tokens == 0


# --------------------------------------------------------------------------- #
# AC1 — the charts + summary populate from the aggregates.
# --------------------------------------------------------------------------- #
def test_time_series_chart_populates_from_days(_app, qtbot):
    tab = _make_tab(qtbot, RecordingLoad(FIXTURE_SNAPSHOT))
    _load(qtbot, tab)

    # One point per real calendar day, ascending (unknown-day bucket excluded).
    assert tab.time_series_days() == [YESTERDAY, TODAY]
    assert tab.cost_series.count() == 2
    assert tab.tokens_series.count() == 2
    # Cost line follows the per-day totals.
    assert tab.cost_series.at(0).y() == pytest.approx(DAY_YESTERDAY.total_cost)
    assert tab.cost_series.at(1).y() == pytest.approx(DAY_TODAY.total_cost)
    # Token line follows the per-day token totals.
    assert tab.tokens_series.at(1).y() == pytest.approx(DAY_TODAY.total_tokens)


def test_per_model_breakdown_populates_with_a_bar_per_model(_app, qtbot):
    tab = _make_tab(qtbot, RecordingLoad(FIXTURE_SNAPSHOT))
    _load(qtbot, tab)

    names = tab.model_names()
    assert len(names) == 3  # every model that produced turns, priced or not
    # Sorted tokens-desc: opus (2.25M) > haiku (1.05M) > mystery (0.5M).
    assert names[0].startswith("claude-opus-4-8")
    # The unknown model appears AND is marked unpriced in its label (AC3).
    assert any(n.startswith("claude-mystery-9") and "unpriced" in n for n in names)
    assert tab.model_barset.count() == 3
    assert tab.model_barset.at(0) == pytest.approx(MODEL_OPUS.total_tokens)


def test_summary_shows_today_and_all_time_totals(_app, qtbot):
    tab = _make_tab(qtbot, RecordingLoad(FIXTURE_SNAPSHOT))
    _load(qtbot, tab)

    grand = grand_totals(FIXTURE_SNAPSHOT)
    assert f"{grand.total_tokens:,}" in tab.total_tokens_label.text()
    assert f"{grand.total_cost:,.2f}" in tab.total_cost_label.text()
    assert f"{DAY_TODAY.total_tokens:,}" in tab.today_tokens_label.text()
    assert tab.sessions_label.text() == "2"


# --------------------------------------------------------------------------- #
# AC2 — Refresh re-queries off the GUI thread, non-blocking, and updates.
# --------------------------------------------------------------------------- #
def test_refresh_runs_loader_off_the_gui_thread(_app, qtbot):
    load = RecordingLoad(FIXTURE_SNAPSHOT)
    tab = _make_tab(qtbot, load)
    gui_thread = get_ident()

    _load(qtbot, tab)

    assert load.calls == 1
    # The loader recorded a thread ident that is NOT the GUI thread's (AC2).
    assert load.thread_idents[0] != gui_thread
    assert tab.load_ran_off_gui_thread is True


def test_refresh_requeries_and_updates_charts(_app, qtbot):
    # Start with a single-day, single-model snapshot; then the transcripts "grow".
    small = UsageSnapshot(
        by_day={YESTERDAY: DAY_YESTERDAY},
        by_model={"claude-opus-4-8": MODEL_OPUS},
        by_session={"sess-a": SESSION_A},
    )
    load = RecordingLoad(small)
    tab = _make_tab(qtbot, load)

    _load(qtbot, tab)
    assert tab.time_series_days() == [YESTERDAY]
    assert len(tab.model_names()) == 1

    # New turns land under us; a refresh must re-query the loader and re-render.
    load.snapshot = FIXTURE_SNAPSHOT
    _load(qtbot, tab)

    assert load.calls == 2
    assert tab.time_series_days() == [YESTERDAY, TODAY]
    assert len(tab.model_names()) == 3


def test_refresh_in_flight_is_a_noop(_app, qtbot):
    tab = _make_tab(qtbot, RecordingLoad(FIXTURE_SNAPSHOT))
    tab._busy = True  # simulate a scan already running
    tab.refresh()  # must not start a second worker
    assert tab.snapshot is None  # nothing rendered


def test_refresh_failure_is_surfaced_not_raised(_app, qtbot):
    def boom() -> UsageSnapshot:
        raise RuntimeError("transcript root exploded")

    tab = _make_tab(qtbot, boom)
    with qtbot.waitSignal(tab.refresh_failed, timeout=5000) as sig:
        tab.refresh()

    assert "transcript root exploded" in sig.args[0]
    assert "failed" in tab.status_label.text().lower()
    assert tab.snapshot is None  # nothing rendered, no crash


def test_auto_refresh_interval_wires_a_running_timer(_app, qtbot):
    tab = UsageTab(
        RecordingLoad(FIXTURE_SNAPSHOT),
        auto_refresh_ms=10_000,
        initial_refresh=False,
        today=TODAY,
    )
    qtbot.addWidget(tab)
    assert tab._timer.isActive()
    assert tab._timer.interval() == 10_000


# --------------------------------------------------------------------------- #
# AC3 — estimate labelling + honest unpriced surfacing.
# --------------------------------------------------------------------------- #
def test_estimate_note_is_always_visible(_app, qtbot):
    tab = _make_tab(qtbot, RecordingLoad(FIXTURE_SNAPSHOT))
    _load(qtbot, tab)
    text = tab.estimate_label.text().lower()
    assert tab.estimate_label.text() == ESTIMATE_NOTE
    # It must name the estimate nature and the local-transcripts × rates derivation.
    assert "estimated" in text
    assert "local transcripts" in text
    assert "rates" in text


def test_unpriced_indicator_is_shown_with_count_and_model(_app, qtbot):
    tab = _make_tab(qtbot, RecordingLoad(FIXTURE_SNAPSHOT))
    _load(qtbot, tab)

    assert not tab.unpriced_label.isHidden()
    text = tab.unpriced_label.text()
    assert "1" in text  # the count of unpriced turns
    assert "claude-mystery-9" in text  # the offending unknown model, named


def test_unpriced_indicator_hidden_when_all_priced(_app, qtbot):
    priced_only = UsageSnapshot(
        by_day={TODAY: DAY_TODAY},  # DAY_TODAY carries an unpriced turn...
        by_model={"claude-opus-4-8": MODEL_OPUS, "claude-haiku-4-5": MODEL_HAIKU},
        by_session={"sess-a": SESSION_A},
    )
    # ...but grand totals come from by_model, which here is all-priced -> hidden.
    tab = _make_tab(qtbot, RecordingLoad(priced_only))
    _load(qtbot, tab)

    assert tab.unpriced_label.isHidden()


# --------------------------------------------------------------------------- #
# Empty transcripts — the panel renders cleanly with nothing to show.
# --------------------------------------------------------------------------- #
def test_empty_snapshot_renders_without_crashing(_app, qtbot):
    tab = _make_tab(qtbot, RecordingLoad(UsageSnapshot()))
    _load(qtbot, tab)

    assert tab.time_series_days() == []
    assert tab.model_names() == []
    assert tab.sessions_label.text() == "0"
    assert tab.unpriced_label.isHidden()


# --------------------------------------------------------------------------- #
# The default loader wires to the #273 core (read-only), not a re-implementation.
# --------------------------------------------------------------------------- #
def test_default_loader_returns_a_snapshot_from_a_missing_root(tmp_path):
    # A missing/empty root yields empty aggregates rather than raising — proving the
    # loader delegates to usage.collect_usage (read-only discovery), not a re-parse.
    snapshot = default_load_usage(tmp_path / "nope")
    assert snapshot.by_day == {}
    assert snapshot.by_model == {}
    assert snapshot.by_session == {}
