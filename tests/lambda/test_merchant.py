"""Unit tests for clean_merchant — deriving a display merchant from BankSync's
columnar description. Strings are taken verbatim from a real ANZ payload
(2026-07-03): pending rows lead with a padded "POS AUTHORISATION" column and no
merchantName; posted rows carry merchantName (the merchant column, space-padded)."""

import pytest


def _clean(lam, description, merchant_name=""):
    return lam.merchant.clean_merchant(description, merchant_name)


# --- pending rows: description only, no merchantName -------------------------


@pytest.mark.parametrize("description, expected", [
    # merchant < 25 chars -> cleanly separated from location by the padding
    ("POS AUTHORISATION         DUONG NGUYEN AUSTRALI    Maidstone    AU", "DUONG NGUYEN AUSTRALI"),
    ("POS AUTHORISATION         KFL SUPERMARKET BRAYBR   BRAYBROOK    AU", "KFL SUPERMARKET BRAYBR"),
    ("POS AUTHORISATION         Foodie Hub Swanston      Melbourne    AU", "Foodie Hub Swanston"),
    ("POS AUTHORISATION         Circumtec                Melbourne    AU", "Circumtec"),
    # casing preserved (would be mangled by title-casing)
    ("POS AUTHORISATION         The New York Times       Sydney       AU", "The New York Times"),
    # trailing store number stripped
    ("POS AUTHORISATION         COLES 0602               MELBOURNE    AU", "COLES"),
    # processor prefix stripped
    ("POS AUTHORISATION         SQ *KKV INTERNATIONAL PTYSunshine     AU", "KKV INTERNATIONAL PTYSunshine"),
])
def test_pending_pos_authorisation(lam, description, expected):
    assert _clean(lam, description) == expected


# --- posted rows: merchantName present (the padded merchant column) ----------


@pytest.mark.parametrize("merchant_name, expected", [
    ("SQ *KKV INTERNATIONAL PTY ", "KKV INTERNATIONAL PTY"),   # Square prefix
    ("DD *DOORDASH HUTIEUGOO    ", "DOORDASH HUTIEUGOO"),       # DoorDash prefix
    ("PAYPAL *APPLE.COM/BILL    ", "APPLE.COM/BILL"),           # PayPal prefix
    ("ZLR*Seoul Garden KBBQ B   ", "Seoul Garden KBBQ B"),     # ZLR prefix (no space)
    ("AMAZON RETA* AMAZON AU    ", "AMAZON"),                   # prefix + trailing country
    ("OFFICEWORKS 0355          ", "OFFICEWORKS"),             # trailing store number
    ("GUZMAN Y GOMEZ            ", "GUZMAN Y GOMEZ"),           # plain, unchanged
    ("McDonalds 951152          ", "McDonalds"),               # casing preserved + store#
    ("DiDiMobility              ", "DiDiMobility"),             # mixed-case preserved
    ("WELLBEING CHIROPRACTIC    ", "WELLBEING CHIROPRACTIC"),   # plain uppercase
])
def test_posted_merchant_name(lam, merchant_name, expected):
    # description is ignored when a merchantName is present.
    assert _clean(lam, "IGNORED RAW DESCRIPTION", merchant_name) == expected


def test_prefers_merchant_name_over_description(lam):
    assert _clean(lam, "SOMETHING ELSE ENTIRELY", "COLES 0602          ") == "COLES"


def test_casing_is_left_untouched(lam):
    # Neither upper- nor title-cased: bank casing is authoritative.
    assert _clean(lam, "", "DiDiMobility ") == "DiDiMobility"
    assert _clean(lam, "", "WOOLWORTHS/330 MILLERS RD ") == "WOOLWORTHS/330 MILLERS RD"


# --- never-empty fallback ----------------------------------------------------


def test_empty_inputs_return_empty(lam):
    assert _clean(lam, "", "") == ""


def test_description_that_is_only_the_auth_prefix_falls_back(lam):
    # Stripping the prefix would empty it -> fall back to the raw (stripped) desc,
    # never an empty merchant.
    assert _clean(lam, "POS AUTHORISATION        ") == "POS AUTHORISATION"


def test_processor_only_falls_back_to_raw(lam):
    # If stripping leaves nothing, keep the raw rather than return "".
    assert _clean(lam, "SQ *") == "SQ *"


# --- positional column read (WHIT-337: geometry now owned here, not in repository) ---
# `clean_merchant` reads the column by whitespace; reconciliation reads it by POSITION so
# a name that fills the column and fuses onto the suburb still comes out clean. Both live
# in this module now; these pin the positional read at its new home.


def test_is_anz_pending(lam):
    f = lam.merchant.is_anz_pending
    assert f("POS AUTHORISATION         COLES 0602               MELBOURNE    AU") is True
    assert f("pos authorisation         coles 0602") is True          # case-insensitive
    assert f("COLES 0602 MELBOURNE") is False                         # a posted row
    assert f("POS AUTHORISATION COLES") is False                      # single space, not padding
    assert f("") is False
    assert f(None) is False


# The pending merchant column, sliced by POSITION. Every expected value below is also the
# value repository._pending_merchant_column returned before WHIT-337 moved it here
# (checked against `git show 39d3a1a:lambda/repository.py`), so this table doubles as the
# move-equivalence guard: any drift in the moved slice reds a row.
_PEND9 = "POS AUTHORISATION" + " " * 9
_COLUMN_CASES = [
    (None, None),
    ("", None),
    ("   ", None),
    ("COLES 0602 MELBOURNE", None),                        # a posted row, not ANZ-shaped
    ("POS AUTHORISATION", None),                           # prefix only, no padding
    ("POS AUTHORISATION ", None),                          # single space != column padding
    ("POS AUTHORISATION  ", None),                         # padding only -> blank column
    ("POS AUTHORISATION  C", "C"),                         # a 1-char column is still a column
    # the real fusion: a full 25-char column runs into the suburb; position cuts it back out
    (_PEND9 + "SQ *KKV INTERNATIONAL PTYSunshine     AU", "SQ *KKV INTERNATIONAL PTY"),
    # a short column comes back padded (clean_merchant strips that)
    (_PEND9 + "COLES 0602".ljust(25) + "MELBOURNE    AU", "COLES 0602".ljust(25)),
    (_PEND9 + " " * 25 + "MELBOURNE    AU", None),         # blank column, not the suburb
    ("POS AUTHORISATION" + " " * 40, None),                # all-blank tail
    # the cut follows the padding, so drift up to the column width still lands on the name
    ("POS AUTHORISATION" + " " * 24 + "COLES 0602".ljust(25) + "MEL", "COLES 0602".ljust(25)),
    ("POS AUTHORISATION" + " " * 25 + "COLES 0602".ljust(25) + "MEL", None),  # drift past width
    ("POS AUTHORISATION\t\tCOLES", "COLES"),               # tab padding still counts
    ("pos authorisation  coles 0602", "coles 0602"),       # case-insensitive prefix
]


@pytest.mark.parametrize("description, expected", _COLUMN_CASES)
def test_pending_merchant_column_slices_by_position(lam, description, expected):
    assert lam.merchant.pending_merchant_column(description) == expected


@pytest.mark.parametrize("pad", [2, 8, 9, 11, 14])
def test_pending_merchant_column_cut_follows_the_padding(lam, pad):
    # A bank-side padding change must shift the cut with it, not misalign it — same shop
    # read cleanly at every padding width.
    desc = "POS AUTHORISATION" + " " * pad + "COLES 0602".ljust(25) + "MELBOURNE"
    assert lam.merchant.pending_merchant_column(desc).strip() == "COLES 0602"
