"""Claude usage / cost / token data core (ticket #273) — the data layer #274 charts.

Claude Code writes one JSONL *transcript* per session under
``~/.claude/projects/**/*.jsonl`` (ADR-0006). Every assistant turn is a line
whose ``message.usage`` records the four token classes Anthropic bills
separately — ``input_tokens``, ``output_tokens``, ``cache_read_input_tokens``,
``cache_creation_input_tokens`` — alongside ``message.model`` and a top-level
ISO-8601 ``timestamp`` (and ``sessionId``). This module *discovers* those
transcripts, *streams* them line-by-line into a normalized, typed usage model,
*prices* each turn against a pinned per-model rate table, and *aggregates* by
session / day / model.

Privacy invariants (non-negotiable — AC4):

* **Read-only.** Files are opened for reading only; nothing here writes, moves,
  or truncates a transcript.
* **Usage metadata only — never CONTENT.** The parser reads ``message.usage``,
  ``message.model``, the record ``timestamp`` and ``sessionId``, and nothing
  else. It never touches ``message.content`` / prompts / responses, and
  :class:`UsageRecord` has no field in which message text could be stored. No
  prompt or response text ever leaves this module.

Tolerance invariant (AC1): a transcript is an append-only log that may contain
malformed, partial, or half-written (streaming) lines. Every such line is
*skipped*, never fatal — a single bad line never aborts a scan.

Pricing invariant (AC2): :data:`PRICING` is a **pinned** table of Anthropic
list prices (USD per million tokens; see :data:`PRICING_UNIT`). A model absent
from the table is surfaced as **unpriced** — its tokens are still counted, its
cost is never guessed or silently defaulted. Keep the table updated as Anthropic
publishes new models / prices.
"""

from __future__ import annotations

import json
from collections.abc import Callable, Iterable, Iterator
from dataclasses import dataclass, field
from datetime import date, datetime, timezone
from pathlib import Path

# --------------------------------------------------------------------------- #
# Pricing — a PINNED, updatable model -> rate table (AC2).
# --------------------------------------------------------------------------- #

#: Unit for every number in :data:`PRICING`: US dollars per **one million**
#: tokens of that class. cost = tokens / 1_000_000 * rate.
PRICING_UNIT = "USD per 1M tokens"

# Cache tokens are priced relative to a model's base *input* rate (Anthropic
# prompt-caching pricing): reads bill at ~0.1x input; 5-minute-TTL writes — the
# default Claude Code uses — bill at ~1.25x input. Kept as named constants so
# the table below stays a single source of truth and is trivial to re-derive.
_CACHE_READ_MULT = 0.10
_CACHE_WRITE_MULT = 1.25


@dataclass(frozen=True)
class ModelRate:
    """Per-model prices for each billed token class (USD per 1M tokens)."""

    input: float
    output: float
    cache_read: float
    cache_creation: float


def _rate(input_: float, output: float) -> ModelRate:
    """Build a :class:`ModelRate` from the two published headline prices,
    deriving the cache-read / cache-creation prices via the standard multipliers.
    """

    return ModelRate(
        input=input_,
        output=output,
        cache_read=round(input_ * _CACHE_READ_MULT, 6),
        cache_creation=round(input_ * _CACHE_WRITE_MULT, 6),
    )


#: Pinned Anthropic list prices. Update when models / prices change. Keys are the
#: canonical model ids; date-suffixed aliases (e.g.
#: ``claude-haiku-4-5-20251001``) resolve to their base id via
#: :func:`resolve_rate`.
PRICING: dict[str, ModelRate] = {
    # Opus tier — $5 / $25
    "claude-opus-4-8": _rate(5.0, 25.0),
    "claude-opus-4-7": _rate(5.0, 25.0),
    "claude-opus-4-6": _rate(5.0, 25.0),
    "claude-opus-4-5": _rate(5.0, 25.0),
    # Fable / Mythos tier — $10 / $50
    "claude-fable-5": _rate(10.0, 50.0),
    "claude-mythos-5": _rate(10.0, 50.0),
    # Sonnet tier — $3 / $15
    "claude-sonnet-5": _rate(3.0, 15.0),
    "claude-sonnet-4-6": _rate(3.0, 15.0),
    "claude-sonnet-4-5": _rate(3.0, 15.0),
    # Haiku tier — $1 / $5
    "claude-haiku-4-5": _rate(1.0, 5.0),
}


def _strip_date_suffix(model: str) -> str | None:
    """Return ``model`` with a trailing ``-YYYYMMDD`` snapshot suffix removed,
    or ``None`` when there is no such suffix. ``claude-haiku-4-5-20251001`` ->
    ``claude-haiku-4-5``.
    """

    head, _, tail = model.rpartition("-")
    if head and len(tail) == 8 and tail.isdigit():
        return head
    return None


