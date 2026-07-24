"""Unit tests for the Claude usage / cost / token data core (ticket #273).

Hermetic by construction: every test reads only the SYNTHETIC fixtures under
``tests/fixtures/`` — no real ``~/.claude`` transcript is ever opened, and the
fixtures contain no real prompt/response content. The suite locks in the ACs:

* AC1 — per-turn extraction of all four token classes + model + timestamp, and
  tolerance of malformed / partial / non-assistant lines.
* AC2 — per-class cost math against the pinned rate table, and unknown models
  flagged *unpriced* (tokens counted, cost never guessed).
* AC3 — aggregation by session / day / model into the normalized dataclasses.
* AC4 — no message content is ever surfaced or stored.
"""

from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path

import pytest

from forge_cockpit import usage
from forge_cockpit.usage import (
    PRICING,
    UNKNOWN_DAY,
    Cost,
    ModelRate,
    UsageAggregate,
    UsageRecord,
    aggregate_by_day,
    aggregate_by_model,
    aggregate_by_session,
    collect_usage,
    compute_cost,
    iter_transcript_paths,
    parse_transcript,
    resolve_rate,
)

FIXTURES = Path(__file__).parent / "fixtures"
GOOD = FIXTURES / "transcript_good.jsonl"


# --------------------------------------------------------------------------- #
# AC1 — extraction + tolerance
# --------------------------------------------------------------------------- #


def test_extracts_all_four_token_classes():
    records = list(parse_transcript(GOOD))
    first = records[0]
    assert first.session_id == "sess-A"
    assert first.model == "claude-opus-4-8"
    assert first.input_tokens == 100
    assert first.output_tokens == 40
    assert first.cache_read_tokens == 2000
    assert first.cache_creation_tokens == 500
    assert first.total_tokens == 2640


def test_extracts_model_and_timestamp():
    first = next(iter(parse_transcript(GOOD)))
    assert isinstance(first.timestamp, datetime)
    assert first.timestamp == datetime(
        2026, 7, 20, 9, 0, 2, 500000, tzinfo=timezone.utc
    )


def test_skips_malformed_partial_and_nonassistant_lines():
    records = list(parse_transcript(GOOD))
    # The fixture has a corrupt line, a truncated streaming line, plus system /
    # user lines — none of which may become records. Only the 5 well-formed
    # assistant turns survive.
    assert len(records) == 5
    assert all(isinstance(r, UsageRecord) for r in records)


def test_missing_token_fields_default_to_zero():
    # The haiku turn records only input/output; cache fields are absent.
    haiku = next(
        r for r in parse_transcript(GOOD) if r.model.startswith("claude-haiku")
    )
    assert haiku.input_tokens == 50
    assert haiku.output_tokens == 60
    assert haiku.cache_read_tokens == 0
    assert haiku.cache_creation_tokens == 0


def test_unreadable_file_yields_nothing():
    assert list(parse_transcript(FIXTURES / "does-not-exist.jsonl")) == []


def test_bad_token_types_are_tolerated(tmp_path: Path):
    # A line whose token values are strings/bools/nulls must not crash — those
    # coerce to 0 rather than raising.
    bad = tmp_path / "t.jsonl"
    bad.write_text(
        json.dumps(
            {
                "type": "assistant",
                "sessionId": "s",
                "timestamp": "not-a-timestamp",
                "message": {
                    "model": "claude-opus-4-8",
                    "usage": {
                        "input_tokens": "oops",
                        "output_tokens": None,
                        "cache_read_input_tokens": True,
                        "cache_creation_input_tokens": 5,
                    },
                },
            }
        )
        + "\n",
        encoding="utf-8",
    )
    (record,) = list(parse_transcript(bad))
    assert record.input_tokens == 0
    assert record.output_tokens == 0
    assert record.cache_read_tokens == 0  # bool is not counted as int
    assert record.cache_creation_tokens == 5
    assert record.timestamp is None  # unparseable timestamp -> None, not fatal


# --------------------------------------------------------------------------- #
# AC2 — pricing (per class) + unpriced flagging
# --------------------------------------------------------------------------- #


def test_cost_priced_per_class():
    rec = UsageRecord(
        session_id="s",
        model="claude-opus-4-8",
        timestamp=None,
        input_tokens=1_000_000,
        output_tokens=1_000_000,
        cache_read_tokens=1_000_000,
        cache_creation_tokens=1_000_000,
    )
    cost = compute_cost(rec)
    assert not cost.unpriced
    # Opus: input $5, output $25, cache-read 0.1x = $0.50, cache-write 1.25x = $6.25
    assert cost.input == pytest.approx(5.0)
    assert cost.output == pytest.approx(25.0)
    assert cost.cache_read == pytest.approx(0.5)
    assert cost.cache_creation == pytest.approx(6.25)
    assert cost.total == pytest.approx(36.75)


