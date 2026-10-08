"""Category taxonomy storage: the user-defined categories as a single DynamoDB
config item, with the seed taxonomy and colour palette kept local to this module."""

from collections import Counter
from decimal import Decimal
from typing import Any, Optional

from repository_base import RepositoryBase
from repository_errors import (
    CategoryNotFoundError,
    DuplicateCategoryError,
    InvalidCategoryParentError,
)
from spend import build_category_children

# Category taxonomy data lives here, not in constants.py, on purpose: this module
# ships in the Lambda layer, and a `from constants import ...` here binds to the
# FUNCTION's constants.py — coupling the layer to another package's symbols. A
# deploy skew there fails this import at module load and 500s EVERY route
# (including /transactions). The palette + seed are used only by CategoryRepository,
# so keeping them local makes the layer self-contained. Ids are the curated slugs
# mirrored client-side by src/context.tsx CATEGORY_BASE (the vocabulary BankSync
# rules + client budgets/rules reference); `recent` is omitted (client-derived).
# Ordered so consecutively-created categories alternate warm/cool once mapped to their Tokyo
# Night hue (src/context.tsx colorForCategory) — the old order clustered three cool blue-greens
# at the tail, so two categories created back-to-back could read as the same colour.
CATEGORY_PALETTE = [
    "#E8A87C", "#8AB4F8", "#F08C8C", "#6FD0C9", "#F2C94C",
    "#C7A8F0", "#F2A0C9", "#7FD49B", "#B0A8F0", "#8FD46B",
]

# `colorSlot` is the PERMANENT chart colour of a category: an integer assigned once and
# stored. Adding or deleting a category cannot repaint any other.
#
# A slot is NOT a position on the colour ramp. The client (slice 2) resolves it through a
# fixed permutation, ASSIGNMENT_ORDER, arriving in src/chartColors.ts:
#     hex = CATEGORY_COLORS[ASSIGNMENT_ORDER[slot]]
# So consecutive SLOT numbers are deliberately far apart in hue, and reading these integers
# as ramp positions will mislead you: slots 15,16,17,18 look adjacent but resolve to ramp
# entries 13,14,16,18. The 13 seeds below were solved against the RAMP positions they resolve
# to — each built-in stays in its own hue family, and the longest run of neighbouring ramp
# entries is 3 (down from 5 under the previous id-keyed mapping).
#
# WHIT-415 re-spaced the warm end: eatingout/health/coffee used to be a run of THREE (ramp 0/1/2).
# Coffee alone moved, to ramp 3, leaving eatingout/health a pair. ONE seed slot changed on purpose —
# every extra move ripples into which slot a user's first custom category gets, and the obvious
# second move (utilities to ramp 5) pushed that category into the middle of the blue cluster.
# Coffee's new neighbour (utilities, ramp 3/4) is WIDER apart than the health/coffee pair removed,
# so the run of three is gone and nothing tighter replaced it.
# Two runs of three REMAIN and are tighter than the one removed: fitness/transport/phonenet at ramp
# 12-14 and pets/gifts/subs at 16-18. NOTE: this only paints NEW stores; a slot is permanent once
# stored, so existing accounts keep the old layout (WHIT-405).
SEED_CATEGORIES = {
    "coffee": {"id": "coffee", "name": "Cafes & Coffee", "icon": "coffee", "color": "#E8A87C", "bucket": "Lifestyle", "colorSlot": 9},
    "groceries": {"id": "groceries", "name": "Groceries", "icon": "cart", "color": "#7FD49B", "bucket": "Living", "colorSlot": 11},
    "eatingout": {"id": "eatingout", "name": "Eating Out", "icon": "food", "color": "#F08C8C", "bucket": "Lifestyle", "colorSlot": 0},
    "transport": {"id": "transport", "name": "Transport", "icon": "car", "color": "#8AB4F8", "bucket": "Living", "colorSlot": 15},
    "health": {"id": "health", "name": "Health", "icon": "health", "color": "#F2A0C9", "bucket": "Living", "colorSlot": 8},
    "pets": {"id": "pets", "name": "Pets", "icon": "pets", "color": "#C7A8F0", "bucket": "Lifestyle", "colorSlot": 17},
    "utilities": {"id": "utilities", "name": "Utilities", "icon": "bolt", "color": "#F2C94C", "bucket": "Living", "colorSlot": 10},
    "shopping": {"id": "shopping", "name": "Shopping", "icon": "bag", "color": "#6FD0C9", "bucket": "Lifestyle", "colorSlot": 13},
    "fitness": {"id": "fitness", "name": "Health & Fitness", "icon": "dumbbell", "color": "#8FD46B", "bucket": "Lifestyle", "colorSlot": 6},
    "subs": {"id": "subs", "name": "Subscriptions", "icon": "film", "color": "#F0B27A", "bucket": "Lifestyle", "colorSlot": 18},
    "travel": {"id": "travel", "name": "Travel", "icon": "plane", "color": "#6FB6D0", "bucket": "Lifestyle", "colorSlot": 1},
    "gifts": {"id": "gifts", "name": "Gifts", "icon": "gift", "color": "#E59BD0", "bucket": "Lifestyle", "colorSlot": 7},
    "phonenet": {"id": "phonenet", "name": "Phone & Internet", "icon": "phone", "color": "#B0A8F0", "bucket": "Living", "colorSlot": 16},
}

