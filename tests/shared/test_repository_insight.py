"""Tests for InsightRepository (shared/repository_insight.py, WHIT-104).

The per-pay-cycle AI-insight cache: get returns None until put, a put round-trips
the payload, keys are per-cycle (a different cycle_start is a different row), and a
second put for the same cycle overwrites in place. Backed by the in-memory
FakeTable (the `insight_repo` fixture).
"""


def test_get_returns_none_before_any_put(insight_repo):
    assert insight_repo.get_insight("2026-06-25") is None


def test_put_then_get_round_trips_the_payload(insight_repo):
    insight_repo.put_insight("2026-06-25", "Solid cycle.", ["Cut coffee $20"], "2026-06-30T00:00:00Z", "h1")
    got = insight_repo.get_insight("2026-06-25")
    assert got == {
        "summary": "Solid cycle.",
        "suggestions": ["Cut coffee $20"],
        "generated_at": "2026-06-30T00:00:00Z",
        "input_hash": "h1",
    }


def test_key_is_per_cycle(insight_repo):
    insight_repo.put_insight("2026-06-25", "cycle A", [], "t", "h1")
    # A different cycle_start is a separate row -> None for the other key.
    assert insight_repo.get_insight("2026-07-09") is None
    assert insight_repo.get_insight("2026-06-25")["summary"] == "cycle A"


def test_second_put_overwrites_in_place(insight_repo):
    insight_repo.put_insight("2026-06-25", "old", ["a"], "t1", "h1")
    insight_repo.put_insight("2026-06-25", "new", ["b", "c"], "t2", "h2")
    got = insight_repo.get_insight("2026-06-25")
    assert got["summary"] == "new" and got["input_hash"] == "h2"
    assert len(insight_repo._table.store) == 1   # one row per cycle, latest wins


def test_null_summary_round_trips(insight_repo):
    # A graceful-empty generation stores summary=None / suggestions=[] and reads back.
    insight_repo.put_insight("2026-06-25", None, [], "t", "h0")
    got = insight_repo.get_insight("2026-06-25")
    assert got["summary"] is None and got["suggestions"] == []
