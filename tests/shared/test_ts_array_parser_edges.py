"""Parser-edge meta-guard for the shared TS-array reader (WHIT-446).

The colour-ramp and milestone-twin guards both read an `export const NAME = [...]` body
through _ts_array. Those guards prove the two languages agree TODAY; these prove the
reader that does the reading cannot quietly stop reading — the failure mode a guard has
that ordinary tests do not: green is its normal state, so a reader that returns nothing,
mis-parses, or reads the wrong declaration looks exactly like a healthy run.

Driven against FABRICATED text (never the real files), so they keep meaning after a
legitimate palette/plan change. test_chart_ramp_parser_edges.py [A1]-[A12] and the
twin-drift WHIT-446 guards still drive each caller's OWN read to prove it stays WIRED to
this reader; these cover the reader's parsing behaviour once, for both callers.

Covers, by checklist id:
  [B1]  exactly-one accepts one, rejects a shadowing second
  [B2]  a `//`-commented entry is stripped before the body is read
  [B3]  a `/* */`-block-commented entry is stripped before the body is read
  [B4]  a `]` inside a comment does not truncate the body (strip runs BEFORE locate)
  [B5]  with no annotation flag, an annotated declaration fails loudly (the [A7] contract)
  [B6]  with the annotation flag, the annotated form parses — spaced and no-space
  [B7]  a name that merely starts with the wanted name is not matched
  [B8]  the name is matched literally, not as a regex
  [B9]  array_bodies returns EVERY declaration — the "all" form discovery relies on
  [B10] an indented declaration is refused (the start-of-line anchor holds)
  [B11] an annotation containing `=` fails loud rather than mis-parsing (safe direction)
"""

import pytest

import _ts_array


def test_exactly_one_accepts_one_and_rejects_a_shadowing_second():
    """[B1] A single declaration returns its body; a leftover/commented-out old list above
    the live one (two matches) fails 'found 2'. This is what stops a guard silently
    comparing the first-matched, possibly-stale body."""
    assert _ts_array.one_array_body("export const A = [1, 2];\n", "A") == "1, 2"

    shadowed = "export const A = [1];\nexport const A = [2];\n"
    with pytest.raises(AssertionError, match="found 2"):
        _ts_array.one_array_body(shadowed, "A")


def test_a_line_commented_entry_is_stripped_before_the_body_is_read():
    """[B2] The likeliest way a list shrinks in practice is a commented-out line. A `//`
    comment must be gone before the body is read, or the entry would still be counted."""
    body = _ts_array.one_array_body("export const A = [\n  1, // 2, 3\n];\n", "A")
    assert "1" in body and "2" not in body and "3" not in body


def test_a_block_commented_entry_is_stripped_before_the_body_is_read():
    """[B3] The `/* */` sibling of [B2] — the dangerous one, because a `/* '#x', */` reads
    as a live entry and makes the guard agree with a list the app no longer uses."""
    body = _ts_array.one_array_body("export const A = [\n  1, /* 2, */ 4,\n];\n", "A")
    assert "1" in body and "4" in body and "2" not in body


def test_a_bracket_inside_a_comment_does_not_truncate_the_body():
    """[B4] Comments are stripped BEFORE the body is located, not after. Otherwise a `]`
    inside a comment inside the array ends the body early and it reads short."""
    body = _ts_array.one_array_body("export const A = [\n  1, // stray ] here\n  2,\n];\n", "A")
    assert "1" in body and "2" in body


def test_with_no_annotation_flag_an_annotated_declaration_fails_loudly():
    """[B5] The colour-ramp contract (WHIT-406 [A7]): a `: readonly T[] =` reshape is a
    routine TypeScript tidy-up that must fail naming the parser, never return an empty body
    that compares equal to nothing and passes. The default flag preserves that exactly."""
    with pytest.raises(AssertionError, match="update the parser"):
        _ts_array.one_array_body("export const A: readonly number[] = [1];\n", "A")


def test_with_the_annotation_flag_an_annotated_declaration_parses():
    """[B6] MILESTONES ships as `export const MILESTONES: Milestone[] = [...]`, so its
    caller opts in. Both the spaced real form and a Prettier-free no-space form parse."""
    spaced = "export const A: readonly number[] = [1, 2];\n"
    assert _ts_array.one_array_body(spaced, "A", allow_type_annotation=True) == "1, 2"

    nospace = "export const A:number[]=[1, 2];\n"
    assert _ts_array.one_array_body(nospace, "A", allow_type_annotation=True) == "1, 2"


def test_a_name_that_merely_starts_with_the_wanted_name_is_not_matched():
    """[B7] A sibling list AX / A_DARK must not be read as A, and must not make the real
    one ambiguous. The required `=` (or annotation then `=`) after the name rejects it."""
    both = "export const AX = [1];\nexport const A = [2];\n"
    assert _ts_array.one_array_body(both, "A") == "2"

    with pytest.raises(AssertionError, match="update the parser"):
        _ts_array.one_array_body("export const AX = [1];\n", "A")


def test_the_name_is_matched_literally_not_as_a_regex():
    """[B8] The name is interpolated into the pattern, so it is escaped: a name with a
    regex metacharacter must be matched literally, never as 'any char'. Without the escape
    `A.` would match `AB`; with it, it does not."""
    with pytest.raises(AssertionError, match="update the parser"):
        _ts_array.one_array_body("export const AB = [1];\n", "A.")


def test_array_bodies_returns_every_declaration_for_discovery():
    """[B9] The 'all matches' form ramp_source_path's file-walk relies on (a yes/no per
    file). It returns every body, and an empty list when the name is absent."""
    src = "export const A = [1];\nexport const A = [2];\n"
    assert _ts_array.array_bodies(src, "A") == ["1", "2"]
    assert _ts_array.array_bodies("// nothing here\n", "A") == []


def test_an_indented_declaration_is_not_matched():
    """[B10] The pattern is anchored to the start of a line on purpose, so a mention of the
    name indented inside a function or comment cannot be read as the declaration."""
    with pytest.raises(AssertionError, match="update the parser"):
        _ts_array.one_array_body("  export const A = [1];\n", "A")


def test_an_annotation_containing_an_equals_fails_loud_rather_than_misparsing():
    """[B11] `[^=]*` stops at the first `=`, so a generic default like `V = number>` inside
    the annotation makes the declaration no longer match — it fails loud rather than
    mis-reading the body. The safe direction: a human is told to update the parser."""
    src = "export const A: Map<K, V = number>[] = [1, 2];\n"
    with pytest.raises(AssertionError, match="update the parser"):
        _ts_array.one_array_body(src, "A", allow_type_annotation=True)
