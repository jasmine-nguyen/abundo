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
from typing import Any, Optional

import boto3
from botocore.exceptions import ClientError

from repository_base import REGION_NAME, TABLE_NAME, handle_database_error

_LOANFACTS_KEY = {"pk": "LOANFACTS", "sk": "LOANFACTS"}

# The six user-entered fields, stored/returned as JS-friendly numbers.
LOANFACTS_FIELDS = ("original", "homeValue", "lvr", "ratePct", "baseRepay", "extra")


class LoanFactsRepository:
    """Stores the user's home-loan facts as a single config item at
    pk=sk="LOANFACTS". `get_loanfacts` returns the six fields (or None if the user
    hasn't saved them yet); `set_loanfacts` overwrites the whole object."""

    def __init__(self) -> None:
        self._dynamodb = None
        self._table = None

    def _get_table(self) -> Any:
        if self._table is None:
            self._dynamodb = boto3.resource("dynamodb", region_name=REGION_NAME)
            self._table = self._dynamodb.Table(TABLE_NAME)
        return self._table

    def get_loanfacts(self) -> Optional[dict]:
        """Return {field: float, ...} for the six fields, or None if unset.

        Only the six known fields are surfaced (pk/sk/version stay internal), so
        the client never sees storage keys. Values are normalised to float (they
        are stored as Decimal) so the handler serialises them as JSON numbers.
        """
        try:
            item = self._get_table().get_item(Key=_LOANFACTS_KEY).get("Item")
        except ClientError as e:
            handle_database_error(e, "read loan facts")
        if item is None:
            return None
        return {field: float(item[field]) for field in LOANFACTS_FIELDS}

    def set_loanfacts(
        self,
        original: Decimal,
        homeValue: Decimal,
        lvr: Decimal,
        ratePct: Decimal,
        baseRepay: Decimal,
        extra: Decimal,
    ) -> dict:
        """Overwrite the whole loan-facts object and return it (as floats)."""
        try:
            self._get_table().put_item(
                Item={
                    **_LOANFACTS_KEY,
                    "original": original,
                    "homeValue": homeValue,
                    "lvr": lvr,
                    "ratePct": ratePct,
                    "baseRepay": baseRepay,
                    "extra": extra,
                }
            )
        except ClientError as e:
            handle_database_error(e, "set loan facts")
        return {
            "original": float(original),
            "homeValue": float(homeValue),
            "lvr": float(lvr),
            "ratePct": float(ratePct),
            "baseRepay": float(baseRepay),
            "extra": float(extra),
        }
