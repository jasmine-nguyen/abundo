"""WHIT-742 QA: seal_rollover's cycle list always adds up to the carryover it shows."""

from decimal import Decimal

import pytest

from _budget_endpoint_fakes import LENGTH, TODAY  # settle cutoff 2026-07-31
from _rollover_fakes import charge, cycle_record

W1 = ("2026-05-08", "2026-06-06")
W2 = ("2026-06-07", "2026-07-06")
W3 = ("2026-07-07", "2026-08-05")  # still settling


def _record(start, end, leftover):
    return cycle_record(start, end, Decimal(100) - Decimal(leftover), leftover)


CHARGES = [charge("sink", "2026-05-10", "-180"), charge("sink", "2026-06-20", "-12.34", "pending"), charge("sink", "2026-07-08", "-99.99")]
OLD = [_record("2026-04-08", "2026-05-07", "-7.5"), _record("2026-03-09", "2026-04-07", "33")]


# [A1] (P0) cycles + earlier == displayed carryover for every mix of stored history,
# legacy amount, sealed and settling windows.
@pytest.mark.parametrize("stored, history, windows", [
    ("0", [], []),
    ("-859", [], []),
    ("-859", [], [W1, W2, W3]),
    ("25.5", OLD, [W1]),
    ("25.5", OLD, [W3]),
    ("-0.01", OLD, [W1, W2, W3]),
])
def test_the_listed_cycles_plus_earlier_add_up_to_the_carryover(shared, stored, history, windows):
    entry = {"target": Decimal(100), "carryover": Decimal(stored), "carryover_from": W1[0],
             "carryover_history": history}

    carryover, cycles, earlier, persist = shared.spend.seal_rollover(entry, windows, {"sink"}, CHARGES, LENGTH, TODAY)

    assert sum((c["leftover"] for c in cycles), Decimal(0)) + earlier == carryover
    assert [c["start"] for c in cycles] == sorted((c["start"] for c in cycles), reverse=True)
    if persist is not None and "carryover_history" in persist:
        saved = persist["carryover_history"]
        assert sum((r["leftover"] for r in saved), Decimal(0)) + earlier == persist["carryover"]
        assert all("settling" not in r for r in saved)


# [A5] (P1) At the real cap a new seal drops the oldest saved cycle into "earlier".
def test_at_the_real_cap_the_oldest_saved_cycle_moves_into_earlier(shared):
    cap = shared.spend.ROLLOVER_HISTORY_MAX_CYCLES
    history = [_record(f"{2026 - n // 12}-{12 - n % 12:02d}-01", f"{2026 - n // 12}-{12 - n % 12:02d}-28", "1")
               for n in range(5, 5 + cap)]  # Jul 2026 back, newest first
    entry = {"target": Decimal(100), "carryover": Decimal(cap), "carryover_from": W1[0],
             "carryover_history": history}

    carryover, cycles, earlier, persist = shared.spend.seal_rollover(entry, [W1], {"sink"}, [], LENGTH, TODAY)

    assert len(persist["carryover_history"]) == cap
    assert persist["carryover_history"][0]["start"] == W1[0]
    assert persist["carryover_history"][1:] == history[:-1]
    assert earlier == Decimal(1)
    assert carryover == Decimal(cap + 100)
