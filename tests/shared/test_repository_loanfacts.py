"""Tests for LoanFactsRepository (shared/repository_loanfacts.py).

Backed by the in-memory FakeTable (the `loanfacts_repo` fixture). Guarantees:
get returns None until saved (no seed), a save round-trips as floats, a second
save overwrites in place, and only the six user fields are surfaced (pk/sk stay
internal).
"""

from decimal import Decimal

_FIELDS = ("original", "homeValue", "lvr", "ratePct", "baseRepay", "extra")


def _save(repo, **over):
    facts = {
        "original": Decimal("600000"), "homeValue": Decimal("770000"), "lvr": Decimal("0.8"),
        "ratePct": Decimal("5.74"), "baseRepay": Decimal("1240"), "extra": Decimal("200"),
    }
    facts.update(over)
    return repo.set_loanfacts(**facts)


def test_get_returns_none_before_any_save(loanfacts_repo):
    assert loanfacts_repo.get_loanfacts() is None


def test_save_then_get_round_trips_as_floats(loanfacts_repo):
    _save(loanfacts_repo)
    # Saved without a goal date → a row with no payoffGoalDate attribute, so get
    # returns None for it (this is also the back-compat path for pre-WHIT-126 rows).
    assert loanfacts_repo.get_loanfacts() == {
        "original": 600000.0, "homeValue": 770000.0, "lvr": 0.8,
        "ratePct": 5.74, "baseRepay": 1240.0, "extra": 200.0,
        "payoffGoalDate": None, "depositTarget": None,
    }


def test_save_overwrites_in_place(loanfacts_repo):
    _save(loanfacts_repo)
    _save(loanfacts_repo, homeValue=Decimal("800000"), extra=Decimal("0"))
    got = loanfacts_repo.get_loanfacts()
    assert got["homeValue"] == 800000.0
    assert got["extra"] == 0.0
    assert len(loanfacts_repo._table.store) == 1   # one row, latest wins


def test_get_surfaces_only_the_six_fields(loanfacts_repo):
    _save(loanfacts_repo)
    got = loanfacts_repo.get_loanfacts()
    # The six fields plus the optional goal date + deposit target; no pk/sk/version leaked.
    assert set(got) == set(_FIELDS) | {"payoffGoalDate", "depositTarget"}


def test_save_with_goal_date_round_trips(loanfacts_repo):
    _save(loanfacts_repo, payoffGoalDate="2035-06-01")
    assert loanfacts_repo.get_loanfacts()["payoffGoalDate"] == "2035-06-01"


def test_clearing_the_goal_date_drops_it_no_stale_value(loanfacts_repo):
    # Set a goal date, then save again without one: the whole item is replaced, so the
    # attribute is dropped — a cleared date must not survive as a stale value (WHIT-126).
    _save(loanfacts_repo, payoffGoalDate="2035-06-01")
    assert loanfacts_repo.get_loanfacts()["payoffGoalDate"] == "2035-06-01"
    _save(loanfacts_repo)  # no goal date this time
    assert loanfacts_repo.get_loanfacts()["payoffGoalDate"] is None
    assert len(loanfacts_repo._table.store) == 1   # still one row, latest wins


def test_save_with_deposit_target_round_trips_as_float(loanfacts_repo):
    _save(loanfacts_repo, depositTarget=Decimal("120000"))
    got = loanfacts_repo.get_loanfacts()
    assert got["depositTarget"] == 120000.0
    assert isinstance(got["depositTarget"], float)


def test_clearing_the_deposit_target_drops_it_no_stale_value(loanfacts_repo):
    # Same store-only-when-set contract as the goal date (WHIT-378): a cleared target
    # must not survive as a stale value.
    _save(loanfacts_repo, depositTarget=Decimal("120000"))
    assert loanfacts_repo.get_loanfacts()["depositTarget"] == 120000.0
    _save(loanfacts_repo)  # no deposit target this time
    assert loanfacts_repo.get_loanfacts()["depositTarget"] is None
    assert len(loanfacts_repo._table.store) == 1


def test_reading_a_legacy_row_without_deposit_target_returns_none(loanfacts_repo):
    # Rows saved before WHIT-378 simply lack the attribute → get yields None (no migration).
    _save(loanfacts_repo)
    assert loanfacts_repo.get_loanfacts()["depositTarget"] is None
