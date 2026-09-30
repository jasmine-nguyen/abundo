"""WHIT-663 slice 1 — the ONE shared copy of "did the user edit this pending?", the settled-twin
matching and the carry-across (shared/pending_carry.py), used by both the hourly pending mirror
and the 10-day age-out. Pure input → output: plain dict rows and a taxonomy stand-in.
"""

import pathlib
import sys
from decimal import Decimal

import pytest

from _boto_stubs import use_condition_fields

_SHARED_DIR = str(pathlib.Path(__file__).resolve().parents[2] / "shared")
_REIMPORT = tuple(sorted({path.stem for path in pathlib.Path(_SHARED_DIR).glob("*.py")} - {"ssm"}))

_ACCOUNT = "anz-spending"
_SHOP = "SQ *KKV INTERNATIONAL PTY"


@pytest.fixture
def pending_carry():
    """shared/pending_carry.py imported with shared/ first on the path, restored afterwards."""
    with use_condition_fields():
        while _SHARED_DIR in sys.path:
            sys.path.remove(_SHARED_DIR)
        sys.path.insert(0, _SHARED_DIR)
        saved = {name: sys.modules.pop(name, None) for name in _REIMPORT}
        import pending_carry

        try:
            yield pending_carry
        finally:
            for name in _REIMPORT:
                sys.modules.pop(name, None)
            for name, module in saved.items():
                if module is not None:
                    sys.modules[name] = module
            while _SHARED_DIR in sys.path:
                sys.path.remove(_SHARED_DIR)


def _unfiled(taxonomy_ids):
    def is_unfiled(category):
        return category != "income" and category not in taxonomy_ids
    return is_unfiled


IS_UNFILED = _unfiled({"groceries", "dining"})


def _row(sk, date_str, *, status, amount="-5.50", category=None, **fields):
    row = {
        "sk": sk,
        "transaction_id": sk,
        "account_id": _ACCOUNT,
        "date": date_str,
        "amount": Decimal(amount),
        "merchant_name": _SHOP,
        "description": _SHOP,
        "status": status,
        "category": category,
        "counts_to_budget": True,
    }
    row.update(fields)
    return row


def _pending(**fields):
    return _row("pending-1", "2026-06-10", status="pending", **fields)


@pytest.mark.parametrize(
    "fields, user_edited, filed",
    [
        ({"category": "groceries"}, True, True),                               # own category
        ({"category": "groceries", "filed_by_rule": "rule-1"}, False, True),   # rule-filed
        ({"category": "FOOD_AND_DRINK"}, False, False),                        # raw bank category
        ({"category": None}, False, False),                                    # untouched
        ({"notes": "birthday gift"}, True, True),
        ({"tags": ["trip"]}, True, True),
        ({"budget_excluded": True}, True, True),
        ({"category": "groceries", "filed_by_rule": "rule-1", "notes": "hi"}, True, True),
    ],
)
def test_one_shared_edit_check_tells_user_edits_from_rule_filing(pending_carry, fields, user_edited, filed):
    # The mirror's rule (is_user_edited) and the age-out's rule (is_filed = user-edited OR
    # rule-filed) come from one module, so the two jobs can no longer drift apart.
    pending = _pending(**fields)

    assert pending_carry.is_user_edited(pending, IS_UNFILED) is user_edited
    assert pending_carry.is_filed(pending, IS_UNFILED) is filed


def test_edited_pending_finds_its_one_strict_twin_and_the_edit_carries_across(pending_carry):
    find = pending_carry.find_carry_twin
    pending = _pending(category="groceries", notes="birthday gift", tags=["trip"])

    # Exact amount, same shop, within ±3 days → the one twin; its raw non-budget category is
    # replaced and counts_to_budget recomputed from the carried category.
    twin = _row("posted-1", "2026-06-13", status="posted", category="TRANSFER_OUT", counts_to_budget=False)
    other_shop = _row("posted-2", "2026-06-11", status="posted", merchant_name="BUNNINGS", description="BUNNINGS")
    other_amount = _row("posted-3", "2026-06-11", status="posted", amount="-5.51")
    too_late = _row("posted-4", "2026-06-14", status="posted")
    assert find(pending, [other_shop, twin, other_amount, too_late], IS_UNFILED) is twin

    carried = pending_carry.with_carried_category(twin, pending, is_unfiled=IS_UNFILED)
    assert carried["sk"] == "posted-1"
    assert carried["status"] == "posted"
    assert carried["category"] == "groceries"
    assert carried["notes"] == "birthday gift"
    assert carried["tags"] == ["trip"]
    assert carried["counts_to_budget"] is True
    assert twin["category"] == "TRANSFER_OUT"  # the input row is not mutated

    # Two equally good twins → a tie carries nothing (a wrong carry is worse than a missed one).
    twin_b = _row("posted-5", "2026-06-11", status="posted")
    assert find(pending, [twin, twin_b], IS_UNFILED) is None

    # A settled charge the user already filed is never a candidate — its filing is never overwritten.
    user_filed = _row("posted-6", "2026-06-11", status="posted", category="dining")
    assert find(pending, [user_filed], IS_UNFILED) is None

    # A user-set category may override a rule's guess on the twin …
    rule_filed = _row("posted-7", "2026-06-11", status="posted", category="dining", filed_by_rule="rule-9")
    assert find(pending, [rule_filed], IS_UNFILED) is rule_filed

    # … but a rule-stamped pending, or one edited only by a note, matches only an unfiled twin.
    rule_pending = _pending(category="groceries", filed_by_rule="rule-1")
    note_pending = _pending(notes="birthday gift")
    unfiled_twin = _row("posted-8", "2026-06-11", status="posted")
    assert find(rule_pending, [rule_filed], IS_UNFILED) is None
    assert find(note_pending, [rule_filed], IS_UNFILED) is None
    assert find(rule_pending, [unfiled_twin], IS_UNFILED) is unfiled_twin
    assert find(note_pending, [unfiled_twin], IS_UNFILED) is unfiled_twin
