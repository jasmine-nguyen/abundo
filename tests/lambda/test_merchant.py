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
