"""One shared copy of "did the user edit this pending?", the settled-twin matching and the
carry-across (WHIT-663). Used by the 10-day age-out rescue (lambda/age_out.py, WHIT-511) and
the webhook's settlement (lambda/reconcile.py); reachable from the hourly pending mirror too,
so the jobs can never disagree about which pendings hold a user's edit.
"""

from datetime import date
from typing import Callable, Optional

import rule_engine
from constants import CARRY_DATE_SKEW_DAYS
from merchant import merchant_matches_pending
from models import Transaction
from spend import counts_to_budget


def load_is_unfiled(category_repo) -> Callable[[Optional[str]], bool]:
    """The "is this category unfiled" test built from the user's taxonomy. A bank charge carries
    a raw category that isn't in the taxonomy, so only this test — not category-presence — tells
    a real filing from the bank default. Raises when the taxonomy can't be read; each caller
    decides how to fail."""
    taxonomy_ids = {category["id"] for category in category_repo.list_categories()}
    return lambda category: rule_engine.is_unfiled_category(category, taxonomy_ids)


def category_is_user_set(pending: dict, is_unfiled) -> bool:
    """Whether a USER (or the bank) set this pending's category, not a rule (WHIT-553). A real,
    filed category with NO filed_by_rule stamp is user/bank-owned. Only such a pending may
    override a RULE-filed settled twin — a user override beats a rule's guess. A rule-stamped
    pending, or one filed only by notes/tags/exclusion, must never override a rule's category."""
    return not is_unfiled(pending.get("category")) and not pending.get("filed_by_rule")


def _has_user_fields(row: dict) -> bool:
    return bool(row.get("notes") or row.get("tags") or row.get("budget_excluded"))


def _same_user_fields(row_a: dict, row_b: dict) -> bool:
    return all(
        (row_a.get(field_name) or None) == (row_b.get(field_name) or None)
        for field_name in ("notes", "tags", "budget_excluded")
    )


def is_user_edited(pending: dict, is_unfiled) -> bool:
    """Whether the user edited this pending — their own category, or a note/tag/exclusion they
    set. A rule's category alone is not a user edit."""
    return category_is_user_set(pending, is_unfiled) or _has_user_fields(pending)


def is_filed(pending: dict, is_unfiled) -> bool:
    """`is_user_edited` plus rule-filed: any real category (user- or rule-set), or a
    note/tag/exclusion. These are the fields with_carried_category carries, so losing any of
    them to the age-out reap is the harm WHIT-511 fixes."""
    return not is_unfiled(pending.get("category")) or _has_user_fields(pending)


def _within_days(date_a: str | None, date_b: str | None, days: int) -> bool:
    """Whether two bare "YYYY-MM-DD" dates are at most `days` apart (symmetric). A missing or
    unparseable date is never within — the rescue then finds no twin and reaps as today."""
    if not date_a or not date_b:
        return False
    try:
        parsed_a = date.fromisoformat(date_a[:10])
        parsed_b = date.fromisoformat(date_b[:10])
    except ValueError:
        return False
    return abs((parsed_a - parsed_b).days) <= days


def _is_carry_twin(pending: dict, posted: dict) -> bool:
    """Whether `posted` is strictly the settled twin of `pending` — exact amount, same shop,
    dates within the window.

    Amount must match EXACTLY. The reconciler pairs a tip-adjusted settlement via its own tip
    tier (reconcile._is_larger_within), but the rescue deliberately does NOT — carrying a
    user's category is kept strict, so the amount gate is not widened to a tip range (nor
    mirrors the skewed-fee tier, WHIT-653). The
    accepted cost: a tipped charge (dining/rideshare) that missed every reconcile tier is
    not rescued at reap time. This is a narrow miss (it already had to miss the tip tier), and
    the strict gate is the safety Jasmine chose over widening the match (WHIT-511)."""
    if pending.get("amount") != posted.get("amount"):
        return False
    if not merchant_matches_pending(
        posted.get("merchant_name") or "",
        pending.get("merchant_name") or "",
        pending.get("description") or "",
    ):
        return False
    return _within_days(pending.get("date"), posted.get("date"), CARRY_DATE_SKEW_DAYS)