# How many slots the client ramp exposes. A slot is always in [0, _COLOR_SLOT_COUNT).
# Pinned against the real client ramp by tests/shared/test_color_slot_ramp_drift.py —
# changing this alone fails there, naming src/chartColors.ts.
_COLOR_SLOT_COUNT = 20
_COLOR_SLOT_FIELD = "colorSlot"


def _coerce_slot(raw: Any) -> Optional[int]:
    """A stored colorSlot as a usable slot, or None if absent/corrupt.

    DynamoDB returns numbers as Decimal, so 7 arrives as Decimal('7'). Anything else — a
    string, a fraction, a bool, a negative, or >= _COLOR_SLOT_COUNT — is treated as ABSENT,
    rather than trusted and painting an undefined colour on the client.
    """
    if isinstance(raw, bool) or not isinstance(raw, (int, Decimal)):
        return None
    try:
        value = int(raw)
    except (ValueError, OverflowError):
        return None  # NaN / Infinity: unreachable from DynamoDB, but the contract says None
    if Decimal(raw) != Decimal(value):
        return None
    return value if 0 <= value < _COLOR_SLOT_COUNT else None


def color_slot_counts(items: dict) -> Counter:
    """How many stored categories hold each slot. Corrupt values are ignored so a bad row
    can't make a valid slot look taken.

    Answers "held by how many", not "is it taken" — which is what every rule here needs once
    the ramp is saturated and the answer to the second question is "yes" for all 20. A slot
    nobody holds is simply absent; `Counter` reads it as 0 without inserting it. `set(...)` of
    this is the set of taken slots, if that is ever wanted again.
    """
    return Counter(
        slot
        for slot in (_coerce_slot(cat.get(_COLOR_SLOT_FIELD)) for cat in items.values())
        if slot is not None
    )


# Slots no built-in claims. Preferred for the first repeats (WHIT-404 option B): a duplicate
# has to happen somewhere past 20 categories, and doubling up on a colour only a custom
# category wears is less confusing than doubling up on Eating Out's. Derived from the seed
# table rather than written out, so it cannot drift if the seeds are ever retuned.
_NON_SEED_COLOR_SLOTS = frozenset(range(_COLOR_SLOT_COUNT)) - {
    cat[_COLOR_SLOT_FIELD] for cat in SEED_CATEGORIES.values()
}


def least_held_color_slot(counts: Counter) -> int:
    """The slot to give a category needing one: the least-held one, preferring slots no
    built-in owns, with the lowest slot number breaking any remaining tie.

    While ANY slot is free this is exactly "the lowest free slot" — so a deleted category's
    slot is reused immediately, with no work in delete_category, and a deleted BUILT-IN's slot
    is not passed over in favour of a never-used one.

    Past 20 live categories a duplicate is unavoidable (an error is not acceptable). Handing
    out the least-held slot spreads the repeats across the ramp instead of piling every one of
    them onto slot 0 (WHIT-404). Among equally held slots the seven that no built-in owns go
    first, so the first seven repeats double up on a custom category's colour rather than on
    Eating Out's.

    Iterates `range`, never the Counter, so the answer never depends on insertion order: two
    concurrent creates must compute the same slot.
    """
    free = [slot for slot in range(_COLOR_SLOT_COUNT) if counts[slot] == 0]
    if free:
        return min(free)
    return min(range(_COLOR_SLOT_COUNT),
               key=lambda slot: (counts[slot], slot not in _NON_SEED_COLOR_SLOTS, slot))


def plan_new_category_slot(items: dict) -> int:
    """The slot to give a category about to be added to `items`. Pure, so it can be
    exercised without a database."""
    return least_held_color_slot(color_slot_counts(items))


