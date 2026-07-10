"""Category taxonomy storage: the user-defined categories as a single DynamoDB
config item, with the seed taxonomy and colour palette kept local to this module."""

from decimal import Decimal
from typing import Any, Optional

import boto3
from botocore.exceptions import ClientError

from repository_base import REGION_NAME, TABLE_NAME, handle_database_error
from repository_errors import (
    CategoryNotFoundError,
    DuplicateCategoryError,
    InvalidCategoryParentError,
    VersionConflictError,
)

# Category taxonomy data lives here, not in constants.py, on purpose: this module
# ships in the Lambda layer, and a `from constants import ...` here binds to the
# FUNCTION's constants.py — coupling the layer to another package's symbols. A
# deploy skew there fails this import at module load and 500s EVERY route
# (including /transactions). The palette + seed are used only by CategoryRepository,
# so keeping them local makes the layer self-contained. Ids are the curated slugs
# from src/context.tsx SEED_CATS (the vocabulary BankSync rules + client
# budgets/rules reference); `recent` is omitted (client-derived).
CATEGORY_PALETTE = [
    "#E8A87C", "#7FD49B", "#F08C8C", "#8AB4F8", "#F2A0C9",
    "#C7A8F0", "#F2C94C", "#6FD0C9", "#8FD46B", "#B0A8F0",
]

SEED_CATEGORIES = {
    "coffee": {"id": "coffee", "name": "Cafes & Coffee", "icon": "coffee", "color": "#E8A87C", "bucket": "Lifestyle"},
    "groceries": {"id": "groceries", "name": "Groceries", "icon": "cart", "color": "#7FD49B", "bucket": "Living"},
    "eatingout": {"id": "eatingout", "name": "Eating Out", "icon": "food", "color": "#F08C8C", "bucket": "Lifestyle"},
    "transport": {"id": "transport", "name": "Transport", "icon": "car", "color": "#8AB4F8", "bucket": "Living"},
    "health": {"id": "health", "name": "Health", "icon": "health", "color": "#F2A0C9", "bucket": "Living"},
    "pets": {"id": "pets", "name": "Pets", "icon": "pets", "color": "#C7A8F0", "bucket": "Lifestyle"},
    "utilities": {"id": "utilities", "name": "Utilities", "icon": "bolt", "color": "#F2C94C", "bucket": "Living"},
    "shopping": {"id": "shopping", "name": "Shopping", "icon": "bag", "color": "#6FD0C9", "bucket": "Lifestyle"},
    "fitness": {"id": "fitness", "name": "Health & Fitness", "icon": "dumbbell", "color": "#8FD46B", "bucket": "Lifestyle"},
    "subs": {"id": "subs", "name": "Subscriptions", "icon": "film", "color": "#F0B27A", "bucket": "Lifestyle"},
    "travel": {"id": "travel", "name": "Travel", "icon": "plane", "color": "#6FB6D0", "bucket": "Lifestyle"},
    "gifts": {"id": "gifts", "name": "Gifts", "icon": "gift", "color": "#E59BD0", "bucket": "Lifestyle"},
    "phonenet": {"id": "phonenet", "name": "Phone & Internet", "icon": "phone", "color": "#B0A8F0", "bucket": "Living"},
}


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
    children: dict[str, list[str]] = {}
    for cat in items.values():
        parent = cat.get("parent")
        if parent is not None:
            children.setdefault(parent, []).append(cat["id"])

    def height(node_id: str, visited: set[str]) -> int:
        if node_id in visited:
            return 0  # corrupt cycle: stop counting this branch so the walk terminates
        visited.add(node_id)
        kids = children.get(node_id)
        if not kids:
            return 1
        return 1 + max(height(kid, visited) for kid in kids)

    return height(root_id, set())


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
    # A no-op re-parent (cat_id already sits under parent_id) adds no depth — the tree is
    # unchanged — so it can never breach the cap. Skip the check, so re-saving a category
    # whose parent is unchanged is never rejected. This matters for a grandfathered chain
    # deeper than the cap: a client that resubmits the (unchanged) stored parent must not be
    # blocked, matching the name/icon-edit grandfather guarantee (WHIT-223 Decision 2). On
    # create, cat_id is absent from items, so this never short-circuits a real new link.
    existing = items.get(cat_id)
    if existing is not None and existing.get("parent") == parent_id:
        return
    resulting_depth = _ancestor_depth(items, parent_id) + _subtree_height(items, cat_id)
    if resulting_depth > _MAX_CATEGORY_DEPTH:
        raise InvalidCategoryParentError(
            f"categories can be nested at most {_MAX_CATEGORY_DEPTH} levels deep")


