"""Loan-facts storage: the user-entered home-loan facts no bank feed provides
(original loan amount, property value, LVR, interest rate, scheduled + extra
repayment), kept as a single DynamoDB config item.

Deliberately NOT seeded (unlike PayCycleRepository): the app requires the user to
enter these, and shows a friendly "set this up" state until they do — so
`get_loanfacts` returns None while unset rather than fabricating defaults. Whole
object is replaced on each save (one settings object, single writer), so a plain
put_item overwrite is enough — no version guard.
"""

from decimal import Decimal
from typing import Optional

from repository_base import RepositoryBase, db_errors

_LOANFACTS_KEY = {"pk": "LOANFACTS", "sk": "LOANFACTS"}

# The six user-entered fields, stored/returned as JS-friendly numbers.
LOANFACTS_FIELDS = ("original", "homeValue", "lvr", "ratePct", "baseRepay", "extra")


def _to_api(item: dict) -> dict:
    """The stored item as the API shape: the six fields as floats (stored as Decimal),
    payoffGoalDate (WHIT-126) and depositTarget (WHIT-378), each None when absent (legacy
    rows saved before the field existed — no migration)."""
    result = {field: float(item[field]) for field in LOANFACTS_FIELDS}
    result["payoffGoalDate"] = item.get("payoffGoalDate")
    deposit_target = item.get("depositTarget")
    result["depositTarget"] = float(deposit_target) if deposit_target is not None else None
    return result


class LoanFactsRepository(RepositoryBase):
    """Stores the user's home-loan facts as a single config item at
    pk=sk="LOANFACTS". `get_loanfacts` returns the six fields (or None if the user
    hasn't saved them yet); `set_loanfacts` overwrites the whole object."""

    def get_loanfacts(self) -> Optional[dict]:
        """Return {field: float, ..., "payoffGoalDate": str|None, "depositTarget": float|None} or None if unset.

        Only the known fields are surfaced (pk/sk/version stay internal), so the
        client never sees storage keys. The six numeric fields are normalised to
        float (they are stored as Decimal) so the handler serialises them as JSON
        numbers. payoffGoalDate (WHIT-126) is an optional ISO string, or None —
        rows saved before it existed simply lack the attribute, so `.get` yields
        None (back-compat, no migration).
        """
        with db_errors("read loan facts"):
            item = self._get_table().get_item(Key=_LOANFACTS_KEY).get("Item")
        if item is None:
            return None
        return _to_api(item)

    def set_loanfacts(
        self,
        original: Decimal,
        homeValue: Decimal,
        lvr: Decimal,
        ratePct: Decimal,
        baseRepay: Decimal,
        extra: Decimal,
        payoffGoalDate: Optional[str] = None,
        depositTarget: Optional[Decimal] = None,
    ) -> dict:
        """Overwrite the whole loan-facts object and return it.

        The whole item is replaced on every save, so writing an optional attribute
        (payoffGoalDate / depositTarget) only when set means clearing it (None) drops
        the attribute cleanly — no stale value survives a clear (WHIT-126, WHIT-378).
        """
        item = {
            **_LOANFACTS_KEY,
            "original": original,
            "homeValue": homeValue,
            "lvr": lvr,
            "ratePct": ratePct,
            "baseRepay": baseRepay,
            "extra": extra,
        }
        if payoffGoalDate is not None:
            item["payoffGoalDate"] = payoffGoalDate
        if depositTarget is not None:
            item["depositTarget"] = depositTarget
        with db_errors("set loan facts"):
            self._get_table().put_item(Item=item)
        return _to_api(item)