_CATEGORIES_KEY = {"pk": "CATEGORIES", "sk": "CATEGORIES"}

# Sub-category (parent link) support. `parent` is optional on a category: None
# (or absent, on rows written before this field existed) means a top-level
# category; a value is the id of the parent it rolls up into.
#
# Nesting is capped at _MAX_CATEGORY_DEPTH levels (a top-level category is level 1,
# so the deepest allowed leaf is level 5 — four sub-levels below the top, WHIT-223).
# The cap is enforced only on the writes that ADD depth (create-with-parent and
# re-parent), never on reads or unrelated name/icon/bucket edits, so a chain written
# before the cap existed stays readable and editable — only a new write that would push
# something deeper is refused.
_MAX_CATEGORY_DEPTH = 5
# A SEPARATE, larger cycle bound: it only stops the ancestor walk from looping forever
# on a corrupt cycle in stored data, and never fires before the depth cap on legit data.
_MAX_PARENT_WALK = 100
# Breadth is capped too (WHIT-426), and unlike depth the reason is mechanical rather than
# a product judgement: delete_category detaches every child in ONE conditional write, and
# DynamoDB rejects an UpdateExpression over 4KB. Each child costs a `, #items.#childN
# .#parent = :null` clause; 122 children = 4070 bytes is the last that fits and 123 = 4104
# is rejected, which made DELETE /categories/{id} 500 for that parent. The clause cost is
# independent of the id length — only the #childN alias appears in the expression — so 122
# is a hard universal ceiling, not a typical case. 50 children = 1672 bytes, ~41% of the
# cap, leaving headroom so the clause shape can grow without silently re-breaking.
#
# This bound is only sufficient because delete promotes children to TOP LEVEL, never to the
# grandparent (pinned by test_repo_delete_middle_node_promotes_only_direct_children). If a
# delete ever re-homed children onto the grandparent it could push THAT parent past the cap
# and reopen this bug one level up.
#
# Enforced on the same writes as the depth cap — create-with-parent and re-parent — so data
# written before the cap existed stays readable and editable. delete_category does NOT use
# this number: it measures the expression it actually built, so a grandfathered parent that
# still fits (51-122 children) deletes exactly as it does today.
_MAX_CHILDREN_PER_CATEGORY = 50
# DynamoDB's documented UpdateExpression ceiling. The delete path measures against this
# directly rather than against a child count, so it can't drift from the clause shape.
# tests/lambda_api/test_categories.py keeps its OWN copy of this number, which FakeTable
# enforces — do NOT make the test import this one. The test copy is the oracle (what the
# service does); this one is the belief under test. Merged, an inflated value would move both
# and every size assertion would stop being able to fail.
_MAX_UPDATE_EXPRESSION_BYTES = 4096

# Sentinel for update_category's `parent`: distinguishes "caller omitted parent,
# leave the stored link untouched" from "caller passed parent=None, detach to
# top-level". A plain None default cannot tell those apart, which would silently
# wipe a category's parent on every ordinary name/icon edit.
_PARENT_UNSET = object()


def validate_category_parent(items: dict, cat_id: str, parent_id: str, bucket: str) -> None:
    """Raise InvalidCategoryParentError if making `parent_id` the parent of
    `cat_id` (a category in `bucket`) would be invalid. Pure — reads only the
    given `items` map (id -> category), so it is reused by create and update and
    is unit-testable without DynamoDB.

    Rejects: a category parenting itself; a parent id that does not exist; a
    parent in a different bucket (a sub must roll up into the same bucket as its
    parent); and a link that would close a cycle (the parent is already a
    descendant of this category).
    """
    if parent_id == cat_id:
        raise InvalidCategoryParentError("a category cannot be its own parent")
    parent = items.get(parent_id)
    if parent is None:
        raise InvalidCategoryParentError(f"parent category '{parent_id}' does not exist")
    if parent.get("bucket") != bucket:
        raise InvalidCategoryParentError(
            "a sub-category must be in the same bucket as its parent")
    # Walk up from the proposed parent; reaching cat_id means cat_id is already an
    # ancestor of parent_id, so this link would form a loop.
    ancestor = parent_id
    for _ in range(_MAX_PARENT_WALK):
        if ancestor == cat_id:
            raise InvalidCategoryParentError("this parent would create a cycle")
        node = items.get(ancestor)
        if node is None:
            return
        ancestor = node.get("parent")
        if ancestor is None:
            return
    raise InvalidCategoryParentError("category hierarchy is too deep or contains a cycle")