def resolve_rate(model: str | None) -> ModelRate | None:
    """Look up the rate for ``model``: exact match first, then the base id with a
    ``-YYYYMMDD`` snapshot suffix stripped. Returns ``None`` (→ *unpriced*) for an
    unknown model — never a guessed default.
    """

    if not model:
        return None
    rate = PRICING.get(model)
    if rate is not None:
        return rate
    base = _strip_date_suffix(model)
    if base is not None:
        return PRICING.get(base)
    return None


# --------------------------------------------------------------------------- #
# Normalized usage model (dataclasses) — usage metadata ONLY (AC4).
# --------------------------------------------------------------------------- #


@dataclass(frozen=True)
class UsageRecord:
    """One assistant turn's usage — the atom of the usage model.

    Deliberately carries **no** message content: only the four token classes,
    the model id, the session id, and the turn timestamp. There is nowhere here
    to store prompt/response text (AC4).
    """

    session_id: str
    model: str
    timestamp: datetime | None
    input_tokens: int
    output_tokens: int
    cache_read_tokens: int
    cache_creation_tokens: int

    @property
    def total_tokens(self) -> int:
        return (
            self.input_tokens
            + self.output_tokens
            + self.cache_read_tokens
            + self.cache_creation_tokens
        )


@dataclass(frozen=True)
class Cost:
    """Cost of a turn (or aggregate), broken out per token class (USD).

    ``unpriced`` is ``True`` when the model was not in :data:`PRICING`: the
    tokens are still counted upstream, but no cost was computed for them (AC2).
    """

    input: float = 0.0
    output: float = 0.0
    cache_read: float = 0.0
    cache_creation: float = 0.0
    unpriced: bool = False

    @property
    def total(self) -> float:
        return self.input + self.output + self.cache_read + self.cache_creation


def compute_cost(record: UsageRecord) -> Cost:
    """Price one :class:`UsageRecord`. Unknown model → flagged ``unpriced`` with
    zero cost (tokens counted elsewhere, never guessed)."""

    rate = resolve_rate(record.model)
    if rate is None:
        return Cost(unpriced=True)
    return Cost(
        input=record.input_tokens / 1_000_000 * rate.input,
        output=record.output_tokens / 1_000_000 * rate.output,
        cache_read=record.cache_read_tokens / 1_000_000 * rate.cache_read,
        cache_creation=record.cache_creation_tokens / 1_000_000 * rate.cache_creation,
        unpriced=False,
    )


@dataclass
class UsageAggregate:
    """Token + cost totals for one bucket (a session, day, or model)."""

    key: str
    turns: int = 0
    input_tokens: int = 0
    output_tokens: int = 0
    cache_read_tokens: int = 0
    cache_creation_tokens: int = 0
    cost_input: float = 0.0
    cost_output: float = 0.0
    cost_cache_read: float = 0.0
    cost_cache_creation: float = 0.0
    #: Number of turns in this bucket whose model was not in :data:`PRICING`.
    unpriced_turns: int = 0
    #: The distinct unknown model ids that contributed unpriced turns.
    unpriced_models: set[str] = field(default_factory=set)

    def add(self, record: UsageRecord, cost: Cost) -> None:
        self.turns += 1
        self.input_tokens += record.input_tokens
        self.output_tokens += record.output_tokens
        self.cache_read_tokens += record.cache_read_tokens
        self.cache_creation_tokens += record.cache_creation_tokens
        self.cost_input += cost.input
        self.cost_output += cost.output
        self.cost_cache_read += cost.cache_read
        self.cost_cache_creation += cost.cache_creation
        if cost.unpriced:
            self.unpriced_turns += 1
            self.unpriced_models.add(record.model)

    @property
    def total_tokens(self) -> int:
        return (
            self.input_tokens
            + self.output_tokens
            + self.cache_read_tokens
            + self.cache_creation_tokens
        )

    @property
    def total_cost(self) -> float:
        return (
            self.cost_input
            + self.cost_output
            + self.cost_cache_read
            + self.cost_cache_creation
        )

    @property
    def has_unpriced(self) -> bool:
        return self.unpriced_turns > 0


# --------------------------------------------------------------------------- #
# Discovery + tolerant streaming parser (AC1).
# --------------------------------------------------------------------------- #


def default_projects_root() -> Path:
    """The standard Claude Code transcript root: ``~/.claude/projects``."""

    return Path.home() / ".claude" / "projects"


def iter_transcript_paths(root: Path | str | None = None) -> Iterator[Path]:
    """Yield every ``*.jsonl`` transcript under ``root`` (default
    :func:`default_projects_root`), recursively. A missing root yields nothing —
    never raises."""

    base = Path(root) if root is not None else default_projects_root()
    if not base.exists():
        return
    yield from sorted(base.glob("**/*.jsonl"))


