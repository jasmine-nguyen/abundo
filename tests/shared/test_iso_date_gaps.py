r"""WHIT-418 — GAP tests for shared/iso_date.valid_iso_date, the one shared ISO YYYY-MM-DD
rule the save endpoint AND both milestone read paths now share.

Already locked elsewhere, NOT repeated here: the lenient basic/week forms ("20300101",
"2030-W01-1") rejected by both read paths ([E2]/[F3]); the "2026-02-30" impossible day rejected
by the save endpoint (test_milestones_api.py) and the client read (test_milestones_e2e.py);
the datetime / whitespace / Z-suffix / bytes / bool shapes dropped by both read paths ([E1]).

What none of them cover — the inputs where ISO_DATE_RE's `\d` / `$` are LOOSER than "an ASCII
YYYY-MM-DD calendar date", so the `date.fromisoformat` half of valid_iso_date is the ONLY thing
that rejects them:

  * Non-ASCII decimal digits. Python's `\d` matches Unicode digits (fullwidth ２, Arabic-Indic ٢),
    so ISO_DATE_RE.match("２０３０-01-01") SUCCEEDS. Only the calendar parse rejects it. A refactor
    that replaced date.fromisoformat with int()+range checks would regress silently — int("２０３０")
    == 2030, so such a hand-rolled parser would ACCEPT these while still rejecting 2026-02-30.
  * Trailing newline. `$` matches just before a final "\n", so ISO_DATE_RE.match("2030-01-01\n")
    SUCCEEDS; only the calendar parse rejects it.
  * Impossible calendar days that PASS the shape regex (month/day 00, day 32, Feb 30) — the whole
    reason the shape check isn't enough on its own.

Fail-on-revert (one lever, several ways to pull it): delete the `date.fromisoformat` calendar
check from valid_iso_date (trust the regex) -> every "regex-passes-but-invalid" case below flips
to True and this file goes red. The valid extremes pin the opposite over-tightening.
"""

import pytest


# --- shape passes the regex but the value is not a real ASCII calendar date -------------------

_REGEX_PASSES_BUT_INVALID = [
    ("fullwidth unicode digits", "２０３０-01-01"),
    ("arabic-indic unicode digits", "٢٠٣٠-01-01"),
    ("mixed ascii + unicode digit", "2030-01-0１"),
    ("trailing newline", "2030-01-01\n"),                            # $ matches before final \n
    ("month 00", "2030-00-10"),
    ("day 00", "2030-01-00"),
    ("month 13", "2030-13-01"),
    ("day 32", "2030-01-32"),
    ("feb 30", "2026-02-30"),
    ("feb 29 non-leap", "2027-02-29"),
    ("all zeros", "0000-00-00"),
]


@pytest.mark.parametrize("why, value", _REGEX_PASSES_BUT_INVALID,
                         ids=[c[0] for c in _REGEX_PASSES_BUT_INVALID])
def test_a_shape_matching_but_uncalendar_value_is_rejected(shared, why, value):
    # WHIT-418 — the shape regex is deliberately permissive (Unicode `\d`, `$` before a newline,
    # any 2 digits for month/day); the calendar parse is what actually makes the string a date.
    # This pins the half of valid_iso_date that the truth-table-via-row_date tests don't reach,
    # because those all fail at the REGEX stage. Fail-on-revert: drop date.fromisoformat.
    import iso_date
    assert iso_date.ISO_DATE_RE.match(value), f"precondition: {why} must pass the shape regex"
    assert iso_date.valid_iso_date(value) is False, why


# --- shapes the regex itself rejects (kept minimal — the parity tables carry the read-path set) -

@pytest.mark.parametrize("value", [
    "+2030-01-01", "-2030-01-01", "2030-1-1", " 2030-01-01", "2030-01-01 ",
    "2030/01/01", "2030-01-01x", "2030-01-01" * 50, "",
])
def test_a_wrong_shape_is_rejected_before_the_calendar_check(shared, value):
    # The regex is the first gate. These never reach fromisoformat. Locks that a "+"/"-" sign, a
    # single-digit field, surrounding whitespace, a separator swap, junk suffix, an absurdly long
    # string and the empty string are all False.
    import iso_date
    assert iso_date.valid_iso_date(value) is False, value


@pytest.mark.parametrize("value", [None, 20300101, 2030.0, True, b"2030-01-01", ["2030-01-01"],
                                   {"d": "2030-01-01"}])
def test_a_non_string_is_rejected_without_raising(shared, value):
    # valid_iso_date takes `value` untyped and must never raise on a non-str (bool, int, float,
    # bytes, None, list, dict): the isinstance guard returns False first. True is the sharp one —
    # bool is an int subclass, but it is not a str, so it is rejected before any regex/parse.
    import iso_date
    assert iso_date.valid_iso_date(value) is False, repr(value)


# --- the opposite risk: a real calendar date must stay accepted (no over-tightening) ----------

@pytest.mark.parametrize("value", [
    "2030-01-01", "0001-01-01", "9999-12-31", "2028-02-29",  # leap day in a leap year
    "2030-12-31", "2030-01-31",
])
def test_a_real_calendar_date_is_accepted(shared, value):
    import iso_date
    assert iso_date.valid_iso_date(value) is True, value
