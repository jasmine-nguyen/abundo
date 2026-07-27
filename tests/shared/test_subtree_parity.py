"""WHIT-348 parity: the client budgetSubtreeContains (src/context.tsx) must mirror the server's
subtree_ids (shared/spend.py). Both this test and src/__tests__/budgetSubtreeParity.logic.test.ts
load the SAME committed fixture (tests/fixtures/subtree_parity.json) and assert their rule
reproduces every case in the full budgetId x categoryId cross-product, so accidental drift on
either side reddens. This half pins the SERVER rule to the frozen truth table."""

import json
import pathlib

_FIXTURE = pathlib.Path(__file__).resolve().parents[1] / "fixtures" / "subtree_parity.json"


def _load():
    return json.loads(_FIXTURE.read_text())


def test_subtree_ids_reproduces_the_parity_fixture(shared):
    fixture = _load()
    categories = fixture["categories"]
    children = shared.spend.build_category_children(categories)
    bucket_by_id = {c["id"]: c.get("bucket") for c in categories}

    subtrees = {c["id"]: shared.spend.subtree_ids(c["id"], children, bucket_by_id)
                for c in categories}
    for case in fixture["cases"]:
        got = case["categoryId"] in subtrees[case["budgetId"]]
        assert got == case["expected"], (
            f"subtree_ids drift: {case['categoryId']} in {case['budgetId']} = {got}, "
            f"fixture says {case['expected']}"
        )


def test_fixture_covers_the_drift_prone_shapes():
    """Guard the fixture itself: if the taxonomy is ever trimmed, the parity check above weakens
    silently. Pin the specific shapes that make the two rules non-trivial to keep in sync."""
    fixture = _load()
    ids = {c["id"] for c in fixture["categories"]}
    expected = {(c["budgetId"], c["categoryId"]): c["expected"] for c in fixture["cases"]}
    assert len(fixture["cases"]) == len(ids) ** 2                       # full cross-product
    assert expected[("living_root", "deep_living")] is True            # same-bucket leaf under cross-bucket intermediate
    assert expected[("living_root", "cross")] is False                 # cross-bucket direct child dropped
    assert expected[("none_root", "none_kid")] is True                 # None under None kept
    assert expected[("none_root", "none_kid_living")] is False         # Living under None dropped
    assert expected[("cyc_a", "cyc_b")] is True                        # two-node cycle terminates & agrees
