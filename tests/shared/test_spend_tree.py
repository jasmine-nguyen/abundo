"""Tests for the sub-category tree helpers in shared/spend.py (WHIT-220):
build_category_children and descendant_leaves. Pure functions over the taxonomy
(each category carries a `parent`), so they need no DynamoDB — just the `shared`
fixture that puts shared/ on sys.path."""


def _cat(cat_id, parent=None):
    return {"id": cat_id, "bucket": "Living", "parent": parent}


def test_build_children_maps_parent_to_its_children(shared):
    cats = [_cat("car"), _cat("parking", "car"), _cat("other", "car"), _cat("coffee")]

    children = shared.spend.build_category_children(cats)

    assert children == {"car": ["parking", "other"]}  # only parents appear as keys


def test_descendant_leaves_of_a_leaf_is_itself(shared):
    children = shared.spend.build_category_children([_cat("coffee")])

    assert shared.spend.descendant_leaves("coffee", children) == {"coffee"}


def test_descendant_leaves_of_orphan_absent_from_taxonomy_is_itself(shared):
    # An orphan budget target (id not in the taxonomy) is its own single leaf, so it
    # still sums as its own spend — the existing orphan behaviour.
    children = shared.spend.build_category_children([_cat("coffee")])

    assert shared.spend.descendant_leaves("ghost", children) == {"ghost"}


def test_descendant_leaves_two_level_parent_returns_both_children(shared):
    cats = [_cat("car"), _cat("parking", "car"), _cat("other", "car")]
    children = shared.spend.build_category_children(cats)

    assert shared.spend.descendant_leaves("car", children) == {"parking", "other"}
    assert shared.spend.descendant_leaves("parking", children) == {"parking"}  # a leaf


def test_descendant_leaves_three_level_reaches_the_bottom(shared):
    # car -> daily -> {petrol, tolls}; car -> parking(leaf). Parent returns only the
    # bottom leaves; the mid node returns just its own leaves.
    cats = [
        _cat("car"), _cat("daily", "car"), _cat("parking", "car"),
        _cat("petrol", "daily"), _cat("tolls", "daily"),
    ]
    children = shared.spend.build_category_children(cats)

    assert shared.spend.descendant_leaves("car", children) == {"petrol", "tolls", "parking"}
    assert shared.spend.descendant_leaves("daily", children) == {"petrol", "tolls"}


def test_descendant_leaves_corrupt_cycle_terminates(shared):
    # A corrupt stored cycle a<->b must not hang; both nodes have children, so there
    # are no leaves — the visited set stops the walk.
    cats = [_cat("a", "b"), _cat("b", "a")]
    children = shared.spend.build_category_children(cats)

    assert shared.spend.descendant_leaves("a", children) == set()