def test_each_class_uses_its_own_rate():
    # Only output tokens -> only the output rate contributes.
    rec = UsageRecord("s", "claude-sonnet-5", None, 0, 2_000_000, 0, 0)
    cost = compute_cost(rec)
    assert cost.input == 0.0
    assert cost.output == pytest.approx(30.0)  # 2M * $15/M
    assert cost.cache_read == 0.0
    assert cost.cache_creation == 0.0


def test_unknown_model_flagged_not_guessed():
    rec = UsageRecord("s", "claude-experimental-99", None, 300, 80, 10, 5)
    cost = compute_cost(rec)
    assert cost.unpriced is True
    # Cost is never guessed for an unknown model.
    assert cost.total == 0.0
    # ...but the tokens are still real and counted on the record itself.
    assert rec.total_tokens == 395


def test_date_suffixed_model_resolves_to_base_rate():
    assert resolve_rate("claude-haiku-4-5-20251001") is PRICING["claude-haiku-4-5"]


def test_resolve_rate_unknown_and_empty():
    assert resolve_rate("totally-made-up") is None
    assert resolve_rate("") is None
    assert resolve_rate(None) is None


def test_pricing_table_covers_current_models():
    for model in (
        "claude-opus-4-8",
        "claude-fable-5",
        "claude-sonnet-5",
        "claude-haiku-4-5",
    ):
        rate = resolve_rate(model)
        assert isinstance(rate, ModelRate)
        assert rate.input > 0 and rate.output > 0


# --------------------------------------------------------------------------- #
# AC3 — aggregation by session / day / model
# --------------------------------------------------------------------------- #


def test_aggregate_by_session():
    records = collect_usage(FIXTURES)
    by_session = aggregate_by_session(records)
    assert set(by_session) == {"sess-A", "sess-B", "sess-C"}
    a = by_session["sess-A"]
    assert isinstance(a, UsageAggregate)
    assert a.turns == 3  # two opus turns + one haiku turn
    assert a.input_tokens == 100 + 10 + 50
    assert a.output_tokens == 40 + 200 + 60
    assert not a.has_unpriced


def test_aggregate_by_day_buckets_by_utc_date():
    records = collect_usage(FIXTURES)
    by_day = aggregate_by_day(records)
    # sess-A has turns on the 20th (x2) and 21st; sess-B both on the 21st;
    # sess-C one on the 22nd and one with no timestamp -> UNKNOWN_DAY.
    assert "2026-07-20" in by_day
    assert "2026-07-21" in by_day
    assert "2026-07-22" in by_day
    assert UNKNOWN_DAY in by_day
    assert by_day["2026-07-20"].turns == 2


def test_aggregate_by_model_flags_unpriced_bucket():
    records = collect_usage(FIXTURES)
    by_model = aggregate_by_model(records)
    assert "claude-experimental-99" in by_model
    unknown = by_model["claude-experimental-99"]
    assert unknown.has_unpriced
    assert unknown.unpriced_turns == 1
    assert unknown.unpriced_models == {"claude-experimental-99"}
    assert unknown.total_tokens == 395  # tokens counted despite being unpriced
    assert unknown.total_cost == 0.0
    # A priced model bucket carries real cost and no unpriced flag.
    opus = by_model["claude-opus-4-8"]
    assert not opus.has_unpriced
    assert opus.total_cost > 0.0


def test_aggregate_cost_sums_match_per_record():
    records = collect_usage(FIXTURES)
    by_model = aggregate_by_model(records)
    expected = 0.0
    for rec in records:
        expected += compute_cost(rec).total
    got = sum(agg.total_cost for agg in by_model.values())
    assert got == pytest.approx(expected)


def test_recursive_discovery_finds_nested_transcripts():
    paths = list(iter_transcript_paths(FIXTURES))
    names = {p.name for p in paths}
    assert "transcript_good.jsonl" in names
    assert "transcript_more.jsonl" in names  # lives in fixtures/nested/proj/


def test_missing_root_yields_no_paths(tmp_path: Path):
    assert list(iter_transcript_paths(tmp_path / "nope")) == []


# --------------------------------------------------------------------------- #
# AC4 — no message content ever surfaced or stored
# --------------------------------------------------------------------------- #


def test_record_has_no_content_field():
    fields = set(UsageRecord.__dataclass_fields__)
    assert "content" not in fields
    # The full field set is exactly the usage-metadata columns — nothing else.
    assert fields == {
        "session_id",
        "model",
        "timestamp",
        "input_tokens",
        "output_tokens",
        "cache_read_tokens",
        "cache_creation_tokens",
    }


def test_no_prompt_or_response_text_surfaces_anywhere():
    # The good fixture embeds sentinel SECRET-*-TEXT strings in message content.
    # None of them may appear in any parsed record's repr.
    records = list(parse_transcript(GOOD))
    blob = " ".join(repr(r) for r in records)
    assert "SECRET" not in blob
    # And nothing in the record objects equals the content sentinels.
    for rec in records:
        for value in vars(rec).values():
            assert "SECRET" not in str(value)
