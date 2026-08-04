r"""Adversarial gaps for the shared TS-const reader (WHIT-420 QA).

Companion to test_ts_const_parser_edges.py ([T1]-[T8], authored with the change).
Those pin the happy shapes both sync guards rely on; these pin the ADVERSARIAL edges
that decide whether a silent drift can slip past the reader itself — comments the reader
does NOT strip, numeric literals it silently truncates (float/hex/exponent), the
fail-loud boundary for shapes it cannot read (typed decl, negative), and formatting
robustness (CRLF/tab). All against fabricated text, never the real files.

Each test pins the reader's ACTUAL, current behaviour so that if the docstring's
promised "future parser fix" (a hex/exponent literal, an `as const`) ever lands, the
change is visible here rather than shipping as a silent shift in what the guards accept.

Covers, by checklist id:
  [G1] a `const NAME = <n>` inside a // or /* */ comment is NOT ignored — it matches,
       and a commented copy above the live line is caught by the exactly-one pin
  [G2] float / hex / exponent / trailing-junk literals are silently TRUNCATED to their
       leading integer run (the limitation the docstring flags for a future fix)
  [G3] a type-annotated `const NAME: T = <n>` cannot be read -> fails loudly (not silent)
  [G4] CRLF, tabs and no-space-around-= all still parse (\s is whitespace-class)
  [G5] `= 0` reads 0 — the reader does NOT enforce positivity; that is the caller's job
  [G6] assert_one on ZERO matches reports "exactly one" (found 0), its own 0-branch
  [G7] a negative value fails loudly rather than being read as its positive digits
"""

import pytest

import _ts_const


# [G1] Comments are TEXT to the reader — it does not strip them. -----------------------

def test_a_declaration_inside_a_line_comment_is_not_ignored():
    """[G1] The reader parses source as TEXT with no JS/comment awareness, so a
    `// const CAP = 5` counts as a real match. This is deliberate (documented on
    assert_one_number_const): the safety net is the exactly-one pin, NOT comment-skipping.
    Pin it, so a future 'ignore comments' change to the reader is a conscious, visible one."""
    assert _ts_const.number_const("// const CAP = 5;\n", "CAP") == 5


def test_a_declaration_inside_a_block_comment_is_not_ignored():
    """[G1] Same for a /* ... */ block comment — still a match, still read."""
    assert _ts_const.number_const("/* const CAP = 5; */\n", "CAP") == 5


def test_a_commented_copy_above_the_live_line_is_the_exact_hazard_the_pin_catches():
    """[G1] The dangerous shape: an old value left in a comment ABOVE the live one.
    number_const takes the FIRST match, so it reads the COMMENTED (stale) value, not the
    live line — which is precisely why assert_one_number_const must reject the pair."""
    text = "// const CAP = 500_000_000;\nexport const CAP = 1_000_000_000;\n"
    # number_const silently reads the stale commented value first...
    assert _ts_const.number_const(text, "CAP") == 500_000_000
    # ...and the exactly-one pin is the thing that turns that into a loud failure.
    with pytest.raises(AssertionError, match="exactly one"):
        _ts_const.assert_one_number_const(text, "CAP")


# [G2] Non-plain-integer literals are silently truncated to their leading digit run. ----

@pytest.mark.parametrize(
    "literal, parsed",
    [
        ("5.5", 5),          # float -> integer part only (the fractional part is dropped)
        ("1_000_000_000.0", 1_000_000_000),  # a float that happens to equal the int is accepted
        ("0x10", 0),         # hex -> just the leading '0'; a real hex ceiling would read as 0
        ("1e9", 1),          # exponent -> just the leading '1'; 1e9 (=1_000_000_000) reads as 1
        ("5abc", 5),         # trailing junk -> stops at the first non-digit
    ],
)
def test_non_integer_literals_are_silently_truncated(literal, parsed):
    r"""[G2] `([\d_]+)` captures only the leading run of digits/underscores. So a float,
    hex, exponent or typo'd literal is not rejected — it is silently READ as a wrong int.
    The sync guards survive this only because their value-pin + agree assertions catch the
    wrong number downstream; the reader in isolation does not. Pin the real behaviour so the
    docstring's promised hex/exponent fix shows up here when it lands."""
    assert _ts_const.number_const(f"const CAP = {literal};\n", "CAP") == parsed


# [G3] Shapes the reader cannot read must fail LOUDLY, never vacuously. -----------------

def test_a_type_annotated_declaration_fails_loudly():
    """[G3] `const CAP: number = 5` has `: number` between the name and `=`, which the
    `\\s*=` cannot span — so it does NOT match. The important half is that it fails loudly
    ('could not locate') rather than reading some wrong number. A `const CAP = 5 as const`
    SUFFIX, by contrast, parses fine (asserted below) — the annotation prefix is the gap."""
    with pytest.raises(AssertionError, match="could not locate"):
        _ts_const.number_const("const CAP: number = 5;\n", "CAP")
    # the `as const` suffix the docstring mentions already reads correctly today:
    assert _ts_const.number_const("const CAP = 5 as const;\n", "CAP") == 5


def test_a_negative_value_fails_loudly_rather_than_reading_its_digits():
    """[G7] `= -5`: the '-' is not in the digit class and sits between `=` and the digits,
    so nothing matches. Good — a negative reads as could-not-locate, never as +5."""
    with pytest.raises(AssertionError, match="could not locate"):
        _ts_const.number_const("const CAP = -5;\n", "CAP")


# [G4] Formatting robustness — whitespace is a class, so source layout doesn't matter. --

@pytest.mark.parametrize(
    "source",
    [
        "const CAP = 5;\r\n",        # Windows CRLF line ending
        "const\tCAP\t=\t5;\n",       # tabs between every token
        "const CAP=5;\n",            # no spaces around '='
        "const   CAP   =   5;\n",    # runs of spaces
    ],
    ids=["crlf", "tabs", "no-spaces", "extra-spaces"],
)
def test_whitespace_and_line_ending_variants_still_parse(source):
    r"""[G4] `\s+`/`\s*` are the whitespace class, so tabs and tight/loose spacing all read
    the same value. The CRLF case is a smoke test that a Windows checkout's trailing `\r\n`
    — which sits after the captured digits, not inside the match — doesn't otherwise disrupt
    the single-line declaration. A reformat or a `\r\n` checkout can't blind the guard."""
    assert _ts_const.number_const(source, "CAP") == 5


# [G5]/[G6] Boundaries the reader delegates or owns. -----------------------------------

def test_zero_is_read_and_positivity_is_the_callers_job():
    """[G5] `= 0` reads as 0 — the reader does NOT reject non-positive values. The `> 0`
    sanity check lives in each guard (test_*_parses_to_a_positive_int), not here. Pin the
    split so no one 'helpfully' moves positivity into the reader without noticing this."""
    assert _ts_const.number_const("const CAP = 0;\n", "CAP") == 0


def test_exactly_one_on_an_absent_declaration_reports_zero_not_could_not_locate():
    """[G6] assert_one_number_const has its OWN empty-input branch: with no match it fails
    'exactly one ... found 0', a different message from number_const's 'could not locate'
    ([T4]). Pins that a caller using only the exactly-one pin still fails loudly on absence."""
    with pytest.raises(AssertionError, match="exactly one"):
        _ts_const.assert_one_number_const("nothing declared here\n", "CAP")
