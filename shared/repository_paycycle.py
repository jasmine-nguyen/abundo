"""Pay-cycle storage: the user's window length + payday last_pay_date as a single
DynamoDB config item (one settings object, replaced whole under the version guard)."""

from decimal import Decimal

from constants import DEFAULT_PAYCYCLE
from repository_base import RepositoryBase

_PAYCYCLE_KEY = {"pk": "PAYCYCLE", "sk": "PAYCYCLE"}


class PayCycleRepository(RepositoryBase):
    """Stores the user's pay cycle as a single DynamoDB config item.

    The item at pk=sk="PAYCYCLE" holds a `length` (int days: 7/14/30) and an
    `last_pay_date` (ISO date string of a real past payday), plus a numeric `version`
    for optimistic locking. Unlike BudgetRepository there is no per-key `items`
    map — the pay cycle is one small settings object, so a write REPLACES both
    fields together under the version guard. Seeds to DEFAULT_PAYCYCLE so a fresh
    install reads a valid cycle before the user has set one.
    """

    _config_key = _PAYCYCLE_KEY
    _config_label = "pay cycle"

    def _seed_fields(self) -> dict:
        """Seed to the deterministic DEFAULT_PAYCYCLE, so a lost seeding race is harmless."""
        return {
            "length": Decimal(DEFAULT_PAYCYCLE["length"]),
            "last_pay_date": DEFAULT_PAYCYCLE["last_pay_date"],
        }

    def get_paycycle(self) -> dict:
        """Return the stored {"length": int, "last_pay_date": str}, seeding the default on
        first read. `length` is normalised back to a plain int (DynamoDB stores it
        as a Decimal) so the handler serialises it as a JSON integer."""
        item = self._get_config()
        if item is None:
            self._ensure_seeded()
            item = self._get_config()  # re-read so a concurrent set is reflected
        return {"length": int(item["length"]), "last_pay_date": item["last_pay_date"]}

    def set_paycycle(self, length: int, last_pay_date: str) -> dict:
        """Set (replace) the pay cycle under an optimistic-lock guard.

        Both fields are written together — the pay cycle is one object, not a map
        of independent keys — so a concurrent length change and last_pay_date change can't
        silently interleave. Validation (allowed length, parseable past-date last_pay_date)
        is the handler's job; this just persists. Raises VersionConflictError if it
        can't converge within the retry budget.
        """
        def build(item):
            update = {
                "expression": "SET #length = :length, #last_pay_date = :last_pay_date, #v = :next",
                "names": {"#length": "length", "#last_pay_date": "last_pay_date"},
                "values": {":length": Decimal(length), ":last_pay_date": last_pay_date},
            }
            return update, {"length": length, "last_pay_date": last_pay_date}

        return self._versioned_update(build, action="set pay cycle")