class CategoryRepository:
    """Stores the user-defined category taxonomy as a single DynamoDB config item.

    The item at pk=sk="CATEGORIES" holds an `items` map (id -> category) plus a
    numeric `version` for optimistic-locking on writes. Categories are read-heavy
    and rarely written (single user), so a single-item read is the common path;
    writes are conditional and retry once on a version race.
    """

    def __init__(self) -> None:
        self._dynamodb = None
        self._table = None

    def _get_table(self) -> Any:
        if self._table is None:
            self._dynamodb = boto3.resource("dynamodb", region_name=REGION_NAME)
            self._table = self._dynamodb.Table(TABLE_NAME)
        return self._table

    def _get_config(self) -> Optional[dict]:
        try:
            return self._get_table().get_item(Key=_CATEGORIES_KEY).get("Item")
        except ClientError as e:
            handle_database_error(e, "read categories")

    def _ensure_seeded(self) -> None:
        """Idempotently write the seed taxonomy if the config item is absent.

        A lost race (another caller seeded first) raises ConditionalCheckFailed
        and is a no-op success: the seed content is deterministic, so the winner
        wrote exactly the same 13 categories.
        """
        try:
            self._get_table().put_item(
                Item={**_CATEGORIES_KEY, "items": dict(SEED_CATEGORIES), "version": Decimal(1)},
                ConditionExpression="attribute_not_exists(pk)",
            )
        except ClientError as e:
            if e.response["Error"]["Code"] == "ConditionalCheckFailedException":
                return
            handle_database_error(e, "seed categories")

    def list_categories(self) -> list[dict]:
        item = self._get_config()
        if item is None:
            self._ensure_seeded()
            item = self._get_config()  # re-read so a concurrent create is reflected
        # Default `parent` to None so every category leaving the repo carries the
        # field, even seed rows and rows written before sub-categories existed.
        return [{"parent": None, **cat} for cat in item["items"].values()]

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
        for _attempt in range(2):
            item = self._get_config()
            items = item["items"]
            version = item["version"]
            if cat_id in items:
                raise DuplicateCategoryError(cat_id)
            if parent is not None:
                validate_category_parent(items, cat_id, parent, bucket)
                validate_category_depth(items, cat_id, parent)

            # Count taken AFTER seeding, so a new category never reuses a seed's index.
            color = CATEGORY_PALETTE[len(items) % len(CATEGORY_PALETTE)]
            new_cat = {"id": cat_id, "name": name, "icon": icon, "color": color,
                       "bucket": bucket, "parent": parent}
            try:
                self._get_table().update_item(
                    Key=_CATEGORIES_KEY,
                    # Nested SET adds ONE map key — never rewrites the whole items map.
                    UpdateExpression="SET #items.#id = :cat, #v = :next",
                    ConditionExpression=(
                        "attribute_exists(pk) AND #v = :expected "
                        "AND attribute_not_exists(#items.#id)"
                    ),
                    ExpressionAttributeNames={"#items": "items", "#id": cat_id, "#v": "version"},
                    ExpressionAttributeValues={
                        ":cat": new_cat,
                        ":expected": version,
                        ":next": version + Decimal(1),
                    },
                )
                return new_cat
            except ClientError as e:
                if e.response["Error"]["Code"] != "ConditionalCheckFailedException":
                    handle_database_error(e, "create category")
                # Disambiguate: duplicate id (409) vs a concurrent version bump (retry).
                latest = self._get_config()
                if cat_id in latest["items"]:
                    raise DuplicateCategoryError(cat_id)
                # id still free — the version moved under us; loop retries once.
        raise VersionConflictError("create_category: exhausted retries under write contention")

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
        self._ensure_seeded()
        for _attempt in range(2):
            item = self._get_config()
            items = item["items"]
            version = item["version"]
            if cat_id not in items:
                raise CategoryNotFoundError(cat_id)
            bucket_changing = bucket != items[cat_id].get("bucket")
            if changing_parent and parent is not None:
                validate_category_parent(items, cat_id, parent, bucket)
                validate_category_depth(items, cat_id, parent)
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

            names = {
                "#items": "items", "#id": cat_id, "#name": "name",
                "#bucket": "bucket", "#icon": "icon", "#v": "version",
            }
            values = {
                ":name": name,
                ":bucket": bucket,
                ":icon": icon,
                ":expected": version,
                ":next": version + Decimal(1),
            }
            set_clause = (
                "#items.#id.#name = :name, #items.#id.#bucket = :bucket, "
                "#items.#id.#icon = :icon, #v = :next"
            )
            if changing_parent:
                names["#parent"] = "parent"
                values[":parent"] = parent
                set_clause += ", #items.#id.#parent = :parent"
            try:
                self._get_table().update_item(
                    Key=_CATEGORIES_KEY,
                    UpdateExpression="SET " + set_clause,
                    ConditionExpression=(
                        "attribute_exists(pk) AND #v = :expected "
                        "AND attribute_exists(#items.#id)"
                    ),
                    ExpressionAttributeNames=names,
                    ExpressionAttributeValues=values,
                )
                # Build the response from the pre-read item so id/color survive;
                # reflect the resolved parent (new one if changed, else stored).
                resolved_parent = parent if changing_parent else items[cat_id].get("parent")
                return {**items[cat_id], "name": name, "bucket": bucket,
                        "icon": icon, "parent": resolved_parent}
            except ClientError as e:
                if e.response["Error"]["Code"] != "ConditionalCheckFailedException":
                    handle_database_error(e, "update category")
                # Disambiguate: id deleted under us (404) vs a concurrent version bump (retry).
                latest = self._get_config()
                if cat_id not in latest["items"]:
                    raise CategoryNotFoundError(cat_id)
                # id still present — the version moved under us; loop retries once.
        raise VersionConflictError("update_category: exhausted retries under write contention")

    def delete_category(self, cat_id: str) -> str:
        """Hard-delete a category (REMOVE its map key). No server-side cascade for
        transactions — those still referencing the id render as Uncategorized
        client-side. Any sub-categories are promoted to top-level (their `parent`
        is cleared) in the SAME atomic write, so deleting a parent never strands
        its children pointing at a gone id. Raises CategoryNotFoundError if the id
        is absent.
        """
        self._ensure_seeded()
        for _attempt in range(2):
            item = self._get_config()
            items = item["items"]
            version = item["version"]
            if cat_id not in items:
                raise CategoryNotFoundError(cat_id)

            child_ids = [cid for cid, child in items.items() if child.get("parent") == cat_id]
            names = {"#items": "items", "#id": cat_id, "#v": "version"}
            values = {":expected": version, ":next": version + Decimal(1)}
            set_clause = "#v = :next"
            if child_ids:
                # Detach each child to top-level (parent -> None) alongside the delete.
                names["#parent"] = "parent"
                values[":null"] = None
                for index, child_id in enumerate(child_ids):
                    alias = f"#child{index}"
                    names[alias] = child_id
                    set_clause += f", #items.{alias}.#parent = :null"
            try:
                self._get_table().update_item(
                    Key=_CATEGORIES_KEY,
                    # REMOVE drops the deleted key; SET bumps the version (and clears
                    # any children's parent). The config item itself stays.
                    UpdateExpression=f"REMOVE #items.#id SET {set_clause}",
                    ConditionExpression=(
                        "attribute_exists(pk) AND #v = :expected "
                        "AND attribute_exists(#items.#id)"
                    ),
                    ExpressionAttributeNames=names,
                    ExpressionAttributeValues=values,
                )
                return cat_id
            except ClientError as e:
                if e.response["Error"]["Code"] != "ConditionalCheckFailedException":
                    handle_database_error(e, "delete category")
                latest = self._get_config()
                if cat_id not in latest["items"]:
                    raise CategoryNotFoundError(cat_id)
                # id still present — the version moved under us; loop retries once.
        raise VersionConflictError("delete_category: exhausted retries under write contention")
