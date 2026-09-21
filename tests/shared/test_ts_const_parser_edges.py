"""Parser-edge meta-guard for the shared TS-const reader (WHIT-420).

The loan-facts and milestone-cap sync guards both read a client `const NAME = <number>`
through _ts_const. Those guards prove the two languages agree TODAY; these prove the
reader that does the reading cannot quietly stop reading — the failure mode a guard has
that ordinary tests do not: green is its normal state, so a reader that returns nothing,
mis-parses, or reads the wrong declaration looks exactly like a healthy run.

Driven against FABRICATED text (never the real files), so they keep meaning after a
legitimate ceiling/cap change. `test_loanfacts_ceiling_sync_guard.py` still drives the
loan-facts guard's OWN functions ([D4]-[D6]) to prove that guard stays WIRED to this
reader; these cover the reader's parsing behaviour once, for both guards.

Covers, by checklist id:
  [T1] a plain declaration parses to its int
  [T2] underscore digit separators are stripped
  [T3] `export const` and bare `const` both parse
  [T4] a renamed/absent declaration fails loudly, not vacuously
  [T5] `assert_one_number_const` accepts exactly one, rejects a shadowing second
  [T6] `number_const` takes the FIRST match — the hazard [T5] exists to defend
  [T7] a name that merely starts with the wanted name is not matched
  [T8] the name is matched literally, not as a regex
"""

import pytest

import _ts_const


def test_a_plain_declaration_parses_to_its_int():
    """[T1] The base case both guards rely on."""
    assert _ts_const.number_const("export const LOANFACTS_FIELD_MAX = 7;\n", "LOANFACTS_FIELD_MAX") == 7


def test_underscore_digit_separators_are_read_as_one_number():
    """[T2] The real declarations are written `1_000_000_000`. The digit class has to
    accept the underscore separators, or it would stop at the first `_` and read `1`; the
    value is normalized to the plain server int it is compared against."""
    assert _ts_const.number_const("const CAP = 1_000_000_000;\n", "CAP") == 1_000_000_000


def test_export_and_bare_const_both_parse():
    """[T3] loanLimits.ts/milestones.ts use `export const`; the anchor is `const`, so a
    bare `const` must parse too — the reader keys on the declaration, not the export."""
    assert _ts_const.number_const("const CAP = 5;\n", "CAP") == 5
    assert _ts_const.number_const("export const CAP = 5;\n", "CAP") == 5


def test_a_renamed_or_absent_declaration_fails_loudly():
    """[T4] The vacuity case. If the const is renamed/inlined so nothing matches, the
    reader must say 'could not locate' rather than return nothing and let the equality
    test pass on air."""
    with pytest.raises(AssertionError, match="could not locate"):
        _ts_const.number_const("// CAP lives somewhere else now\n", "CAP")


def test_exactly_one_accepts_one_and_rejects_a_shadowing_second():
    """[T5] A single declaration passes; a leftover/commented-out old value above the
    live one (two matches) fails 'exactly one'. This is what stops the guard silently
    comparing the first-matched, possibly-stale value."""
    _ts_const.assert_one_number_const("export const CAP = 7;\n", "CAP")

    shadowed = "const CAP = 500_000_000;\nexport const CAP = 1_000_000_000;\n"
    with pytest.raises(AssertionError, match="exactly one"):
        _ts_const.assert_one_number_const(shadowed, "CAP")


def test_number_const_takes_the_first_match():
    """[T6] Documents the hazard [T5] defends: with two declarations, `number_const`
    reads the FIRST. The exactly-one pin is the only thing standing between that and a
    silently-wrong comparison, so pin the behaviour it guards."""
    shadowed = "const CAP = 500_000_000;\nexport const CAP = 1_000_000_000;\n"
    assert _ts_const.number_const(shadowed, "CAP") == 500_000_000


def test_a_name_that_merely_starts_with_the_wanted_name_is_not_matched():
    """[T7] A sibling const CAPX must not be read as CAP, and must not make the real one
    ambiguous. The required `=` after the name is what rejects the longer identifier."""
    with pytest.raises(AssertionError, match="could not locate"):
        _ts_const.number_const("export const CAPX = 5;\n", "CAP")

    both = "export const CAPX = 5;\nexport const CAP = 9;\n"
    assert _ts_const.number_const(both, "CAP") == 9
    _ts_const.assert_one_number_const(both, "CAP")


def test_the_name_is_matched_literally_not_as_a_regex():
    """[T8] The name is interpolated into the pattern, so it is escaped: a name with a
    regex metacharacter must be matched literally, never as 'any char'. Guards against a
    future caller passing an odd name and getting a silent false match."""
    with pytest.raises(AssertionError, match="could not locate"):
        _ts_const.number_const("const CAP = 5;\n", "CA.")