def _parse_timestamp(raw: object) -> datetime | None:
    """Parse an ISO-8601 timestamp tolerantly; ``None`` on anything unusable."""

    if not isinstance(raw, str) or not raw:
        return None
    text = raw.strip()
    # Python's fromisoformat handles the trailing 'Z' only on 3.11+; normalize.
    if text.endswith("Z"):
        text = text[:-1] + "+00:00"
    try:
        return datetime.fromisoformat(text)
    except ValueError:
        return None


def _record_from_obj(obj: object) -> UsageRecord | None:
    """Build a :class:`UsageRecord` from one decoded JSONL object, or ``None`` if
    the line is not a priced-able assistant turn. Reads usage metadata ONLY —
    ``message.content`` is never inspected (AC4)."""

    if not isinstance(obj, dict):
        return None
    if obj.get("type") != "assistant":
        return None
    message = obj.get("message")
    if not isinstance(message, dict):
        return None
    usage = message.get("usage")
    if not isinstance(usage, dict):
        return None

    def _as_int(value: object) -> int:
        return value if isinstance(value, int) and not isinstance(value, bool) else 0

    model = message.get("model")
    if not isinstance(model, str) or not model:
        model = "unknown"

    session_id = obj.get("sessionId")
    if not isinstance(session_id, str) or not session_id:
        session_id = "unknown"

    return UsageRecord(
        session_id=session_id,
        model=model,
        timestamp=_parse_timestamp(obj.get("timestamp")),
        input_tokens=_as_int(usage.get("input_tokens")),
        output_tokens=_as_int(usage.get("output_tokens")),
        cache_read_tokens=_as_int(usage.get("cache_read_input_tokens")),
        cache_creation_tokens=_as_int(usage.get("cache_creation_input_tokens")),
    )


def parse_transcript(path: Path | str) -> Iterator[UsageRecord]:
    """Stream one transcript file, yielding a :class:`UsageRecord` per assistant
    turn. Malformed / partial / non-assistant lines are skipped (AC1). Opened
    read-only (AC4). An unreadable file yields nothing rather than raising."""

    try:
        handle = open(path, encoding="utf-8", errors="replace")
    except OSError:
        return
    with handle:
        for line in handle:
            line = line.strip()
            if not line:
                continue
            try:
                obj = json.loads(line)
            except (ValueError, TypeError):
                # Malformed or half-written (streaming) line — skip, don't crash.
                continue
            record = _record_from_obj(obj)
            if record is not None:
                yield record


def collect_usage(root: Path | str | None = None) -> list[UsageRecord]:
    """Discover and parse every transcript under ``root``, returning all
    per-turn usage records. Read-only end to end (AC4)."""

    records: list[UsageRecord] = []
    for path in iter_transcript_paths(root):
        records.extend(parse_transcript(path))
    return records


# --------------------------------------------------------------------------- #
# Aggregation by session / day / model (AC3).
# --------------------------------------------------------------------------- #


def _aggregate(
    records: Iterable[UsageRecord], key_of: Callable[[UsageRecord], str]
) -> dict[str, UsageAggregate]:
    buckets: dict[str, UsageAggregate] = {}
    for record in records:
        key = key_of(record)
        bucket = buckets.get(key)
        if bucket is None:
            bucket = buckets[key] = UsageAggregate(key=key)
        bucket.add(record, compute_cost(record))
    return buckets


#: Bucket key used for records whose turn has no parseable timestamp.
UNKNOWN_DAY = "unknown"


def _day_key(record: UsageRecord) -> str:
    ts = record.timestamp
    if ts is None:
        return UNKNOWN_DAY
    # Normalize to UTC calendar date so a day bucket is stable across offsets.
    if ts.tzinfo is not None:
        ts = ts.astimezone(timezone.utc)
    day: date = ts.date()
    return day.isoformat()


def aggregate_by_session(records: Iterable[UsageRecord]) -> dict[str, UsageAggregate]:
    """Totals keyed by ``session_id`` (AC3)."""

    return _aggregate(records, lambda r: r.session_id)


def aggregate_by_day(records: Iterable[UsageRecord]) -> dict[str, UsageAggregate]:
    """Totals keyed by UTC calendar day (``YYYY-MM-DD``; :data:`UNKNOWN_DAY` for
    turns without a timestamp) (AC3)."""

    return _aggregate(records, _day_key)


def aggregate_by_model(records: Iterable[UsageRecord]) -> dict[str, UsageAggregate]:
    """Totals keyed by model id (AC3). Unknown models still bucket and count —
    they carry ``unpriced_turns`` > 0."""

    return _aggregate(records, lambda r: r.model)
