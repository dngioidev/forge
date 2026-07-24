"""The "Usage / cost" tab — a QtCharts dashboard over the #273 usage core (ticket #274).

This is the read-only usage view. It renders the already-normalized, content-free
aggregates from :mod:`forge_cockpit.usage` (ticket #273) — it never re-parses a
transcript, never re-implements pricing, and never touches message CONTENT. The
panel shows:

* a **time series** of tokens + estimated cost per day (QtCharts line chart) — AC1;
* a **per-model breakdown** of tokens (QtCharts bar chart), including any
  unknown/unpriced model so nothing is hidden — AC1;
* a **today / session summary** with token + estimated-cost totals — AC1/AC3.

Every cost figure is CLEARLY LABELLED as an estimate derived from local transcripts
× published rates, and a visible indicator counts any ``unpriced`` (unknown-model)
turns so the totals stay honest (AC3).

Threading (AC2): discovering + parsing ``~/.claude/projects/**/*.jsonl`` and
aggregating it is slow (the ~40k-turn scan), so it runs in a :class:`QRunnable` on
the global :class:`QThreadPool` and marshals the result back to the GUI thread via
a queued signal — reusing the #265 worker pattern. The GUI thread never calls the
loader directly, so the window stays responsive during a scan. A Refresh button
re-queries on demand; an optional interval :class:`QTimer` re-queries as new
transcript turns are written.
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import date, datetime, timezone
from threading import get_ident

from PySide6.QtCharts import (
    QBarCategoryAxis,
    QBarSeries,
    QBarSet,
    QChart,
    QChartView,
    QLineSeries,
    QValueAxis,
)
from PySide6.QtCore import QObject, QRunnable, Qt, QThreadPool, QTimer, Signal
from PySide6.QtGui import QPainter
from PySide6.QtWidgets import (
    QGridLayout,
    QGroupBox,
    QHBoxLayout,
    QLabel,
    QPushButton,
    QVBoxLayout,
    QWidget,
)

from forge_cockpit import usage
from forge_cockpit.usage import UNKNOWN_DAY, UsageAggregate

#: Auto-refresh interval in the running app (AC2). Off (0) in tests for determinism.
USAGE_REFRESH_MS = 30_000

#: The AC3 estimate disclaimer — cost is never authoritative; it is derived locally.
ESTIMATE_NOTE = (
    "Estimated — costs are derived from local transcripts × published list rates, "
    "not billed figures."
)


@dataclass(frozen=True)
class UsageSnapshot:
    """One immutable set of usage aggregates, partitioned three ways (#273).

    Each dict is a full partition of the same per-turn records, so any of them
    sums to the same grand total. Carries usage metadata ONLY — no message content.
    """

    by_day: dict[str, UsageAggregate] = field(default_factory=dict)
    by_model: dict[str, UsageAggregate] = field(default_factory=dict)
    by_session: dict[str, UsageAggregate] = field(default_factory=dict)


#: The loader seam the tab drives: () -> UsageSnapshot. Injectable so tests can
#: supply fixture aggregates without parsing any transcript (AC2 hermetic).
LoadUsage = Callable[[], UsageSnapshot]


def default_load_usage(root: object | None = None) -> UsageSnapshot:
    """Discover + parse every transcript and aggregate it three ways (the real
    loader). Read-only end to end; delegates entirely to :mod:`forge_cockpit.usage`
    — no re-parsing or re-pricing here."""

    records = usage.collect_usage(root)
    return UsageSnapshot(
        by_day=usage.aggregate_by_day(records),
        by_model=usage.aggregate_by_model(records),
        by_session=usage.aggregate_by_session(records),
    )


# --------------------------------------------------------------------------- #
# Summary math — pure functions over a snapshot (usage metadata only).
# --------------------------------------------------------------------------- #


@dataclass(frozen=True)
class UsageTotals:
    """Rolled-up token + estimated-cost totals for a set of buckets."""

    turns: int = 0
    total_tokens: int = 0
    total_cost: float = 0.0
    unpriced_turns: int = 0
    unpriced_models: frozenset[str] = frozenset()

    @property
    def has_unpriced(self) -> bool:
        return self.unpriced_turns > 0


def _sum_totals(buckets: object) -> UsageTotals:
    """Roll an iterable of :class:`UsageAggregate` up into one :class:`UsageTotals`."""
    turns = tokens = unpriced = 0
    cost = 0.0
    models: set[str] = set()
    for agg in buckets:
        turns += agg.turns
        tokens += agg.total_tokens
        cost += agg.total_cost
        unpriced += agg.unpriced_turns
        models |= agg.unpriced_models
    return UsageTotals(
        turns=turns,
        total_tokens=tokens,
        total_cost=cost,
        unpriced_turns=unpriced,
        unpriced_models=frozenset(models),
    )


def grand_totals(snapshot: UsageSnapshot) -> UsageTotals:
    """All-time totals across every model bucket (a full partition of the turns)."""
    return _sum_totals(snapshot.by_model.values())


def today_totals(snapshot: UsageSnapshot, today: str) -> UsageTotals:
    """Totals for the single ``today`` day bucket (empty if that day has no turns)."""
    agg = snapshot.by_day.get(today)
    return _sum_totals([agg] if agg is not None else [])


def sorted_day_keys(snapshot: UsageSnapshot) -> list[str]:
    """Real calendar-day keys, ascending. The :data:`UNKNOWN_DAY` bucket (turns
    without a parseable timestamp) is excluded from the time axis but still counts
    toward the grand totals."""
    return sorted(k for k in snapshot.by_day if k != UNKNOWN_DAY)


def _fmt_tokens(n: int) -> str:
    return f"{n:,}"


def _fmt_cost(usd: float) -> str:
    return f"${usd:,.2f}"


# --------------------------------------------------------------------------- #
# Off-GUI-thread worker (AC2) — reuses the #265 pattern.
# --------------------------------------------------------------------------- #


class _WorkerSignals(QObject):
    finished = Signal(object)  # UsageSnapshot
    failed = Signal(str)


class _UsageWorker(QRunnable):
    """Runs the usage loader off the GUI thread (AC2).

    ``load`` — the slow discover→parse→aggregate — is called on a thread-pool
    thread; its result (a :class:`UsageSnapshot`) or the string of any exception is
    emitted via :class:`_WorkerSignals`, which Qt delivers to the connected slots on
    the GUI thread via a queued connection. The GUI thread never blocks on the scan.
    """

    def __init__(self, load: LoadUsage) -> None:
        super().__init__()
        self._load = load
        self.signals = _WorkerSignals()

    def run(self) -> None:  # pragma: no cover - exercised via the thread pool
        try:
            snapshot = self._load()
        except Exception as exc:  # never let a scan crash the worker thread
            self.signals.failed.emit(f"{type(exc).__name__}: {exc}")
            return
        self.signals.finished.emit(snapshot)


# --------------------------------------------------------------------------- #
# The tab.
# --------------------------------------------------------------------------- #


def _today_iso() -> str:
    return datetime.now(timezone.utc).date().isoformat()


class UsageTab(QWidget):
    """The "Usage / cost" tab: QtCharts dashboard over the #273 usage aggregates.

    :param load: the usage loader (default :func:`default_load_usage`; overridden
        with a fixture in tests). Runs off the GUI thread on refresh.
    :param auto_refresh_ms: if > 0, re-query on this interval (AC2). Default 0 (off)
        so tests are deterministic; the app enables it.
    :param pool: the :class:`QThreadPool` to run the loader on (default the global
        pool); injectable for tests.
    :param initial_refresh: kick a first refresh on construction (default True so the
        tab self-populates in the app; tests pass False to drive it explicitly).
    :param today: the day key treated as "today" for the summary (default the current
        UTC date); injectable so the summary is deterministic in tests.
    """

    #: Emitted on the GUI thread after a successful refresh has updated the charts.
    usage_loaded = Signal()
    #: Emitted on the GUI thread when a refresh failed (carries the error string).
    refresh_failed = Signal(str)

    def __init__(
        self,
        load: LoadUsage = default_load_usage,
        *,
        auto_refresh_ms: int = 0,
        pool: QThreadPool | None = None,
        initial_refresh: bool = True,
        today: str | None = None,
        parent: QWidget | None = None,
    ) -> None:
        super().__init__(parent)
        self._load = load
        self._pool = pool or QThreadPool.globalInstance()
        self._today = today or _today_iso()
        self._busy = False
        #: The most recent snapshot rendered (None until the first refresh lands).
        self._snapshot: UsageSnapshot | None = None
        #: Thread ident of the last loader call — proves it ran off the GUI thread
        #: (AC2). ``None`` until the first refresh runs.
        self.last_load_thread_ident: int | None = None
        self._gui_thread_ident = get_ident()

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

        # Top bar: Refresh + status + the standing estimate disclaimer (AC3).
        bar = QHBoxLayout()
        self.refresh_button = QPushButton("Refresh")
        self.refresh_button.setToolTip("Re-scan local transcripts and re-aggregate now")
        self.refresh_button.clicked.connect(self.refresh)
        self.status_label = QLabel("")
        bar.addWidget(self.refresh_button)
        bar.addWidget(self.status_label)
        bar.addStretch(1)
        self.estimate_label = QLabel(ESTIMATE_NOTE)
        self.estimate_label.setWordWrap(True)
        self.estimate_label.setToolTip(
            "Token counts come from your local Claude Code transcripts; costs multiply "
            "them by pinned published list rates. Figures are estimates, not invoices."
        )
        bar.addWidget(self.estimate_label)
        layout.addLayout(bar)

        # Summary row: today / all-time totals + the unpriced honesty indicator (AC3).
        layout.addWidget(self._build_summary())

        # Charts: time series (tokens + cost over time) and per-model breakdown (AC1).
        charts = QHBoxLayout()
        charts.addWidget(self._build_time_chart(), 2)
        charts.addWidget(self._build_model_chart(), 1)
        layout.addLayout(charts, 1)

    def _build_summary(self) -> QGroupBox:
        box = QGroupBox("Summary")
        grid = QGridLayout(box)
        grid.addWidget(QLabel("Today"), 0, 0)
        self.today_tokens_label = QLabel("—")
        self.today_cost_label = QLabel("—")
        grid.addWidget(self.today_tokens_label, 0, 1)
        grid.addWidget(self.today_cost_label, 0, 2)

        grid.addWidget(QLabel("All-time"), 1, 0)
        self.total_tokens_label = QLabel("—")
        self.total_cost_label = QLabel("—")
        grid.addWidget(self.total_tokens_label, 1, 1)
        grid.addWidget(self.total_cost_label, 1, 2)

        grid.addWidget(QLabel("Sessions"), 2, 0)
        self.sessions_label = QLabel("—")
        grid.addWidget(self.sessions_label, 2, 1)

        # The unpriced indicator: hidden when everything is priced, visible + explicit
        # when some turns used an unknown model (AC3 — never hide unpriced turns).
        self.unpriced_label = QLabel("")
        self.unpriced_label.setWordWrap(True)
        self.unpriced_label.setToolTip(
            "Turns whose model is not in the pinned pricing table. Their tokens ARE "
            "counted; their cost is not estimated, so totals understate spend."
        )
        self.unpriced_label.setVisible(False)
        grid.addWidget(self.unpriced_label, 3, 0, 1, 3)
        return box

    def _build_time_chart(self) -> QChartView:
        self.time_chart = QChart()
        self.time_chart.setTitle("Tokens & estimated cost over time")

        self.cost_series = QLineSeries()
        self.cost_series.setName("Est. cost (USD)")
        self.tokens_series = QLineSeries()
        self.tokens_series.setName("Tokens")
        self.time_chart.addSeries(self.cost_series)
        self.time_chart.addSeries(self.tokens_series)

        self.time_axis_x = QBarCategoryAxis()
        self.time_axis_cost = QValueAxis()
        self.time_axis_cost.setTitleText("Est. cost (USD)")
        self.time_axis_tokens = QValueAxis()
        self.time_axis_tokens.setTitleText("Tokens")

        self.time_chart.addAxis(self.time_axis_x, Qt.AlignmentFlag.AlignBottom)
        self.time_chart.addAxis(self.time_axis_cost, Qt.AlignmentFlag.AlignLeft)
        self.time_chart.addAxis(self.time_axis_tokens, Qt.AlignmentFlag.AlignRight)
        self.cost_series.attachAxis(self.time_axis_x)
        self.cost_series.attachAxis(self.time_axis_cost)
        self.tokens_series.attachAxis(self.time_axis_x)
        self.tokens_series.attachAxis(self.time_axis_tokens)

        view = QChartView(self.time_chart)
        view.setRenderHint(QPainter.RenderHint.Antialiasing)
        return view

    def _build_model_chart(self) -> QChartView:
        self.model_chart = QChart()
        self.model_chart.setTitle("Tokens by model")

        self.model_barset = QBarSet("Tokens")
        self.model_series = QBarSeries()
        self.model_series.append(self.model_barset)
        self.model_chart.addSeries(self.model_series)

        self.model_axis_x = QBarCategoryAxis()
        self.model_axis_y = QValueAxis()
        self.model_axis_y.setTitleText("Tokens")
        self.model_chart.addAxis(self.model_axis_x, Qt.AlignmentFlag.AlignBottom)
        self.model_chart.addAxis(self.model_axis_y, Qt.AlignmentFlag.AlignLeft)
        self.model_series.attachAxis(self.model_axis_x)
        self.model_series.attachAxis(self.model_axis_y)

        view = QChartView(self.model_chart)
        view.setRenderHint(QPainter.RenderHint.Antialiasing)
        return view

    # -- accessors (for tests / callers) ---------------------------------- #
    @property
    def snapshot(self) -> UsageSnapshot | None:
        """The most recent rendered snapshot (None before the first refresh)."""
        return self._snapshot

    @property
    def load_ran_off_gui_thread(self) -> bool:
        """True once a load has run and it ran off the GUI thread (AC2)."""
        return (
            self.last_load_thread_ident is not None
            and self.last_load_thread_ident != self._gui_thread_ident
        )

    def time_series_days(self) -> list[str]:
        """The day categories currently plotted on the time-series X axis."""
        return list(self.time_axis_x.categories())

    def model_names(self) -> list[str]:
        """The model categories currently plotted on the per-model X axis."""
        return list(self.model_axis_x.categories())

    # -- refresh (AC2) ----------------------------------------------------- #
    def refresh(self) -> None:
        """Kick an off-thread usage scan; results land back on the GUI thread.

        A refresh already in flight is a no-op (the interval timer and the button
        can't stack scans). Never blocks: the discover→parse→aggregate happens on a
        thread-pool thread.
        """
        if self._busy:
            return
        self._busy = True
        self.refresh_button.setEnabled(False)
        self.status_label.setText("Scanning transcripts…")

        worker = _UsageWorker(self._instrumented_load)
        worker.signals.finished.connect(self._on_finished)
        worker.signals.failed.connect(self._on_failed)
        self._pool.start(worker)

    def _instrumented_load(self) -> UsageSnapshot:
        # Runs on the worker thread — record which thread so AC2 (off-GUI-thread) is
        # assertable, then delegate to the real (or injected) loader.
        self.last_load_thread_ident = get_ident()
        return self._load()

    def _on_finished(self, snapshot: UsageSnapshot) -> None:
        self._snapshot = snapshot
        self._render(snapshot)
        self._end_refresh()
        self.usage_loaded.emit()

    def _on_failed(self, message: str) -> None:
        self.status_label.setText(f"Scan failed: {message}")
        self._end_refresh()
        self.refresh_failed.emit(message)

    def _end_refresh(self) -> None:
        self._busy = False
        self.refresh_button.setEnabled(True)

    # -- rendering --------------------------------------------------------- #
    def _render(self, snapshot: UsageSnapshot) -> None:
        self._render_summary(snapshot)
        self._render_time_chart(snapshot)
        self._render_model_chart(snapshot)

    def _render_summary(self, snapshot: UsageSnapshot) -> None:
        grand = grand_totals(snapshot)
        today = today_totals(snapshot, self._today)

        self.today_tokens_label.setText(f"{_fmt_tokens(today.total_tokens)} tokens")
        self.today_cost_label.setText(f"{_fmt_cost(today.total_cost)} est.")
        self.total_tokens_label.setText(f"{_fmt_tokens(grand.total_tokens)} tokens")
        self.total_cost_label.setText(f"{_fmt_cost(grand.total_cost)} est.")
        self.sessions_label.setText(str(len(snapshot.by_session)))

        if grand.has_unpriced:
            models = ", ".join(sorted(grand.unpriced_models)) or "unknown"
            self.unpriced_label.setText(
                f"⚠ {grand.unpriced_turns} turn(s) unpriced (unknown model: {models}) — "
                "their tokens are counted but excluded from the cost estimate, so the "
                "total understates actual spend."
            )
            self.unpriced_label.setVisible(True)
        else:
            self.unpriced_label.setText("")
            self.unpriced_label.setVisible(False)

        note = (
            f"{grand.turns} turn(s) across {len(snapshot.by_session)} session(s)"
            if grand.turns
            else "No usage found in local transcripts."
        )
        self.status_label.setText(note)

    def _render_time_chart(self, snapshot: UsageSnapshot) -> None:
        days = sorted_day_keys(snapshot)
        self.cost_series.clear()
        self.tokens_series.clear()

        max_cost = 0.0
        max_tokens = 0
        for i, day in enumerate(days):
            agg = snapshot.by_day[day]
            cost = agg.total_cost
            tokens = agg.total_tokens
            self.cost_series.append(i, cost)
            self.tokens_series.append(i, tokens)
            max_cost = max(max_cost, cost)
            max_tokens = max(max_tokens, tokens)

        self.time_axis_x.clear()
        self.time_axis_x.append(days)
        self.time_axis_cost.setRange(0, max_cost * 1.1 if max_cost > 0 else 1.0)
        self.time_axis_tokens.setRange(0, max_tokens * 1.1 if max_tokens > 0 else 1.0)

    def _render_model_chart(self, snapshot: UsageSnapshot) -> None:
        # Every model that produced turns — sorted by tokens desc so the heaviest
        # models lead; unknown/unpriced models appear here too (never hidden, AC3).
        aggs = sorted(
            snapshot.by_model.values(), key=lambda a: a.total_tokens, reverse=True
        )
        self.model_barset.remove(0, self.model_barset.count())
        categories: list[str] = []
        max_tokens = 0
        for agg in aggs:
            label = agg.key + (" (unpriced)" if agg.has_unpriced else "")
            categories.append(label)
            self.model_barset.append(agg.total_tokens)
            max_tokens = max(max_tokens, agg.total_tokens)

        self.model_axis_x.clear()
        self.model_axis_x.append(categories)
        self.model_axis_y.setRange(0, max_tokens * 1.1 if max_tokens > 0 else 1.0)
