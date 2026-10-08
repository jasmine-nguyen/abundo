"""WHIT-663 slice 1 QA — adversarial edges for shared/pending_carry.py and the helpers it now
owns: the real taxonomy check, both directions of the date window, missing fields, and the
layer being self-contained so the hourly sync-trigger function (shared/ only) can import it.
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


def _row(sk, date_str, *, status, amount="-5.50", category=None, **fields):
    row = {
        "sk": sk, "transaction_id": sk, "account_id": _ACCOUNT, "date": date_str,
        "amount": Decimal(amount), "merchant_name": _SHOP, "description": _SHOP,
        "status": status, "category": category, "counts_to_budget": True,
    }
    row.update(fields)
    return row


def _pending(**fields):
    return _row("pending-1", "2026-06-10", status="pending", **fields)


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


# [A4] (P0) the edit checks with the real taxonomy: income is a user-set category (edited +
# filed), an empty-tags list / False exclusion / empty note is NOT an edit.
@pytest.mark.parametrize(
    "fields, user_edited, filed",
    [
        ({"category": "income"}, True, True),
        ({"category": "income", "filed_by_rule": "rule-1"}, False, True),
        ({"notes": "", "tags": [], "budget_excluded": False}, False, False),
        ({"category": "FOOD_AND_DRINK", "notes": "gift"}, True, True),
    ],
)
def test_edit_checks_with_the_real_taxonomy(pending_carry, fields, user_edited, filed):
    is_unfiled = pending_carry.load_is_unfiled(FakeCategoryRepo(["groceries"]))
    pending = _pending(**fields)

    assert pending_carry.is_user_edited(pending, is_unfiled) is user_edited
    assert pending_carry.is_filed(pending, is_unfiled) is filed


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


# [A7] (P0) the twin rule uses the posted row's category through the real taxonomy: a posted
# row filed to "income" by the user is never overwritten.
def test_a_user_income_twin_is_never_a_candidate(pending_carry):
    is_unfiled = pending_carry.load_is_unfiled(FakeCategoryRepo(["groceries"]))
    pending = _pending(category="groceries")
    income_twin = _row("posted-1", "2026-06-11", status="posted", category="income")

    assert pending_carry.find_carry_twin(pending, [income_twin], is_unfiled) is None


# [A8] (P0) the carry with the taxonomy check: a raw bank category on the pending never
# replaces the twin's category, and counts_to_budget follows whatever category landed
# (home-loan account → never counts).
def test_carry_keeps_the_twin_category_over_a_raw_pending_category(pending_carry):
    is_unfiled = pending_carry.load_is_unfiled(FakeCategoryRepo(["groceries"]))
    pending = _pending(category="TRANSFER_OUT", notes="gift")
    twin = _row("posted-1", "2026-06-11", status="posted", category="FOOD_AND_DRINK",
                filed_by_rule="rule-9")

    carried = pending_carry.with_carried_category(twin, pending, is_unfiled=is_unfiled)

    assert carried["category"] == "FOOD_AND_DRINK"
    assert carried["filed_by_rule"] == "rule-9"
    assert carried["notes"] == "gift"
    assert carried["counts_to_budget"] is True


def test_carry_recomputes_budget_flag_off_for_the_home_loan(pending_carry):
    is_unfiled = pending_carry.load_is_unfiled(FakeCategoryRepo(["groceries"]))
    pending = _pending(category="groceries")
    twin = _row("posted-1", "2026-06-11", status="posted", account_id="up-homeloan")

    carried = pending_carry.with_carried_category(twin, pending, is_unfiled=is_unfiled)

    assert carried["category"] == "groceries"
    assert carried["counts_to_budget"] is False


# [A9] (P0) counts_to_budget, now in shared/spend.py: home loan never counts, a transfer /
# loan-payment category never counts, anything else (including no category) does.
@pytest.mark.parametrize(
    "account_id, category, expected",
    [
        ("up-homeloan", "groceries", False),
        ("anz-spending", "TRANSFER_IN", False),
        ("anz-spending", "TRANSFER_OUT", False),
        ("anz-spending", "LOAN_PAYMENTS", False),
        ("anz-spending", "groceries", True),
        ("anz-spending", None, True),
        ("anz-spending", "income", True),
    ],
)
def test_counts_to_budget_in_shared_spend(shared, account_id, category, expected):
    assert shared.spend.counts_to_budget(account_id, category) is expected


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
