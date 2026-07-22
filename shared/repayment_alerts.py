"""Home-loan repayment push copy (WHIT-15 / WHIT-313).

The instant repayment push now fires from the direct Up webhook
(``lambda/up_webhook.py``); this module owns only the shared push wording, so there
is one source of truth for it.

Copy note: the credit is the GROSS repayment (~$3,667), of which only the principal
actually comes off the balance (the rest posts as a separate interest debit). So the
copy says "put $X toward the mortgage" — honest for the gross amount — never
"knocked $X off" (which would overstate the balance reduction).
"""

from decimal import Decimal

# Push copy. {amount} = the repayment amount, whole dollars with thousands separators.
_TITLE = "Nice one! Another chunk down"
_BODY = "You just put ${amount} toward the mortgage. You're crushing it — keep building! \U0001f4aa"


def build_repayment_push(amount: Decimal) -> tuple[str, str]:
    """The (title, body) for a home-loan repayment push. `amount` renders as whole
    dollars with thousands separators, e.g. Decimal('3667.50') -> '$3,668'."""
    return _TITLE, _BODY.format(amount=f"{amount:,.0f}")
