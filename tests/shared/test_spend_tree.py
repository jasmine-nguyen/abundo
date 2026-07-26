"""Tests for the sub-category tree helpers in shared/spend.py (WHIT-220, WHIT-228):
build_category_children and subtree_ids. Pure functions over the taxonomy (each
category carries a `parent`), so they need no DynamoDB — just the `shared` fixture
that puts shared/ on sys.path."""

from decimal import Decimal


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


def test_subtree_ids_bucket_filter_keeps_same_bucket_drops_cross_bucket(shared):
    # WHIT-229: with bucket_by_id, a cross-bucket child is excluded, but a same-bucket
    # descendant UNDER it is still kept (filter on membership, not descent). Car(Living) ->
    # parking(Living); Car -> odd(Lifestyle) -> fuel(Living). Car's set is the Living ids.
    cats = [
        {"id": "car", "bucket": "Living", "parent": None},
        {"id": "parking", "bucket": "Living", "parent": "car"},
        {"id": "odd", "bucket": "Lifestyle", "parent": "car"},
        {"id": "fuel", "bucket": "Living", "parent": "odd"},
    ]
    children = shared.spend.build_category_children(cats)
    bucket_by_id = {c["id"]: c["bucket"] for c in cats}

    assert shared.spend.subtree_ids("car", children, bucket_by_id) == {"car", "parking", "fuel"}
    # The 2-arg form (no bucket map) is unchanged: the whole subtree, no filter.
    assert shared.spend.subtree_ids("car", children) == {"car", "parking", "odd", "fuel"}


# --- WHIT-229 QA gap tests (adversarial) -----------------------------------


def test_subtree_ids_clean_single_bucket_equals_unfiltered(shared):
    # WHIT-229 [A6] byte-identical anchor: on a clean single-bucket tree the 3-arg
    # (bucket-aware) form drops NOTHING, so it equals the 2-arg form exactly — proving
    # passing bucket_by_id can't perturb a clean user's /budgets, alert or AI totals
    # (no cache-hash drift). Fail-on-revert: if the filter ever excluded a same-bucket id,
    # the two sets diverge and this reddens.
    cats = [_cat("car"), _cat("parking", "car"), _cat("fuel", "car"), _cat("tolls", "fuel")]
    children = shared.spend.build_category_children(cats)
    bucket_by_id = {c["id"]: c["bucket"] for c in cats}  # all Living

    assert shared.spend.subtree_ids("car", children, bucket_by_id) == \
        shared.spend.subtree_ids("car", children) == {"car", "parking", "fuel", "tolls"}


def test_subtree_ids_double_cross_bucket_boundary_keeps_deepest_same_bucket(shared):
    # WHIT-229 [A2] two boundaries deep: Living -> Lifestyle -> Lifestyle -> Living. The
    # deepest Living node still folds into the Living root (membership filter, not descent),
    # while BOTH Lifestyle intermediates drop. Fail-on-revert (prune-the-walk): descent would
    # stop at the first Lifestyle node and the deepest Living `d` is silently lost.
    cats = [
        {"id": "a", "bucket": "Living", "parent": None},
        {"id": "b", "bucket": "Lifestyle", "parent": "a"},
        {"id": "c", "bucket": "Lifestyle", "parent": "b"},
        {"id": "d", "bucket": "Living", "parent": "c"},
    ]
    children = shared.spend.build_category_children(cats)
    bucket_by_id = {x["id"]: x["bucket"] for x in cats}

    assert shared.spend.subtree_ids("a", children, bucket_by_id) == {"a", "d"}
    # A Lifestyle intermediate that is ITSELF a budgeted target rolls up its OWN bucket:
    # b -> {b, c}; the deeper Living `d` belongs to the Living root, not to b.
    assert shared.spend.subtree_ids("b", children, bucket_by_id) == {"b", "c"}


def test_subtree_ids_savings_child_excluded_like_lifestyle(shared):
    # WHIT-229 [A4]: Savings is a distinct bucket from a spend parent's Living — a Savings
    # child mis-parented under a Living parent is dropped exactly like a Lifestyle one, so a
    # savings contribution can't leak into a spend bar. Fail-on-revert: drop the filter -> the
    # Savings id folds in.
    cats = [
        {"id": "car", "bucket": "Living", "parent": None},
        {"id": "nest", "bucket": "Savings", "parent": "car"},
    ]
    children = shared.spend.build_category_children(cats)
    bucket_by_id = {x["id"]: x["bucket"] for x in cats}

    assert shared.spend.subtree_ids("car", children, bucket_by_id) == {"car"}


