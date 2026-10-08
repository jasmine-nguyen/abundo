"""Adversarial GAP around the shared TS-array reader (WHIT-446 QA).

WHIT-446's own meta-guard (test_ts_array_parser_edges.py [B1]-[B11]) covers the reader's happy
edges. This is the INDEPENDENT gap that suite leaves open:

  [G3] a type annotation that SPANS lines still parses (the `[^=]*` + DOTALL contract);
       [B6] only ever drives a single-line annotation

Driven with FABRICATED text through the REAL `_ts_array`, so it goes red if the annotation span
is reverted — never against a re-implemented value.
"""

import _ts_array


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
