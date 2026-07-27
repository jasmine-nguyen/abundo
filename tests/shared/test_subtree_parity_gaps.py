"""WHIT-348 — server-side gaps the FROZEN parity fixture (tests/fixtures/subtree_parity.json)
can't guard. The golden truth table protects against ONE side drifting, but a CO-DRIFT (both
client + server regenerated wrong together) slips through unless each side ALSO has an
independent, hardcoded oracle for the drift-prone shapes. test_spend_tree.py pins most; the one
shape the fixture taxonomy omits is a NULL-bucket descendant reached THROUGH a non-null
intermediate under a null root (the null analogue of the fixture's living_root→cross→deep_living).
This file pins it on the server, and src/__tests__/budgetSubtreeContainsGaps.logic.test.ts pins the
same shape on the client — so a co-drift on it reddens on BOTH sides without regenerating the fixture.
"""


def test_subtree_ids_null_descendant_through_nonnull_intermediate(shared):
    # none_root(None) → mid(Living) → leaf(None). None == None keeps `leaf` under the None root,
    # descending THROUGH the Living intermediate (filter on endpoints, not descent). The non-null
    # intermediate itself is dropped. Fail-on-revert: prune-the-walk loses `leaf`; drop the
    # endpoint filter and `mid` wrongly folds in.
    cats = [
        {"id": "none_root", "bucket": None, "parent": None},
        {"id": "mid", "bucket": "Living", "parent": "none_root"},
        {"id": "leaf", "bucket": None, "parent": "mid"},
    ]
    children = shared.spend.build_category_children(cats)
    bucket_by_id = {c["id"]: c["bucket"] for c in cats}

    assert shared.spend.subtree_ids("none_root", children, bucket_by_id) == {"none_root", "leaf"}


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
