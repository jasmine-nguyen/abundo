"""Adversarial GAPS around the shared TS-array reader and its milestone twin (WHIT-446 QA).

WHIT-446's own meta-guard (test_ts_array_parser_edges.py [B1]-[B11]) and the twin-drift
WHIT-446 guards cover the reader's happy edges and the twin's three named
behaviour-changes. These are the INDEPENDENT gaps that suite leaves open:

  [G1] the milestone twin path survives CRLF source (the chart side has [A4]; the twin,
       with its own _TS_ROW regex over an annotated block, had no such pin)
  [G2] a `/* */` block comment that SWALLOWS the only MILESTONES declaration must fail
       loud (found 0), not read the commented-out decl as live — the existing twin comment
       test keeps a LIVE block below the comment, so it never exercises the zero-live case
  [G3] a type annotation that SPANS lines still parses (the `[^=]*` + DOTALL contract);
       [B6] only ever drives a single-line annotation

All drive FABRICATED text through the REAL production helpers (`_ts_array` and the twin's
`_parse_ts_milestones`), so each goes red if the delegation/comment-strip/annotation span
is reverted — never against a re-implemented value.
"""

import pytest

import _ts_array
import test_milestones_twin_drift as twin


# --------------------------------------------------------------------- milestone twin path


def test_crlf_milestone_source_parses_the_same_as_lf():
    """[G1] A Windows checkout or editor round-trip can hand pytest `\r\n`, and .gitattributes
    does not normalise src/milestones.ts. The twin reader locates the block through _ts_array
    (DOTALL/MULTILINE, comments stripped) and then runs _TS_ROW over it; every row must still
    be seen. The chart reader is pinned for this by [A4] — the annotated twin path was not.
    Reverting _ts_array's MULTILINE/DOTALL (so `^`/`.` stop spanning the CRLF block) reddens."""
    crlf = (
        "export const MILESTONES: Milestone[] = [\r\n"
        "  { sprint: 0, label: 'Kickoff', targetBalance: 544000, targetDate: '2026-06-18' },\r\n"
        "  { sprint: 1, label: 'Two', targetBalance: 100, targetDate: '2026-07-18' },\r\n"
        "];\r\n"
    )
    assert twin._parse_ts_milestones(crlf) == [(0, "Kickoff", 544000), (1, "Two", 100)]


def test_a_block_comment_swallowing_the_only_declaration_fails_loud_not_reads_it():
    """[G2] The dangerous zero-live case. The existing twin test keeps a LIVE block BELOW a
    commented one, so it only ever proves the live block wins. Here the `/* */` swallows the
    ONLY declaration: with comments stripped first there are zero live decls, which must fail
    loud ('found 0') rather than matching the commented `export const MILESTONES` inside the
    comment and returning stale rows. Revert the comment-strip and the commented decl is read
    as the one-and-only block -> no raise -> red."""
    src = (
        "/* temporarily disabled while we rebuild the plan\n"
        "export const MILESTONES: Milestone[] = [\n"
        "  { sprint: 0, label: 'Stale', targetBalance: 999, targetDate: '2026-01-01' },\n"
        "];\n"
        "*/\n"
    )
    with pytest.raises(AssertionError, match="found 0"):
        twin._parse_ts_milestones(src)


# ------------------------------------------------------------------------- reader annotation


def test_a_type_annotation_that_spans_lines_still_parses_one_body():
    """[G3] `allow_type_annotation` is `(?::[^=]*)?`; `[^=]*` matches newlines (a negated class
    always does), so a Prettier-wrapped annotation spanning lines still reaches the `=`. [B6]
    only ever drives a single-line annotation, so a future tightening to `[^=\n]*` would slip
    past it while breaking a real wrapped declaration. Pin the multi-line form here; tightening
    the class to forbid newlines reddens this while [B6] stays green."""
    src = (
        "export const A:\n"
        "  readonly number[] = [1, 2];\n"
    )
    assert _ts_array.one_array_body(src, "A", allow_type_annotation=True) == "1, 2"

    # And the same shape through the real milestone helper, end to end.
    milestones = (
        "export const MILESTONES:\n"
        "  Milestone[] = [\n"
        "  { sprint: 0, label: 'X', targetBalance: 5, targetDate: '2026-01-01' },\n"
        "];\n"
    )
    assert twin._parse_ts_milestones(milestones) == [(0, "X", 5)]