def _ancestor_depth(items: dict, node_id: str) -> int:
    """The level of `node_id`: the number of nodes from it up to and including its
    top-level root, following `parent` links (a top-level category is level 1).
    Cycle-safe — a corrupt stored cycle terminates via `visited`, returning the count
    walked so far rather than looping. Callers pass a `node_id` known to exist."""
    depth = 0
    visited: set[str] = set()
    current: Optional[str] = node_id
    while current is not None and current not in visited:
        visited.add(current)
        depth += 1
        node = items.get(current)
        if node is None:
            break
        current = node.get("parent")
    return depth


def _subtree_height(items: dict, root_id: str) -> int:
    """The tallest downward chain from `root_id` through its descendants, counted in
    LEVELS: 1 for a leaf (or an id with no children yet, e.g. a not-yet-created
    category), otherwise 1 + the tallest child subtree. Uses max over children (NOT a
    descendant count), so a wide-but-shallow subtree stays shallow. Cycle-safe via
    `visited`; a child is any category whose `parent` is that node."""
    children = build_category_children(list(items.values()))

    def height(node_id: str, visited: set[str]) -> int:
        if node_id in visited:
            return 0  # corrupt cycle: stop counting this branch so the walk terminates
        visited.add(node_id)
        kids = children.get(node_id)
        if not kids:
            return 1
        return 1 + max(height(kid, visited) for kid in kids)

    return height(root_id, set())


def _is_a_no_op_reparent(items: dict, cat_id: str, parent_id: str) -> bool:
    """True when cat_id ALREADY sits under parent_id, so the link adds neither depth nor a
    child. Both caps skip it: a client resubmitting the stored parent on a name/icon edit
    must not be blocked, including on grandfathered data already over a cap (WHIT-223
    Decision 2, WHIT-426). On create, cat_id is absent from items, so this never fires.

    NOT shared with validate_category_parent, which has no skip and must keep none — a
    no-op re-parent still has to be bucket-checked.
    """
    existing = items.get(cat_id)
    return existing is not None and existing.get("parent") == parent_id


def validate_category_depth(items: dict, cat_id: str, parent_id: str) -> None:
    """Raise InvalidCategoryParentError if nesting `cat_id` (together with any subtree
    it already has) under `parent_id` would exceed _MAX_CATEGORY_DEPTH levels. Pure —
    reads only `items` — so it is unit-testable and shared by the create and re-parent
    paths (the only two writes that ADD depth).

    Call AFTER validate_category_parent, which guarantees `parent_id` exists and the
    link forms no cycle — so the upward level walk (from the parent) and the downward
    subtree walk (from cat_id) never overlap. The deepest descendant would land at
    depth(parent) + height(cat_id's subtree): the parent's own level plus the tallest
    chain below cat_id (cat_id itself is one level). On create, cat_id has no subtree
    yet, so its height is 1 and the rule reduces to depth(parent) + 1 <= max."""
    if _is_a_no_op_reparent(items, cat_id, parent_id):
        return
    resulting_depth = _ancestor_depth(items, parent_id) + _subtree_height(items, cat_id)
    if resulting_depth > _MAX_CATEGORY_DEPTH:
        raise InvalidCategoryParentError(
            f"categories can be nested at most {_MAX_CATEGORY_DEPTH} levels deep")


def validate_category_breadth(items: dict, cat_id: str, parent_id: str) -> None:
    """Raise InvalidCategoryParentError if giving `parent_id` one more child would exceed
    _MAX_CHILDREN_PER_CATEGORY. Pure — reads only `items` — so it is unit-testable and
    shared by the create and re-parent paths (the only two writes that ADD a child link;
    delete only ever detaches).

    The cap exists so delete_category's single detach write can never outgrow DynamoDB's
    4KB expression limit — see the _MAX_CHILDREN_PER_CATEGORY comment.
    """
    if _is_a_no_op_reparent(items, cat_id, parent_id):
        return
    children = sum(1 for child in items.values() if child.get("parent") == parent_id)
    if children >= _MAX_CHILDREN_PER_CATEGORY:
        raise InvalidCategoryParentError(
            f"a category can have at most {_MAX_CHILDREN_PER_CATEGORY} sub-categories")