def find_carry_twin(pending: dict, posted_rows: list[dict], is_unfiled) -> dict | None:
    """The settled twin to carry a filed pending's fields onto, or None.

    Candidates are posted rows that are NOT user-owned: unfiled OR rule-filed (WHIT-553). A
    user-filed twin (real category, no filed_by_rule stamp) is never a candidate, so a manual
    filing on the twin is never overwritten. A user-set-category pending may override a
    rule-filed twin; anything else (a rule-stamped pending, or one filed only by
    notes/tags/exclusion) may only carry onto an UNFILED twin — a rule never overrides another
    rule's category. A twin that already holds a note, tags or exclusion (carried earlier, or
    set by the user) is user-owned too and never a candidate, so a later pending can't
    overwrite it (WHIT-666) — unless those fields already equal the pending's own: repeating
    the same carry changes nothing, and lets a retry finish after a failed delete.

    STRICT: same exact amount, same shop (the reconcile merchant gate), dated within
    CARRY_DATE_SKEW_DAYS. Exactly one match carries; zero OR an ambiguous tie (≥2) carries
    nothing — a wrong carry is worse than a missed one (WHIT-511, Jasmine's locked choice)."""
    candidates = [posted for posted in posted_rows
                  if not _has_user_fields(posted) or _same_user_fields(pending, posted)]
    if category_is_user_set(pending, is_unfiled):
        eligible = [posted for posted in candidates
                    if is_unfiled(posted.get("category")) or posted.get("filed_by_rule")]
    else:
        eligible = [posted for posted in candidates if is_unfiled(posted.get("category"))]
    matches = [posted for posted in eligible if _is_carry_twin(pending, posted)]
    if len(matches) == 1:
        return matches[0]
    return None


def find_identical_copy(pending: dict, live_pendings: list[dict]) -> dict | None:
    """A live pending that is the same purchase as `pending` and already holds its category and
    user fields, or None (WHIT-678). Deleting `pending` then loses nothing, so any match will do."""
    for row in live_pendings:
        if (_is_carry_twin(pending, row)
                and row.get("category") == pending.get("category")
                and _same_user_fields(pending, row)):
            return row
    return None


def with_carried_category(
    posted_txn: Transaction, source_row: dict, *,
    is_unfiled: Optional[Callable[[Optional[str]], bool]] = None,
) -> Transaction:
    """A copy of the posted txn with the user-owned fields — `category`, `notes`,
    `tags` and `budget_excluded` — carried from `source_row` (the matched pending
    / existing posted) when that row has them. Falsy/absent -> keep the posted
    txn's own value, so a cleared note/tag/override never overwrites a real one.
    (Named for `category`, its original and still-primary carried field; notes/
    tags ride along so a note on a pending charge survives settlement — WHIT-275;
    budget_excluded rides along so a "mark as transfer" override survives it —
    WHIT-296.)

    is_unfiled (WHIT-545): on a settlement-style carry the caller passes the taxonomy
    check. A source category it reports UNFILED (a raw bank enum) never overrides the
    posted's own — so a stored raw category can't clobber a rule-fill — and
    counts_to_budget is recomputed from whichever category actually lands. Absent
    keeps the old behaviour byte-identical."""
    carried = posted_txn.copy()
    carried_category = False
    for field_name in ("category", "notes", "tags", "budget_excluded"):
        value = source_row.get(field_name)
        if not value:
            continue
        if field_name == "category":
            if is_unfiled is not None and is_unfiled(value):
                continue  # WHIT-545: a raw unfiled stored category never clobbers a rule-fill
            carried_category = True
        carried[field_name] = value
    # Carry the rule stamp in lockstep with the category (WHIT-536): whoever owns the
    # category owns the stamp. When the source category was carried, take its stamp too —
    # or clear it when the source was hand-filed and has none, so the posted's own stamp
    # doesn't wrongly persist. If the posted kept its own category, its own stamp stands.
    if carried_category:
        source_stamp = source_row.get("filed_by_rule")
        if source_stamp:
            carried["filed_by_rule"] = source_stamp
        else:
            carried.pop("filed_by_rule", None)
    # WHIT-545: on a settlement-style carry, recompute the budget flag so it always
    # matches the category that landed (as file_charge does on first filing).
    if is_unfiled is not None:
        carried["counts_to_budget"] = counts_to_budget(
            carried.get("account_id"), carried.get("category")
        )
    return carried