def test_subtree_ids_none_bucket_descendant_excluded_but_root_none_keeps_none(shared):
    # WHIT-229 [A8] corrupt row with a missing/None bucket: `bucket_by_id.get(n) == root_bucket`
    # can't crash (dict.get -> None). A None-bucket descendant under a real-bucket root is
    # EXCLUDED (None != "Living"); only when the ROOT bucket is itself None do None children
    # match and stay. Guards against a corrupt row spuriously folding into a normal parent.
    cats = [
        {"id": "car", "bucket": "Living", "parent": None},
        {"id": "ghost", "bucket": None, "parent": "car"},
    ]
    children = shared.spend.build_category_children(cats)

    real_root = {"car": "Living", "ghost": None}
    assert shared.spend.subtree_ids("car", children, real_root) == {"car"}  # ghost excluded

    none_root = {"car": None, "ghost": None}
    assert shared.spend.subtree_ids("car", children, none_root) == {"car", "ghost"}


# --- WHIT-350: fold_subtree (the shared aggregate-then-clamp fold) -------------
# The single source for the /budgets fold, the AI parent roll-up and the budget-alert
# combined target. sum posted+pending UNCLAMPED across the ids present in per_id, then
# floor each independently at 0. [fail-on-revert] breaking the fold reddens these.


def test_fold_subtree_empty_ids_is_zero_decimals(shared):
    # An empty subtree (e.g. a corrupt cycle) yields Decimal zeros, not int — matches
    # the seeded Decimal(0) contract the callers relied on.
    folded = shared.spend.fold_subtree({"a": {"posted": Decimal("5"), "pending": Decimal("2")}}, set())
    assert folded == {"posted": Decimal(0), "pending": Decimal(0)}
    assert isinstance(folded["posted"], Decimal) and isinstance(folded["pending"], Decimal)


def test_fold_subtree_id_absent_from_per_id_contributes_zero(shared):
    # An id in the subtree but with no spend this cycle (absent from per_id) contributes
    # 0 — no KeyError — matching the callers' `if cid in per_id` / truthiness skip.
    per_id = {"a": {"posted": Decimal("5"), "pending": Decimal("2")}}
    folded = shared.spend.fold_subtree(per_id, {"a", "ghost"})
    assert folded == {"posted": Decimal("5"), "pending": Decimal("2")}


def test_fold_subtree_net_negative_subtree_floors_at_zero(shared):
    # A net-refunded subtree floors the total at 0, never negative.
    per_id = {"a": {"posted": Decimal("10"), "pending": Decimal(0)},
              "b": {"posted": Decimal("-40"), "pending": Decimal(0)}}
    folded = shared.spend.fold_subtree(per_id, {"a", "b"})
    assert folded["posted"] == Decimal(0)   # 10 + (-40) = -30 → floored


def test_fold_subtree_posted_floors_independently_of_pending(shared):
    # posted and pending clamp SEPARATELY — a negative posted must not drag a positive
    # pending to 0. [fail-on-revert] against any "clamp the combined sum" mistake.
    per_id = {"a": {"posted": Decimal("-30"), "pending": Decimal("25")}}
    folded = shared.spend.fold_subtree(per_id, {"a"})
    assert folded == {"posted": Decimal(0), "pending": Decimal("25")}


def test_fold_subtree_nets_siblings_before_the_floor(shared):
    # The WHIT-343 headline: a net-negative sibling nets against a positive sibling
    # BEFORE the floor (aggregate-then-clamp). Per-id clamp would drop the refund and
    # give 100; netting-then-floor gives 40.
    per_id = {"a": {"posted": Decimal("100"), "pending": Decimal(0)},
              "b": {"posted": Decimal("-60"), "pending": Decimal(0)}}
    folded = shared.spend.fold_subtree(per_id, {"a", "b"})
    assert folded["posted"] == Decimal("40")
