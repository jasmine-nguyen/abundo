"""Home-loan repayment push notifications on the webhook write path (WHIT-15).

When the BankSync webhook ingests a POSTED home-loan repayment (a credit landing on
the up-homeloan account), send one encouraging Expo push — "you just put $X toward
the mortgage". Fires on EVERY qualifying repayment, scheduled or extra.

Best-effort at the call site (a failure never breaks the transaction write), it
mirrors budget_alerts' shape but is far simpler: the repayment amount is already in
the just-normalised transaction, so there's no before/after snapshot — a single
post-write pass over the batch does it.

Detection reuses the single source of truth for "is this the home loan"
(HOMELOAN_ACCOUNT_ID) plus the same repayment identity the read API's get_repayment
uses (a positive TRANSFER_INCOMING credit on that account, WHIT-115), so the trigger
can't drift from the budget classification (WHIT-50) or the last-repayment card.

Only POSTED rows fire: at settlement BankSync reissues the credit under a NEW id with
no link to the pending leg, so firing on pending too would double-notify one repayment.
The posted id is stable across re-syncs, so a per-id marker (NotifyRepository) dedupes
a re-ingest to one push. Tiny "OHA test" repayments ($1-$5) are skipped by a
MIN_REPAYMENT_NOTIFY floor.

Copy note: the credit is the GROSS repayment (~$3,667), of which only the principal
actually comes off the balance (the rest posts as a separate BANK_FEES interest
debit). So the copy uses "put $X toward the mortgage" — honest for the gross amount —
never "knocked $X off" (which would overstate the balance reduction).
"""

import logging
from decimal import Decimal

from constants import (
    HOMELOAN_ACCOUNT_ID,
    MIN_REPAYMENT_NOTIFY,
    POSTED_STATUS,
    REPAYMENT_INCOMING_TYPE,
)
from push import send_push

logger = logging.getLogger(__name__)

# Push copy. {amount} = the repayment amount, whole dollars with thousands separators.
_TITLE = "Nice one! \U0001fa93 Another chunk down"
_BODY = "You just put ${amount} toward the mortgage. You're crushing it — keep whittling! \U0001f4aa"


def is_homeloan_repayment(txn) -> bool:
    """True if `txn` is a POSTED home-loan repayment credit worth notifying.

    Keys on HOMELOAN_ACCOUNT_ID (the shared 'is this the home loan' constant, so it
    can't drift from the budget rule) + a positive TRANSFER_INCOMING credit (the same
    identity get_repayment uses). POSTED only: a pending leg settles under a new id, so
    firing on pending too would double-notify. Sub-floor test rows are excluded."""
    if txn.get("account_id") != HOMELOAN_ACCOUNT_ID:
        return False
    if txn.get("type") != REPAYMENT_INCOMING_TYPE:
        return False
    if txn.get("status") != POSTED_STATUS:
        return False
    amount = txn.get("amount")
    return amount is not None and amount >= MIN_REPAYMENT_NOTIFY


def _format_amount(amount: Decimal) -> str:
    """Whole dollars with thousands separators, e.g. Decimal('3667.50') -> '3,668'."""
    return f"{amount:,.0f}"


def notify_repayments(normalised, *, device_repo, notify_repo) -> None:
    """Send one push per qualifying home-loan repayment in the just-written batch.

    Deduped per transaction id via `notify_repo`, so a re-ingested repayment fires
    once. Short-circuits before any I/O when the batch has no repayment, and before
    sending when no device is registered. Send-then-mark: send_push never raises, so
    the only loss window is a crash between send and mark (a rare duplicate, never a
    lost push)."""
    repayments = [t for t in normalised if is_homeloan_repayment(t)]
    if not repayments:
        return

    tokens = device_repo.list_tokens()
    if not tokens:
        return

    fired = notify_repo.fired_repayments()
    for txn in repayments:
        txn_id = txn.get("transaction_id")
        if txn_id is None or txn_id in fired:
            continue
        body = _BODY.format(amount=_format_amount(txn["amount"]))
        send_push(_TITLE, body, tokens)
        notify_repo.mark_repayment_fired(txn_id)  # send-then-mark
        fired.add(txn_id)  # guard a duplicate id within the same batch
