"""WHIT-663 slice 1 — the ONE shared copy of "did the user edit this pending?", the settled-twin
matching and the carry-across (shared/pending_carry.py), used by both the hourly pending mirror
and the 10-day age-out. Pure input → output: plain dict rows and a taxonomy stand-in.
"""

import pathlib
import subprocess
import sys
from decimal import Decimal

import pytest

from _feed_fakes import FakeCategoryRepo

_SHARED_DIR = pathlib.Path(__file__).resolve().parents[2] / "shared"

_ACCOUNT = "anz-spending"
_SHOP = "SQ *KKV INTERNATIONAL PTY"


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
        ({"category": "income"}, True, True),                                  # income is always filed
        ({"category": "income", "filed_by_rule": "rule-1"}, False, True),
        ({"notes": "", "tags": [], "budget_excluded": False}, False, False),   # cleared fields are no edit
        ({"category": "FOOD_AND_DRINK", "notes": "gift"}, True, True),
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


@pytest.mark.parametrize(
    "carried_edit",
    [{"notes": "first"}, {"tags": ["trip"]}, {"budget_excluded": True}],
)
def test_a_settled_charge_that_already_holds_a_carried_edit_is_never_matched_again(pending_carry, carried_edit):
    # WHIT-666: a note, tags or exclusion already on the settled charge (carried earlier, or set
    # by the user) makes it claimed — a later pending must not overwrite it.
    find = pending_carry.find_carry_twin

    # A note-only pending against an unfiled charge that already holds an edit → no twin.
    edited_unfiled = _row("posted-1", "2026-06-11", status="posted", **carried_edit)
    assert find(_pending(notes="second"), [edited_unfiled], IS_UNFILED) is None

    # A user-category pending against a rule-filed charge that already holds an edit → no twin.
    edited_rule_filed = _row(
        "posted-2", "2026-06-11", status="posted", category="dining", filed_by_rule="rule-9", **carried_edit,
    )
    assert find(_pending(category="groceries"), [edited_rule_filed], IS_UNFILED) is None

    # A clean unfiled charge next to the edited one → the clean one is the only candidate.
    clean = _row("posted-3", "2026-06-11", status="posted")
    assert find(_pending(notes="second"), [edited_unfiled, clean], IS_UNFILED) is clean


def test_a_category_only_pending_never_carries_onto_a_charge_the_user_noted(pending_carry):
    # Deliberate: a charge that already holds an edit is claimed, like a charge the user filed.
    user_noted = _row("posted-n", "2026-06-11", status="posted", notes="mine")
    assert pending_carry.find_carry_twin(_pending(category="groceries"), [user_noted], IS_UNFILED) is None


# [A1] (P0) the shared modules import with ONLY shared/ on the path — no webhook module
# (banksync / reconcile) and no boto3. The sync-trigger function ships shared/ alone, so a
# hidden lambda/ import would ImportError the hourly job at cold start.
@pytest.mark.parametrize("module", ["pending_carry", "merchant", "spend"])
def test_shared_carry_modules_import_with_only_the_layer_on_the_path(module):
    probe = (
        "import sys; "
        f"sys.path[:] = [p for p in sys.path if 'site-packages' not in p]; import {module}; "
        "print(sorted(m for m in ('banksync', 'reconcile', 'age_out', 'boto3', 'repository_base') "
        "if m in sys.modules))"
    )
    result = subprocess.run([sys.executable, "-S", "-c", probe], cwd=_SHARED_DIR,
                            capture_output=True, text=True, check=False)

    assert result.returncode == 0, result.stderr
    assert result.stdout.strip() == "[]"


# [A2] (P0) load_is_unfiled uses the REAL taxonomy rule: a taxonomy id is filed, a raw bank
# enum and None are unfiled, "income" is always filed.
def test_load_is_unfiled_reads_the_taxonomy(pending_carry):
    is_unfiled = pending_carry.load_is_unfiled(FakeCategoryRepo(["groceries"]))

    assert is_unfiled("groceries") is False
    assert is_unfiled("FOOD_AND_DRINK") is True
    assert is_unfiled(None) is True
    assert is_unfiled("income") is False


