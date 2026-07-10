"""Tests for the sub-category tree helpers in shared/spend.py (WHIT-220, WHIT-228):
build_category_children and subtree_ids. Pure functions over the taxonomy (each
category carries a `parent`), so they need no DynamoDB — just the `shared` fixture
that puts shared/ on sys.path."""


def _cat(cat_id, parent=None):
    return {"id": cat_id, "bucket": "Living", "parent": parent}


def test_build_children_maps_parent_to_its_children(shared):
    cats = [_cat("car"), _cat("parking", "car"), _cat("other", "car"), _cat("coffee")]

    children = shared.spend.build_category_children(cats)

    assert children == {"car": ["parking", "other"]}  # only parents appear as keys


def test_subtree_ids_of_a_leaf_is_itself(shared):
    # A leaf with no children rolls up as just itself — byte-identical to summing that
    # id alone, so a flat leaf budget is unchanged (WHIT-228 regression anchor).
    children = shared.spend.build_category_children([_cat("coffee")])

    assert shared.spend.subtree_ids("coffee", children) == {"coffee"}


def test_subtree_ids_of_orphan_absent_from_taxonomy_is_itself(shared):
    # An orphan budget target (id not in the taxonomy) is its own single node, so it
    # still sums as its own spend — the existing orphan behaviour.
    children = shared.spend.build_category_children([_cat("coffee")])

    assert shared.spend.subtree_ids("ghost", children) == {"ghost"}


def test_subtree_ids_two_level_parent_includes_parent_and_children(shared):
    # The parent id itself is in the set, so spend tagged directly onto the parent
    # counts alongside the children's (WHIT-228).
    cats = [_cat("car"), _cat("parking", "car"), _cat("other", "car")]
    children = shared.spend.build_category_children(cats)

    assert shared.spend.subtree_ids("car", children) == {"car", "parking", "other"}
    assert shared.spend.subtree_ids("parking", children) == {"parking"}  # a leaf


def test_subtree_ids_three_level_includes_every_node(shared):
    # car -> daily -> {petrol, tolls}; car -> parking(leaf). The parent rolls up EVERY
    # node — itself, the intermediate `daily`, and the leaves — so a txn tagged directly
    # onto the mid-level `daily` is counted (the depth >= 3 case the leaf-only walk dropped).
    cats = [
        _cat("car"), _cat("daily", "car"), _cat("parking", "car"),
        _cat("petrol", "daily"), _cat("tolls", "daily"),
    ]
    children = shared.spend.build_category_children(cats)

    assert shared.spend.subtree_ids("car", children) == {"car", "daily", "parking", "petrol", "tolls"}
    assert shared.spend.subtree_ids("daily", children) == {"daily", "petrol", "tolls"}


def test_subtree_ids_corrupt_cycle_terminates(shared):
    # A corrupt stored cycle a<->b must not hang; the visited set stops the walk and
    # returns the nodes on the cycle once each (each summed once downstream).
    cats = [_cat("a", "b"), _cat("b", "a")]
    children = shared.spend.build_category_children(cats)

    assert shared.spend.subtree_ids("a", children) == {"a", "b"}
