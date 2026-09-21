"""Derive a display-friendly merchant name from BankSync's raw description.

ANZ (via BankSync/Fiskil) formats descriptions as fixed-width columns. The pending
merchant column is 25 chars wide; the posted `merchantName` field is 26 — a name of
26+ chars is cut at a different point on the two sides and cannot match (the safe
direction; the age-out sweep reaps the leftover duplicate).

    pending:  "POS AUTHORISATION<pad><merchant 25w><location><pad>AU"
    posted:   "<merchant 26w><location>"   (+ merchantName = the 26-wide merchant column)

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
from typing import Optional

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


# --- Positional read of the pending merchant column -------------------------
# `clean_merchant` above reads the column by splitting on whitespace, which is enough
# for display but FAILS when the merchant fills the column and fuses onto the suburb.
# Reconciliation can't tolerate that (a wrong read deletes a real row), so it reads the
# same column by POSITION instead. Both live here so ANZ's layout has one owner.

# An ANZ PENDING descriptor: the "POS AUTHORISATION" column, then padding before the
# merchant column. The padding group matches whatever the bank actually sent rather than
# pinning today's nine spaces — the slice below is taken RELATIVE to where this match
# ends, so a padding change shifts the cut with it instead of misaligning it, up to the
# column width (past that a run of padding is indistinguishable from a blank column, and
# the guard below stops reading rather than guess).
# The `{2,}` is load-bearing SAFETY, not parsing convenience: one space is not column
# padding, and treating it as such would route a real ANZ row to the looser gate below.
_ANZ_PENDING_PREFIX = re.compile(r"^POS AUTHORISATION(?P<pad>\s{2,})", re.IGNORECASE)
# Width of ANZ's fixed-width merchant column on a PENDING description, measured against
# live data (every pending in the table reconstructs as: 25-wide merchant, 13-wide
# suburb, then "AU"). NOT the same as the POSTED `merchantName` field, which is 26 wide,
# so ANY merchant whose name runs to 26 characters or more is cut at a different point on
# the two sides and can never match. That is the safe direction (a leftover duplicate the
# age-out sweep reaps), never a wrong merge.
_MERCHANT_COLUMN_WIDTH = 25


def is_anz_pending(description: Optional[str]) -> bool:
    """Whether `description` is an ANZ fixed-width PENDING descriptor. Distinct from
    `pending_merchant_column(...) is not None`: an ANZ row with a blank/unreadable column
    is still ANZ-shaped, and a caller must be able to tell that apart from a non-ANZ row
    (the two demand opposite fallbacks)."""
    return _ANZ_PENDING_PREFIX.match(description or "") is not None


def pending_merchant_column(description: Optional[str]) -> Optional[str]:
    """ANZ's fixed-width merchant column, sliced out of a PENDING description by
    POSITION — the whole point being that position survives what whitespace cannot.

    `clean_merchant` reads the same column by splitting on runs of 2+ spaces, which
    fails exactly when the merchant FILLS the column: it then runs into the suburb with
    no separator ("SQ *KKV INTERNATIONAL PTY" + "Sunshine" -> "PTYSunshine"), and the
    stored merchant name is corrupt. A positional slice is immune to that.

    None when the description is not an ANZ pending descriptor (an Up row, or a legacy
    row) or when the column is blank — both must fall through to the name-based gate,
    never merge on nothing."""
    text = description or ""
    prefix = _ANZ_PENDING_PREFIX.match(text)
    if prefix is None:
        return None
    # A blank merchant column is indistinguishable from padding, so the greedy match runs
    # straight through it and the slice would start at the SUBURB — handing back a suburb
    # as if it were a merchant, which is the direction that deletes a row. Padding as wide
    # as the column itself is that case, and there is no merchant to read.
    if len(prefix.group("pad")) >= _MERCHANT_COLUMN_WIDTH:
        return None
    column = text[prefix.end():prefix.end() + _MERCHANT_COLUMN_WIDTH]
    return column if column.strip() else None