# [A3] (P0) load_is_unfiled RAISES on a taxonomy read error — each caller picks how to fail
# (the age-out fails open, the mirror will skip). Swallowing it here would hide the outage.
def test_load_is_unfiled_raises_when_the_taxonomy_is_unreadable(pending_carry):
    with pytest.raises(RuntimeError):
        pending_carry.load_is_unfiled(FakeCategoryRepo([], error=RuntimeError("taxonomy read boom")))


# [A5] (P0) the ±3-day window is symmetric through find_carry_twin: a twin dated 3 days
# BEFORE the pending matches, 4 days before does not.
def test_find_carry_twin_accepts_a_twin_three_days_earlier_but_not_four(pending_carry):
    is_unfiled = pending_carry.load_is_unfiled(FakeCategoryRepo(["groceries"]))
    pending = _pending(notes="gift")
    three_before = _row("posted-3", "2026-06-07", status="posted")
    four_before = _row("posted-4", "2026-06-06", status="posted")

    assert pending_carry.find_carry_twin(pending, [three_before], is_unfiled) is three_before
    assert pending_carry.find_carry_twin(pending, [four_before], is_unfiled) is None


# [A6] (P1) nothing to match against, or a pending missing its date / amount → no twin, never
# a crash.
def test_find_carry_twin_with_no_rows_or_missing_fields_finds_nothing(pending_carry):
    is_unfiled = pending_carry.load_is_unfiled(FakeCategoryRepo(["groceries"]))
    twin = _row("posted-1", "2026-06-11", status="posted")

    assert pending_carry.find_carry_twin(_pending(notes="gift"), [], is_unfiled) is None
    assert pending_carry.find_carry_twin(_pending(notes="gift", date=None), [twin], is_unfiled) is None
    no_amount = _pending(notes="gift")
    no_amount["amount"] = None
    assert pending_carry.find_carry_twin(no_amount, [twin], is_unfiled) is None


# [A8] (P0) the carry with the taxonomy check: a raw bank category on the pending never
# replaces the twin's category, and counts_to_budget follows whatever category landed
# (home-loan account → never counts).
# The budget flag is recomputed from the twin's own account: a home-loan charge never counts.
@pytest.mark.parametrize("account_id, counts", [(_ACCOUNT, True), ("up-homeloan", False)])
def test_carry_keeps_the_twin_category_over_a_raw_pending_category(pending_carry, account_id, counts):
    is_unfiled = pending_carry.load_is_unfiled(FakeCategoryRepo(["groceries"]))
    pending = _pending(category="TRANSFER_OUT", notes="gift")
    twin = _row("posted-1", "2026-06-11", status="posted", category="FOOD_AND_DRINK",
                filed_by_rule="rule-9", account_id=account_id)

    carried = pending_carry.with_carried_category(twin, pending, is_unfiled=is_unfiled)

    assert carried["category"] == "FOOD_AND_DRINK"
    assert carried["filed_by_rule"] == "rule-9"
    assert carried["notes"] == "gift"
    assert carried["counts_to_budget"] is counts


# [A3] (P1) WHIT-666 boundary: only a REAL note / tag / exclusion claims a settled charge. An
# empty note, an empty tag list or budget_excluded=False (a cleared edit, or a fresh bank row)
# must leave the charge a candidate, or ordinary carries silently stop.
@pytest.mark.parametrize(
    "cleared", [{"notes": ""}, {"tags": []}, {"budget_excluded": False}, {"notes": None, "tags": None}],
)
def test_a_settled_charge_with_only_cleared_edit_fields_is_still_a_twin(pending_carry, cleared):
    is_unfiled = pending_carry.load_is_unfiled(FakeCategoryRepo(["groceries"]))
    twin = _row("posted-1", "2026-06-11", status="posted", **cleared)

    assert pending_carry.find_carry_twin(_pending(notes="gift"), [twin], is_unfiled) is twin
    assert pending_carry.find_carry_twin(_pending(category="groceries"), [twin], is_unfiled) is twin
