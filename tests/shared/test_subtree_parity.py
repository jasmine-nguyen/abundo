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


# --- folded from test_subtree_parity_gaps.py (WHIT-463) ---


def test_subtree_ids_matches_an_independent_down_walk_oracle_on_many_trees(shared):
    """Model check: subtree_ids must equal an INDEPENDENT re-derivation of its own documented
    rule (descend, then keep root + same-bucket nodes) over many deterministic random trees,
    including corrupt cycles. Unlike the frozen fixture this oracle is re-derived every run, so a
    server drift reddens here even if the golden file were regenerated to match it."""
    buckets = ["Living", "Lifestyle", "Savings", None]

    def lcg(seed):
        s = seed & 0xFFFFFFFF
        while True:
            s = (s * 1664525 + 1013904223) & 0xFFFFFFFF
            yield s / 0x100000000

    def oracle(cats, root_id):
        children = {}
        for c in cats:
            if c["parent"] is not None:
                children.setdefault(c["parent"], []).append(c["id"])
        bucket_of = {c["id"]: c["bucket"] for c in cats}
        visited, stack = set(), [root_id]
        while stack:
            node = stack.pop()
            if node in visited:
                continue
            visited.add(node)
            stack.extend(children.get(node, []))
        root_bucket = bucket_of.get(root_id)
        return {n for n in visited if n == root_id or bucket_of.get(n) == root_bucket}

    rnd = lcg(0x1348)
    checks = 0
    saw_cycle = False
    for _ in range(300):
        n = 2 + int(next(rnd) * 7)
        cats = []
        for i in range(n):
            r = next(rnd)
            if r < 0.28:
                parent = None
            elif r < 0.9 and i > 0:
                parent = f"n{int(next(rnd) * i)}"
            else:
                parent = f"n{int(next(rnd) * n)}"
            if parent == f"n{i}":
                parent = None
            cats.append({"id": f"n{i}", "parent": parent, "bucket": buckets[int(next(rnd) * len(buckets))]})
        children = shared.spend.build_category_children(cats)
        bucket_by_id = {c["id"]: c["bucket"] for c in cats}
        ids = [c["id"] for c in cats]
        for root in ids:
            got = shared.spend.subtree_ids(root, children, bucket_by_id)
            assert got == oracle(cats, root), f"drift on {cats} root={root}: {got}"
            checks += 1
        # cycle detector: a node reaching itself via parent pointers
        by_id = {c["id"]: c for c in cats}
        for c in cats:
            cur, seen = c["parent"], set()
            while cur and cur not in seen:
                if cur == c["id"]:
                    saw_cycle = True
                    break
                seen.add(cur)
                cur = by_id.get(cur, {}).get("parent")
    assert checks > 500
    assert saw_cycle  # the sweep actually hit corrupt-cycle shapes