class CategoryRepository(RepositoryBase):
    """Stores the user-defined category taxonomy as a single DynamoDB config item.

    The item at pk=sk="CATEGORIES" holds an `items` map (id -> category) plus a
    numeric `version` for optimistic-locking on writes. Categories are read-heavy
    and rarely written (single user), so a single-item read is the common path;
    writes are conditional and retry once on a version race.
    """

    _config_key = _CATEGORIES_KEY
    _config_label = "categories"

    def _seed_fields(self) -> dict:
        """The seed taxonomy, colour slots included. Deterministic, so a lost seeding race
        wrote exactly the same 13 categories."""
        return {"items": dict(SEED_CATEGORIES)}

    def _raise_if_gone(self, cat_id: str) -> None:
        """After a lost race: id deleted under us (404) vs a concurrent version bump (retry)."""
        if cat_id not in self._get_config()["items"]:
            raise CategoryNotFoundError(cat_id)

    def list_categories(self) -> list[dict]:
        item = self._read_seeded()
        # Default `parent` to None so every category leaving the repo carries the
        # field, even seed rows and rows written before sub-categories existed.
        # The slot goes out as a plain int (DynamoDB hands back a Decimal), None if corrupt.
        return [
            {"parent": None, **cat, _COLOR_SLOT_FIELD: _coerce_slot(cat.get(_COLOR_SLOT_FIELD))}
            for cat in item["items"].values()
        ]

    def create_category(
        self, cat_id: str, name: str, bucket: str, icon: str, parent: Optional[str] = None
    ) -> dict:
        """Add one category. Seeds first so the 13 defaults are never lost, then
        adds a single map key under an optimistic-lock guard. Raises
        DuplicateCategoryError if the id already exists, or
        InvalidCategoryParentError if `parent` is set but invalid (unknown id,
        different bucket, self, or a cycle).
        """
        self._ensure_seeded()
        def build(item):
            items = item["items"]
            if cat_id in items:
                raise DuplicateCategoryError(cat_id)
            if parent is not None:
                validate_category_parent(items, cat_id, parent, bucket)
                validate_category_depth(items, cat_id, parent)
                # Re-run on every attempt against a fresh read, so two racing creates can't
                # both slip past the cap: the loser's conditional write fails and it
                # re-validates against the winner's state.
                validate_category_breadth(items, cat_id, parent)

            # Count taken AFTER seeding, so a new category never reuses a seed's index.
            color = CATEGORY_PALETTE[len(items) % len(CATEGORY_PALETTE)]
            # Computed per attempt from the freshly-read items (same as `color` above): on
            # a retry we re-read, so two concurrent creates can never be handed the same slot.
            slot = plan_new_category_slot(items)
            new_cat = {"id": cat_id, "name": name, "icon": icon, "color": color,
                       "bucket": bucket, "parent": parent,
                       _COLOR_SLOT_FIELD: Decimal(slot)}
            update = {
                # Nested SET adds ONE map key — never rewrites the whole items map.
                "expression": "SET #items.#id = :cat, #v = :next",
                "condition": "attribute_not_exists(#items.#id)",
                "names": {"#items": "items", "#id": cat_id},
                "values": {":cat": new_cat},
            }
            # Store a Decimal (DynamoDB's number type) but RETURN a plain int, so the
            # POST body carries `2` like the GET does — not the `2.0` a Decimal encodes to.
            return update, {**new_cat, _COLOR_SLOT_FIELD: slot}

        def raise_if_duplicate():
            # Disambiguate: duplicate id (409) vs a concurrent version bump (retry).
            if cat_id in self._get_config()["items"]:
                raise DuplicateCategoryError(cat_id)

        return self._versioned_update(
            build, action="create category", seed=False, on_conflict=raise_if_duplicate)

    def update_category(
        self, cat_id: str, name: str, bucket: str, icon: str, parent: Any = _PARENT_UNSET
    ) -> dict:
        """Update a category's editable fields (name, bucket, icon). The id/slug is
        immutable (it's the BankSync vocabulary), and color is server-owned, so
        neither changes here. Raises CategoryNotFoundError if the id is absent.
        `#name` is aliased because `name` is a DynamoDB reserved word; the others
        are aliased for consistency.

        `parent` follows leave-as-is semantics: omit it to leave the stored link
        untouched (so an ordinary name/icon edit never wipes it), pass an id to
        re-parent, or pass None to detach to top-level. A re-parent is validated
        against the current tree. A bucket change is refused while the category
        has children, since that would break the same-bucket rule for its subs.
        """
        changing_parent = parent is not _PARENT_UNSET
        def build(item):
            items = item["items"]
            if cat_id not in items:
                raise CategoryNotFoundError(cat_id)
            bucket_changing = bucket != items[cat_id].get("bucket")
            if changing_parent and parent is not None:
                validate_category_parent(items, cat_id, parent, bucket)
                validate_category_depth(items, cat_id, parent)
                validate_category_breadth(items, cat_id, parent)
            elif not changing_parent and bucket_changing:
                # A plain edit can flip the bucket without touching the parent link;
                # if this row IS a sub, it must stay in its parent's bucket.
                stored_parent = items[cat_id].get("parent")
                if stored_parent is not None:
                    validate_category_parent(items, cat_id, stored_parent, bucket)
            if bucket_changing and any(
                child.get("parent") == cat_id for child in items.values()
            ):
                raise InvalidCategoryParentError(
                    f"cannot change the bucket of '{cat_id}' while it has sub-categories")

            names = {"#items": "items", "#id": cat_id, "#name": "name",
                     "#bucket": "bucket", "#icon": "icon"}
            values = {":name": name, ":bucket": bucket, ":icon": icon}
            set_clause = (
                "#items.#id.#name = :name, #items.#id.#bucket = :bucket, "
                "#items.#id.#icon = :icon, #v = :next"
            )
            if changing_parent:
                names["#parent"] = "parent"
                values[":parent"] = parent
                set_clause += ", #items.#id.#parent = :parent"
            update = {"expression": "SET " + set_clause,
                      "condition": "attribute_exists(#items.#id)",
                      "names": names, "values": values}
            # Build the response from the pre-read item so id/color survive;
            # reflect the resolved parent (new one if changed, else stored).
            resolved_parent = parent if changing_parent else items[cat_id].get("parent")
            # The stored slot as a plain int, the same value GET returns, so the body
            # carries `2` rather than the `2.0` a Decimal encodes to.
            result = {**items[cat_id], "name": name, "bucket": bucket,
                      "icon": icon, "parent": resolved_parent,
                      _COLOR_SLOT_FIELD: _coerce_slot(items[cat_id].get(_COLOR_SLOT_FIELD))}
            return update, result

        return self._versioned_update(
            build, action="update category", on_conflict=lambda: self._raise_if_gone(cat_id))

    def delete_category(self, cat_id: str) -> str:
        """Hard-delete a category (REMOVE its map key). No server-side cascade for
        transactions — those still referencing the id render as Uncategorized
        client-side. Any sub-categories are promoted to top-level (their `parent`
        is cleared) in the SAME atomic write, so deleting a parent never strands
        its children pointing at a gone id. Raises CategoryNotFoundError if the id
        is absent.

        One write stays safe because the expression is MEASURED before it is sent (below) —
        the breadth cap is the margin that keeps new data far away from the limit, not the
        mechanism. Data written before that cap can still be over-wide, and is refused with a
        400 rather than left to fail as an uncaught 500 (WHIT-426).
        """
        def build(item):
            items = item["items"]
            if cat_id not in items:
                raise CategoryNotFoundError(cat_id)

            child_ids = [cid for cid, child in items.items() if child.get("parent") == cat_id]
            names = {"#items": "items", "#id": cat_id}
            values = {}
            set_clause = "#v = :next"
            if child_ids:
                # Detach each child to top-level (parent -> None) alongside the delete.
                names["#parent"] = "parent"
                values[":null"] = None
                for index, child_id in enumerate(child_ids):
                    alias = f"#child{index}"
                    names[alias] = child_id
                    set_clause += f", #items.{alias}.#parent = :null"
            # REMOVE drops the deleted key; SET bumps the version (and clears any children's
            # parent). The config item itself stays.
            expression = f"REMOVE #items.#id SET {set_clause}"
            # Measure the real expression rather than counting children against the breadth
            # cap (WHIT-426). New data can't get here — the cap keeps it far under — but data
            # written before the cap can, and a parent with 51-122 children still FITS. Sizing
            # the guard by the product cap would refuse a delete that works today. Measuring
            # also can't drift: add a second clause per child and this stays correct.
            if len(expression.encode()) > _MAX_UPDATE_EXPRESSION_BYTES:
                raise InvalidCategoryParentError(
                    f"'{cat_id}' has {len(child_ids)} sub-categories — too many to detach in "
                    f"one write; move some out from under it first")
            update = {"expression": expression, "condition": "attribute_exists(#items.#id)",
                      "names": names, "values": values}
            return update, cat_id

        return self._versioned_update(
            build, action="delete category", on_conflict=lambda: self._raise_if_gone(cat_id))
