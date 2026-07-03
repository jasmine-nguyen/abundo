"""Derive a display-friendly merchant name from BankSync's raw description.

ANZ (via BankSync/Fiskil) formats descriptions as fixed-width columns:

    pending:  "POS AUTHORISATION<pad><merchant 25w><location><pad>AU"
    posted:   "<merchant 25w><location>"   (+ merchantName = the merchant column)

`merchantName` only arrives on POSTED rows (and is just the merchant column,
space-padded, still carrying processor prefixes / store numbers). PENDING rows
carry no `merchantName` and lead with the useless "POS AUTHORISATION" column, so
every pending transaction renders identically. `clean_merchant` extracts the
merchant.

Deliberately conservative:
- never returns empty (falls back to the raw description),
- leaves casing exactly as the bank sent it — real data is mixed-case
  (WOOLWORTHS, DiDiMobility, The New York Times), so title-casing would mangle
  names.

Known limit: the bank truncates some names mid-word at the 25-char column cut
(e.g. "KFL SUPERMARKET BRAYBR", "MUJI RETAIL (AUSTRAL") — that data is lost
upstream and cannot be recovered here.
"""

import re

# The pending-auth prefix column, followed by padding before the merchant column.
_AUTH_PREFIX = re.compile(r"^POS AUTHORISATION\s+", re.IGNORECASE)

# Columns are separated by runs of 2+ spaces (fixed-width padding); the merchant
# is the first column, with location/country following.
_COLUMNS = re.compile(r"\s{2,}")

# Payment-processor prefixes seen in real ANZ data (the "*" is the tell):
# SQ * (Square), DD * (DoorDash), PAYPAL *, ZLR*, AMAZON RETA*.
_PROCESSOR_PREFIX = re.compile(r"^(?:SQ|DD|PAYPAL|ZLR|AMAZON RETA)\s*\*\s*", re.IGNORECASE)

# Trailing country code, then a trailing store number (e.g. "COLES 0602" -> "COLES").
_TRAILING_COUNTRY = re.compile(r"\s+AU$")
_TRAILING_STORE_NUM = re.compile(r"\s+\d{3,}$")


def clean_merchant(description: str, merchant_name: str = "") -> str:
    """Return a display merchant for a BankSync row. See module docstring."""
    raw = description or ""
    # Posted rows give the merchant column as merchantName; pending rows don't, so
    # fall back to the description (whose leading "POS AUTHORISATION" we strip).
    source = (merchant_name or "").strip() or raw
    source = _AUTH_PREFIX.sub("", source).strip()
    if not source:
        return raw.strip()

    # First whitespace-delimited column is the merchant; drop location/country.
    merchant = _COLUMNS.split(source)[0]
    merchant = _PROCESSOR_PREFIX.sub("", merchant)
    merchant = _TRAILING_COUNTRY.sub("", merchant)
    merchant = _TRAILING_STORE_NUM.sub("", merchant)
    merchant = merchant.strip()

    return merchant or raw.strip()
