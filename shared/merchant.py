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


# --- Matching a posted merchant to a pending row (WHIT-336) --------------------
# Moved from the webhook's reconcile.py (WHIT-663) so the hourly pending mirror can use the
# same gate as settlement and the age-out rescue.

_WORD = re.compile(r"[a-z0-9]+")


def _words(s: Optional[str]) -> list[str]:
    """Lowercase alphanumeric words of a string. BankSync descriptor noise
    ('POS AUTHORISATION', 'DD *', country/store codes) splits out on the
    non-alphanumeric boundaries, leaving comparable merchant words."""
    return _WORD.findall((s or "").lower())


def _merchant_in_description(merchant: str, description: str) -> bool:
    """Whether every word of `merchant` appears as a CONSECUTIVE run inside
    `description`'s words. Word-level (not raw substring) so a short or adjacent
    token can't over-match: 'coles' is NOT a word in "nicole's cafe", 'bp' is NOT a
    word in 'bpay' — while a multi-word merchant ('DOORDASH XUANBANHC') still matches
    a pending's raw "POS AUTHORISATION  DD *DOORDASH XUANBANHC ..." description.
    Empty merchant -> False (never over-match on an underivable token)."""
    m = _words(merchant)
    if not m:
        return False
    d = _words(description)
    return any(d[i:i + len(m)] == m for i in range(len(d) - len(m) + 1))


def _same_cleaned_merchant(posted_merchant: str, pending_merchant: str) -> bool:
    """Whether two ALREADY-cleaned merchant names refer to the same merchant. Inputs
    must have been through `clean_merchant` — banksync.normalise writes both sides that
    way — because this does NOT clean them: "COLES 0602" and "COLES" do NOT match. Only
    padding and casing are absorbed. An empty name on either side never matches.

    NOTE this is chain-wide, not storefront-wide: clean_merchant strips trailing store
    numbers and processor prefixes, so COLES 0602 and COLES 1157 are both "COLES", and
    "AMAZON RETA* AMAZON AU" and "AMAZON AU" are both "AMAZON"."""
    posted_words = _words(posted_merchant)
    return bool(posted_words) and posted_words == _words(pending_merchant)


def _merchant_gate(merchant: str, pending_merchant: str, description: str) -> Optional[str]:
    """Which branch matches a posted merchant to a pending row (WHIT-336) — "column",
    "description", "name", or None when nothing matches. The SINGLE source for both the
    match decision (`merchant_matches_pending` is a thin bool view of this) and the
    skewed-date merge log's gate= label; deriving both from this one return value is why
    they cannot drift (WHIT-338).

    Shared by every heuristic tier that matches on a merchant — tip, skewed-date,
    skewed-fee and blank-auth. They MUST share it. The tiers run tightest-first so a tighter tier always
    claims its twin before a looser one can reach it, and that ordering silently inverts
    if one tier can recognise a merchant the tiers above it cannot: the loosest tier then
    wins by default and deletes the wrong pending.

    An ANZ pending carries its merchant in a fixed-width column, so for those rows we
    read that column by position and require the two CLEANED names to be EQUAL. Equality,
    not containment: "CHEMIST WAREHOUSE" is contained in "CHEMIST WAREHOUSE DARLING", and
    those are two different stores — merging them would delete a real transaction. The
    same trap catches "McDonalds" inside "MCDONALDS SYD DOMEST" and "WOOLWORTHS" inside
    "WOOLWORTHS/330 MILLERS RD"; all three pairs are live in the table.

    Equality also replaces the prefix-tolerant matcher this used to need. That tolerance
    existed only for ANZ's column fusion, which a positional slice now removes at the
    source, and it was itself over-matching on name prefixes.

    Non-ANZ descriptions (Up rows, legacy rows) have no such column and keep the shape of
    the gate they had — two-or-more words matched against the raw description, a lone word
    additionally requiring the pending's own cleaned name to be that same word. The
    multi-word branch does lose WHIT-331's prefix tolerance along with everything else,
    which costs nothing: column fusion only happens on ANZ rows, and the loss is a miss.
    Do NOT tighten this fallback to name equality — on the live table (queried 2026-07-25)
    75 rows carry an empty merchant_name, none of them ANZ-shaped, and 108 pairs that
    reconcile today would silently stop.

    Known accepted miss: two descriptors for one merchant ("PET INSURANCE" /
    "PET INSURANCE PAYMENT", both live on 2026-07-25) do not match. Recurring direct
    debits rarely raise a card pending, and the failure direction is a leftover duplicate
    that the age-out sweep reaps — never a wrong merge.

    Deliberately NOT the fuzzy scorer the client uses for "apply to all"
    (src/context.tsx matchesRulePattern): that is tuned for recall, and on short names
    it scores COLES/MOLES at 0.80 — over its own threshold. Mis-sweeping a category is
    undoable; deleting a pending is not. Do not unify the two."""
    if is_anz_pending(description):
        column = pending_merchant_column(description)
        # An ANZ row with no readable column has nothing to compare, so it must REFUSE.
        # Falling through to the gates below would hand the row to a containment search
        # over the whole description — suburb included — and a merchant named after a
        # place would match it. "Unreadable" is not "not ANZ".
        if column is not None and _same_cleaned_merchant(merchant, clean_merchant(column)):
            return "column"
        return None
    if len(_words(merchant)) >= 2:
        return "description" if _merchant_in_description(merchant, description) else None
    if (_same_cleaned_merchant(merchant, pending_merchant)
            and _merchant_in_description(merchant, description)):
        return "name"
    return None


def merchant_matches_pending(merchant: str, pending_merchant: str, description: str) -> bool:
    """Whether a posted merchant names the same shop as a pending row — the bool view of
    `_merchant_gate` (which branch matched). Shared by the tip, skewed-date, skewed-fee
    and blank-auth tiers; see `_merchant_gate` for the full rationale."""
    return _merchant_gate(merchant, pending_merchant, description) is not None
