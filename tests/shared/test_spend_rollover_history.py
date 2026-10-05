"""WHIT-742: sealing a rollover cycle keeps that cycle's record, so the carryover can say which
cycles it came from. The listed cycles plus the remainder always add up to the carryover."""

from decimal import Decimal

from _rollover_fakes import charge, cycle_record

TODAY = "2026-08-10"  # settle cutoff 2026-07-31
LENGTH = 30
SEALED = ("2026-06-07", "2026-07-06")
SETTLING = ("2026-07-07", "2026-08-05")


def _entry(**extra):
    return {"target": Decimal(100), "carryover": Decimal(0), "carryover_from": SEALED[0], **extra}


def _seal(shared, entry, windows, charges):
    return shared.spend.seal_rollover(entry, windows, {"sink"}, charges, LENGTH, TODAY)


def test_a_sealed_cycle_counts_posted_and_pending_and_is_saved_with_the_carryover(shared):
    charges = [charge("sink", "2026-06-10", "-30"), charge("sink", "2026-06-11", "-90", status="pending")]

    carryover, cycles, earlier, persist = _seal(shared, _entry(), [SEALED], charges)

    assert carryover == Decimal(-20)
    assert cycles == [{**cycle_record(*SEALED, 120, -20), "settling": False}]
    assert earlier == Decimal(0)
    assert persist == {"carryover": Decimal(-20), "carryover_from": "2026-07-07",
                       "carryover_history": [cycle_record(*SEALED, 120, -20)]}


def test_new_seals_go_in_front_of_the_stored_history_and_the_legacy_amount_stays_earlier(shared):
    old = cycle_record("2026-05-08", "2026-06-06", 150, -50)
    entry = _entry(carryover=Decimal(-10), carryover_history=[old])  # −50 sealed + 40 from before history

    carryover, cycles, earlier, persist = _seal(shared, entry, [SEALED, SETTLING], [charge("sink", "2026-07-20", "-30")])

    assert [c["start"] for c in cycles] == ["2026-07-07", "2026-06-07", "2026-05-08"]
    assert [c["settling"] for c in cycles] == [True, False, False]
    assert earlier == Decimal(40)
    assert sum(c["leftover"] for c in cycles) + earlier == carryover == Decimal(160)
    assert persist["carryover_history"] == [cycle_record(*SEALED, 0, 100), old]


def test_only_settling_cycles_leave_the_history_unsaved(shared):
    old = cycle_record("2026-06-07", "2026-07-06", 0, 100)
    entry = _entry(carryover=Decimal(100), carryover_from="2026-07-07", carryover_history=[old])

    carryover, cycles, earlier, persist = _seal(shared, entry, [SETTLING], [])

    assert carryover == Decimal(200)
    assert cycles == [{**cycle_record(*SETTLING, 0, 100), "settling": True}, {**old, "settling": False}]
    assert earlier == Decimal(0)
    assert persist is None


def test_the_history_keeps_only_the_newest_cycles_and_the_overflow_moves_to_earlier(shared, monkeypatch):
    monkeypatch.setattr(shared.spend, "ROLLOVER_HISTORY_MAX_CYCLES", 2)
    older = [cycle_record("2026-05-08", "2026-06-06", 150, -50), cycle_record("2026-04-08", "2026-05-07", 70, 30)]
    entry = _entry(carryover=Decimal(-20), carryover_history=older)

    carryover, cycles, earlier, persist = _seal(shared, entry, [SEALED], [])

    assert [c["start"] for c in cycles] == ["2026-06-07", "2026-05-08"]
    assert earlier == Decimal(30)
    assert sum(c["leftover"] for c in cycles) + earlier == carryover == Decimal(80)
    assert len(persist["carryover_history"]) == 2


def test_no_history_yet_means_the_whole_carryover_is_earlier(shared):
    cycles, earlier = shared.spend.rollover_history_view([], Decimal(-859))

    assert cycles == []
    assert earlier == Decimal(-859)
