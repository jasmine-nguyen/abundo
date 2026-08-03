"""Category taxonomy storage: the user-defined categories as a single DynamoDB
config item, with the seed taxonomy and colour palette kept local to this module."""

import logging
from collections import Counter
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
# ONE exception, once per store: the schema-1 -> schema-2 repaint (WHIT-428). Stores migrated
# under the old constant slot-0 overflow are piled — up to 11 categories on Eating Out's
# colour — so they are levelled once, then never again.
#
# While that migration drains, the read path previews the colours it is ABOUT to store, and a
# not-yet-written row can preview one colour and settle on another. TWO causes, both accepted:
#   - the stage hand-off. A read only ever previews the CURRENT stage, so while the backfill is
#     draining the repaint's moves are invisible; they appear once the backfill finishes.
#   - a create or delete landing mid-drain, which shifts the allowance and the running counts.
# A WRITTEN slot is never rewritten. The alternative — previewing nothing, so the user sees the
# old piled colours for several reads and then every one of them flips at once — is a bigger
# visible jump, which is why this is the trade.
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
# stored, so existing accounts keep the old layout (WHIT-405). The WHIT-428 repaint does not
# change that: it only moves rows off an OVER-SUBSCRIBED colour, and a built-in sitting on its
# own designated slot is always the keeper. A built-in sitting on some OTHER built-in's slot has
# only alphabetical priority there, so the repaint may move it.
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
_COLOR_SLOT_COUNT = 20
_COLOR_SLOT_FIELD = "colorSlot"
# Marker on the CONFIG ITEM saying every stored category has been stamped. Its presence is
# what makes the migration one-time rather than a re-check on every read. Versions:
#   1 = every row holds a valid slot
#   2 = ...and no colour is worn by more categories than it has to be (WHIT-428's repaint)
# _is_slot_migrated compares >=, so a store stamped 1 reads as unmigrated and repaints once.
_COLOR_SLOT_SCHEMA_FIELD = "colorSlotSchema"
_COLOR_SLOT_SCHEMA = 2
# How many categories one backfill write may stamp (WHIT-405). DynamoDB caps an
# UpdateExpression at 4KB; each clause costs 29-33 bytes depending on the index width, over a
# 33-byte base, so 129 clauses (4070 bytes) is the last that fits and 130 (4103) is rejected.
# An unchunked plan past that point made create_category 500 forever — the write could never
# succeed and it runs fail-closed. 50 is ~1.6KB, leaving ~2.5x headroom so the clause shape
# can grow without silently re-breaking. Successive requests drain the rest.
_COLOR_SLOT_WRITE_CHUNK = 50


def _coerce_slot(raw: Any) -> Optional[int]:
    """A stored colorSlot as a usable slot, or None if absent/corrupt.

    DynamoDB returns numbers as Decimal, so 7 arrives as Decimal('7'). Anything else — a
    string, a fraction, a bool, a negative, or >= _COLOR_SLOT_COUNT — is treated as ABSENT
    and reassigned, rather than trusted and painting an undefined colour on the client.
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


def _coerce_slot_schema(raw: Any) -> int:
    """The stored schema marker as an int; anything unreadable counts as 'not migrated'."""
    if isinstance(raw, bool) or not isinstance(raw, (int, Decimal)):
        return 0
    try:
        return int(raw)
    except (ValueError, OverflowError):
        return 0


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
# category wears is less confusing than doubling up on Eating Out's. Applies to the BACKFILL
# and the repaint too, not just the create path — all three share least_held_color_slot
# (WHIT-428). Derived from the seed table rather than written out, so it cannot drift if the
# seeds are ever retuned.
_NON_SEED_COLOR_SLOTS = frozenset(range(_COLOR_SLOT_COUNT)) - {
    cat[_COLOR_SLOT_FIELD] for cat in SEED_CATEGORIES.values()
}


def least_held_color_slot(counts: Counter, reserved: frozenset,
                          protected: frozenset = frozenset()) -> int:
    """The slot to give a category needing one: the least-held one, preferring slots no
    built-in owns, with the lowest slot number breaking any remaining tie.

    THE ONE ASSIGNER. Both the create path and the backfill planner's pass 2 use this
    (WHIT-428); they used to differ, and the backfill's old constant slot-0 overflow is what
    piled 11 categories onto Eating Out's colour on a 30-category legacy store.

    While ANY slot is free this is exactly "the lowest free slot", non-seed preference and all
    — so a deleted category's slot is still reused immediately, with no work in
    delete_category, and a deleted BUILT-IN's slot is not passed over in favour of a
    never-used one. The preference only decides which colour to DOUBLE UP on, which is a
    question that does not exist until the ramp is full.

    Past 20 live categories a duplicate is unavoidable (an error is not acceptable). Handing
    out the least-held slot spreads the repeats across the ramp instead of piling every one of
    them onto slot 0, which is what the old lowest-free walk did (WHIT-404). Among equally
    held slots the seven that no built-in owns go first, so the first seven repeats double up
    on a custom category's colour rather than on Eating Out's — the first built-in clash moves
    from the 21st category to the 28th.

    `reserved` is a HARD exclusion, not a weight. Slots the pending backfill owes must not be
    candidates at all: an owed slot is held by nobody, so counting it as merely +1 would leave
    it tied with a singly-held slot and the tie-break would hand it straight over — stealing a
    built-in's designated colour permanently.

    NOTE what the fallback drops. When `reserved` covers all 20 slots the fallback re-derives
    its candidates from `range`, so ONLY `protected` still applies — a caller that folded a
    soft cap into `reserved` (as plan_new_category_slot does with `crowded`) loses that cap
    exactly when the store is most crowded. Benign in practice: the backfill hands its pending
    slots to the emptiest slots while a capped slot is by definition among the fullest, so the
    least-held tie-break avoids them anyway. Carded rather than patched — the fix is to give
    this function one preference structure instead of two overloaded frozensets.

    `protected` is the SECOND tier, and only matters once every slot is owed and something has
    to be taken back. Those are the slots owed to a BUILT-IN for its OWN designated hue. Taking
    a custom row's owed slot is harmless — the next re-plan simply moves that row — but a
    built-in robbed of its designation never gets it back, because pass 1 only entitles it
    while the slot is free. Once the backfill spreads (WHIT-428) a saturated store's plan can
    own all 20 slots, so this branch became reachable on real stores rather than theoretical.

    Iterates `range`, never the Counter, so the answer never depends on insertion order: two
    concurrent creates must compute the same slot.
    """
    def least_held(slots) -> int:
        """Fewest holders wins; among equals a slot no built-in owns; then the lowest number.
        False sorts before True, so the non-seed test reads as "seed slots go last"."""
        return min(slots,
                   key=lambda slot: (counts[slot], slot not in _NON_SEED_COLOR_SLOTS, slot))

    candidates = [slot for slot in range(_COLOR_SLOT_COUNT) if slot not in reserved]
    if not candidates:
        # Every slot is owed, so something must be taken back. Take it from a slot owed to a
        # CUSTOM row: that row is simply re-planned onto another slot, while a built-in robbed
        # of its designated hue never gets it back. NOT the free-slot branch, which would hand
        # over the lowest owed slot — usually eatingout's slot 0.
        spare = [slot for slot in range(_COLOR_SLOT_COUNT) if slot not in protected]
        # `protected` is a subset of the 13 seed slots, so `spare` always has the 7 non-seed
        # slots in it. The fallback is defensive only, for a caller that protects all 20.
        return least_held(spare or range(_COLOR_SLOT_COUNT))
    free = [slot for slot in candidates if counts[slot] == 0]
    if free:
        return min(free)
    return least_held(candidates)  # saturated: a duplicate is unavoidable, so spread it


def plan_color_slot_backfill(items: dict) -> dict:
    """{category id -> slot} for every stored category missing a valid slot.

    Pure and deterministic, so the read path can apply the plan in memory and the write path
    can persist the identical mapping — two concurrent requests compute the same answer, so
    losing the race to write costs nothing.

    A built-in claims its designated seed slot when that slot is still free. That is what
    keeps an existing store's 13 built-ins on the hues they were solved for; a naive
    lowest-free walk would hand them arbitrary colours instead.

    Pass 2 hands out the LEAST-HELD slot, the same rule the create path uses (WHIT-428). While
    any slot is still free that is exactly the old lowest-free answer, so nothing below 20
    categories moves; past saturation it spreads the repeats instead of piling every one onto
    slot 0. Both passes carry a live `counts`, so pass 2 sees what pass 1 already claimed.

    ITERATION ORDER IS THE DRAIN ORDER — see color_slot_plan_order, which the chunked write
    depends on. Do not re-sort the returned mapping.
    """
    counts = color_slot_counts(items)
    plan = {}
    missing = sorted(
        cat_id for cat_id, cat in items.items()
        if _coerce_slot(cat.get(_COLOR_SLOT_FIELD)) is None
    )
    for cat_id in missing:  # pass 1: built-ins take their designated slot
        seed = SEED_CATEGORIES.get(cat_id)
        if seed is not None and counts[seed[_COLOR_SLOT_FIELD]] == 0:
            plan[cat_id] = seed[_COLOR_SLOT_FIELD]
            counts[plan[cat_id]] += 1
    for cat_id in missing:  # pass 2: everything else, least-held, alphabetical
        if cat_id not in plan:
            plan[cat_id] = least_held_color_slot(counts, frozenset())
            counts[plan[cat_id]] += 1
    return plan


def color_slot_plan_order(plan: dict) -> list:
    """The order a plan MUST be drained in, and the reason chunking equals one shot.

    Used for BOTH plans this module produces, and each is a fixed point for its own reason.

    A BACKFILL plan is in plan_color_slot_backfill's build order: every pass-1 built-in first
    (at most 13, so ALWAYS inside the first chunk), then everything else alphabetically. A
    chunk can no longer consume a built-in's designated slot before pass 1 reaches it, because
    pass 1 is already drained. Sorting instead diverges on roughly half of randomised stores,
    which is why the old alphabetical prefix stopped working the moment pass 2 started
    spreading (WHIT-428).

    A REPAINT plan is already alphabetical (`sorted(movers)`), so the order costs nothing
    there; its fixed point comes from the allowance depending only on the ROW COUNT, which a
    partial write does not change. Same call, different argument — do not "simplify" this to
    apply only to the backfill.
    """
    return list(plan)


def _repaint_allowance(row_count: int) -> int:
    """The most categories one colour may be worn by once the ramp is level: ceil(rows/20).

    Depends ONLY on how many categories the store has, never on where they sit. That is
    exactly what lets a half-written repaint be re-planned to the same answer, which is what
    makes chunking the repaint equivalent to one shot.

    At least 1 for any non-empty store, so a colour worn by a single category is never a
    mover — that is the permanence promise, and it falls out of the arithmetic rather than
    needing a floor clamped on top. At row_count 0 it returns 0, which is meaningless but
    INERT rather than unreachable: a store whose categories were all deleted really does reach
    it, via _repaint_movers, whose `by_slot` is then empty so the 0 is never compared to
    anything. The other caller passes len(items) + 1 and can never reach it.
    """
    return -(-row_count // _COLOR_SLOT_COUNT)


def _repaint_movers(items: dict) -> list:
    """The map KEYS that must leave their slot, alphabetically.

    Keyed by the MAP KEY, never the inner "id" field — the plan, the write and the read-path
    overlay are all map-keyed, so a row whose inner id disagrees would otherwise be planned
    under one name and stamped under another.

    Keeper priority per slot is ABSOLUTE, so the same rows keep the slot on every
    recomputation: the built-in whose DESIGNATED slot this is goes first (it never loses the
    hue it was solved for), then alphabetical. A slot held by `allowance` or fewer categories
    produces no movers at all — a stored slot stays permanent unless it is part of a pile.
    """
    allowance = _repaint_allowance(len(items))
    by_slot = {}
    for cat_id, cat in items.items():
        slot = _coerce_slot(cat.get(_COLOR_SLOT_FIELD))
        if slot is not None:
            by_slot.setdefault(slot, []).append(cat_id)
    movers = []
    for slot, holders in by_slot.items():
        holders.sort(key=lambda cat_id: (
            (SEED_CATEGORIES.get(cat_id) or {}).get(_COLOR_SLOT_FIELD) != slot, cat_id))
        movers.extend(holders[allowance:])
    return sorted(movers)


def plan_color_slot_repaint(items: dict) -> dict:
    """{map key -> new slot} for rows piled above the allowance, and nothing else.

    PRECONDITION: every row already holds a valid slot. The allowance counts ALL rows while
    the histogram counts only slotted ones, and nothing here excludes the slots a pending
    backfill owes — so on a half-slotted store this plan can collide with that backfill. Call
    it through plan_color_slot_stage, which sequences the two, not directly.

    The one-off levelling of stores that migrated under WHIT-404's constant slot-0 overflow
    (WHIT-428). Empty once the ramp is level, which is why an already-level store costs one
    marker-only write and nothing more.

    Minimal churn on purpose: only the rows ABOVE the allowance move. A full re-plan would
    repaint ~24% more rows, including rows a POST already told the client about.

    A destination can never itself exceed the allowance: the keepers total at most
    20*allowance and the movers are unplaced, so some slot is always strictly below it and
    least_held_color_slot picks the minimum. So a moved row is never a mover again, and a
    row's source is never its own destination.
    """
    movers = _repaint_movers(items)
    if not movers:
        return {}
    moving = set(movers)
    counts = color_slot_counts(
        {cat_id: cat for cat_id, cat in items.items() if cat_id not in moving}
    )
    plan = {}
    for cat_id in movers:
        plan[cat_id] = least_held_color_slot(counts, frozenset())
        counts[plan[cat_id]] += 1
    return plan


def _with_slots(items: dict, plan: dict) -> dict:
    """`items` as it will read once `plan` is persisted.

    A projection, not an application: it never mutates the caller's rows. `list_categories`
    holds those same row objects and reads them again to build the response, so a planner that
    wrote through them would be acting at a distance on its caller's data.
    """
    return {
        cat_id: ({**cat, _COLOR_SLOT_FIELD: Decimal(plan[cat_id])} if cat_id in plan else cat)
        for cat_id, cat in items.items()
    }


def plan_color_slot_stage(items: dict, *, repainted: bool) -> tuple:
    """(the next mapping to persist, whether persisting it SETTLES the store).

    Two stages, in order. Stage 1 is the backfill: while any row lacks a slot the histogram is
    not meaningful yet, so the repaint waits. Stage 2 is the one-off repaint, skipped entirely
    once the store carries the schema-2 marker — that skip is what makes a colour change happen
    at most once, even if a later delete would put a slot back over the allowance.

    `settled` is what the marker waits on, and it is "does anything follow THIS plan", not
    "which stage is this". A store needing BOTH stages must not be stamped on the backfill's
    last chunk, or the row the repaint owed is stranded on a shared colour forever. But a store
    needing only the backfill must still stamp on that last chunk — answering "no" there would
    cost every legacy store an extra write, which the chunk-boundary tests pin.

    An already-repainted store still backfills (a corrupt stored slot would produce a plan) and
    is settled by it: the migration is over, and the repaint must not run a second time.
    """
    backfill = plan_color_slot_backfill(items)
    if repainted:
        return backfill, True
    if backfill:
        return backfill, not plan_color_slot_repaint(_with_slots(items, backfill))
    return plan_color_slot_repaint(items), True


def plan_new_category_slot(items: dict) -> int:
    """The slot to give a category about to be added to `items`.

    Pure, like every other rule in this module, so it can be exercised without a database.

    Slots the pending backfill owes are RESERVED — a hard exclusion, not a weight, so a create
    cannot steal a colour the backfill is about to assign. The ranking `counts` comes from the
    STORED slots only: feeding the owed slots in as counts would leave an owed-but-unheld slot
    tied with a singly-held one, and the tie-break would hand it straight over (WHIT-404).

    Once the backfill spreads (WHIT-428) a saturated store's plan can owe ALL 20 slots, so the
    "every slot is owed" fallback became reachable — and it ignores `reserved` by design.
    `protected` keeps a built-in's own designated hue out of that fallback, so the slot taken
    back is a custom row's, which the next re-plan simply moves.

    `crowded` is the CAP, and it is why the PROJECTED counts exist. Mid-drain the stored counts
    cover only the rows already stamped, so they understate every slot the backfill is still
    piling onto — while the repaint's allowance is computed from the WHOLE store. That gap let
    a create take a slot the backfill then pushed over the allowance, so the repaint evicted
    the row the POST had already told the client about. Projection caps; stored counts rank.
    Once a store is fully stamped this is provably a no-op: sum(counts) == rows, so the
    least-held slot is always under the allowance and the choice is unchanged.
    """
    pending = plan_color_slot_backfill(items)
    counts = color_slot_counts(items)
    projected = counts + Counter(pending.values())      # Counter + returns a NEW counter
    allowance = _repaint_allowance(len(items) + 1)      # the row is about to be added
    crowded = frozenset(slot for slot in range(_COLOR_SLOT_COUNT)
                        if projected[slot] >= allowance)
    reserved = frozenset(pending.values())
    return least_held_color_slot(counts, reserved | crowded, _designated_builtin_slots(pending))


def _previewed_slot(plan: dict, cat_id: str, cat: dict) -> Optional[int]:
    """The slot a row READS as: the pending plan's value, else its stored one.

    GET and PATCH must answer identically. Echoing the STORED value on PATCH while GET
    returned the previewed one is WHIT-428's regression — they agree on a settled store and
    disagree for the whole migration window, and the client writes the PATCH body straight
    into its cached list, so an edit made the category's chart colour flip back.
    """
    return plan.get(cat_id, _coerce_slot(cat.get(_COLOR_SLOT_FIELD)))


def _designated_builtin_slots(plan: dict) -> frozenset:
    """Of a pending backfill, the slots owed to a BUILT-IN for its OWN designated hue.

    Matches on the planned slot EQUALLING the seed's designation: a built-in that pass 2 put
    somewhere else has no claim on that slot, so it must not be protected there.
    """
    return frozenset(
        slot for cat_id, slot in plan.items()
        if (SEED_CATEGORIES.get(cat_id) or {}).get(_COLOR_SLOT_FIELD) == slot
    )


_CATEGORIES_KEY = {"pk": "CATEGORIES", "sk": "CATEGORIES"}

# Same stream as repository_base, so a deferred backfill is visible next to DB errors.
logger = logging.getLogger("repository")

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
                # The slot marker rides the seed write, so a brand-new store is born
                # migrated and never performs a backfill update.
                Item={**_CATEGORIES_KEY, "items": dict(SEED_CATEGORIES), "version": Decimal(1),
                      _COLOR_SLOT_SCHEMA_FIELD: Decimal(_COLOR_SLOT_SCHEMA)},
                ConditionExpression="attribute_not_exists(pk)",
            )
        except ClientError as e:
            if e.response["Error"]["Code"] == "ConditionalCheckFailedException":
                return
            handle_database_error(e, "seed categories")

    def _is_slot_migrated(self, item: dict) -> bool:
        """Has this store already been stamped? A corrupt marker reads as 'no', which just
        re-stamps — cheaper than reasoning about a half-written value."""
        raw = _coerce_slot_schema(item.get(_COLOR_SLOT_SCHEMA_FIELD))
        return raw >= _COLOR_SLOT_SCHEMA

    def _write_color_slots(self, version: Any, plan: dict, *, strict: bool,
                           settled: bool) -> None:
        """Persist up to _COLOR_SLOT_WRITE_CHUNK of a colour-slot plan, stamping the store as
        migrated once the plan is fully drained AND nothing follows it.

        `settled` has NO default on purpose. _is_slot_migrated compares >=, so a store stamped
        by a call site that forgot the flag would never repaint and would stay mispainted
        forever. A missed call site must be a TypeError, not a silent permanent bug.

        CHUNKING IS EQUIVALENT TO ONE SHOT, and not for the obvious reason. It is NOT because
        planned slots are distinct — past 20 unslotted rows they are not, the assigner hands
        repeats to many rows. It holds because persisting a prefix OF THE DRAIN ORDER
        (color_slot_plan_order) is a fixed point of the planner. Two halves:
          - pass 1 is stable: every built-in claiming its designation is in the first chunk, so
            no later row can be persisted ahead of it and rob the slot. A built-in that missed
            pass 1 missed it because a STORED row held the slot, which no chunk can undo.
          - pass 2 is stable: persisting a prefix turns exactly those rows into stored counts,
            leaving the running counter identical, so re-planning resumes the same least-held
            walk on the untouched suffix.
        Verified by simulation over randomised stores, including >20 unslotted rows and a
        create or delete landing between chunks.

        FAIL-OPEN on the READ path (strict=False). Seven handler routes call list_categories,
        as does the webhook Lambda's budget-alert path (shared/budget_alerts.py), and every
        one of them survives today on a single get_item. If this
        write raised, a VersionConflictError would 409 the caller and any other ClientError
        would become a DatabaseError the handler does not catch — a 500 on a read that would
        have succeeded. So: attempt it once, and on failure log and carry on. The caller has
        already applied `plan` in memory, so the response is correct either way and a later
        request retries the write.

        FAIL-CLOSED on the create path (strict=True): a real DB fault there is not something
        to paper over, and create's own conditional write is about to hit it anyway.
        """
        # Names are built INCREMENTALLY: DynamoDB rejects an ExpressionAttributeName the
        # expression never references. Same technique delete_category uses for #childN.
        # With an EMPTY plan we still write the marker (names = version + schema only, never
        # #items), so a store whose categories were all deleted stops re-planning forever.
        # At most _COLOR_SLOT_WRITE_CHUNK categories per write, so the expression can never
        # exceed DynamoDB's 4KB cap. The chunk is a prefix of the DRAIN ORDER, which is what
        # keeps chunking equivalent to one shot (see color_slot_plan_order and the docstring).
        chunk = color_slot_plan_order(plan)[:_COLOR_SLOT_WRITE_CHUNK]
        # Stamp the migrated marker only once this write drains the plan AND no further stage
        # follows it. A partial write must NOT stamp it, or the remaining categories would
        # never be revisited; nor may the backfill's last chunk stamp it while a repaint is
        # still owed. An empty plan counts as drained: that is the "all categories deleted"
        # case, which must still stamp so the store stops re-planning forever.
        drained = len(chunk) == len(plan) and settled
        names = {"#v": "version"}
        values = {":expected": version, ":next": version + Decimal(1)}
        set_parts = ["#v = :next"]
        if drained:
            names["#schema"] = _COLOR_SLOT_SCHEMA_FIELD
            values[":schema"] = Decimal(_COLOR_SLOT_SCHEMA)
            set_parts.append("#schema = :schema")
        if plan:
            names["#items"] = "items"
            names["#slot"] = _COLOR_SLOT_FIELD
            for index, cat_id in enumerate(chunk):
                alias = f"#cat{index}"
                names[alias] = cat_id
                values[f":slot{index}"] = Decimal(plan[cat_id])
                set_parts.append(f"#items.{alias}.#slot = :slot{index}")
        try:
            self._get_table().update_item(
                Key=_CATEGORIES_KEY,
                # Nested SET stamps ONE field per category — never rewrites the items map.
                UpdateExpression="SET " + ", ".join(set_parts),
                ConditionExpression="attribute_exists(pk) AND #v = :expected",
                ExpressionAttributeNames=names,
                ExpressionAttributeValues=values,
            )
        except ClientError as e:
            if e.response["Error"]["Code"] == "ConditionalCheckFailedException":
                return  # someone else migrated or bumped the version: a no-op success
            if strict:
                handle_database_error(e, "backfill category colour slots")
            else:
                logger.warning("colour-slot backfill deferred: %s", e)
        except Exception as e:  # noqa: BLE001 - fail-open has to mean fail-open
            # A timeout / connection failure is a BotoCoreError, NOT a ClientError, and is
            # the likeliest transient fault in Lambda. Catching only ClientError above would
            # let it escape and 500 the seven read routes that call list_categories — the
            # exact outage this policy exists to prevent. The response is already correct
            # from `plan`, so on a read nothing may escape; on a write it still propagates.
            if strict:
                raise
            logger.warning("colour-slot backfill deferred: %s", e)

    def list_categories(self) -> list[dict]:
        item = self._get_config()
        if item is None:
            self._ensure_seeded()
            item = self._get_config()  # re-read so a concurrent create is reflected
        items = item["items"]
        # Planning is pure and cheap (a scan of ~15 map entries), so compute it every read
        # and let its emptiness decide whether a write is needed. An already-stamped, fully
        # slotted store plans nothing and writes nothing — every later read is one get_item.
        repainted = self._is_slot_migrated(item)
        plan, settled = plan_color_slot_stage(items, repainted=repainted)
        # `.get` deliberately: this method fails OPEN on a write fault, so it must not gain a
        # way for malformed data to fail the read either. No version means no optimistic lock
        # to condition on, so skip the write — the response is still correct from `plan`.
        version = item.get("version")
        if version is not None and (plan or not repainted):
            self._write_color_slots(version, plan, strict=False, settled=settled)
        # Default `parent` to None so every category leaving the repo carries the
        # field, even seed rows and rows written before sub-categories existed.
        # `plan` is applied in memory whether or not the write landed, so the invocation
        # that migrates returns the slotted view and a deferred write never shows the user
        # different colours from the ones about to be stored.
        # Keyed by the MAP KEY, the same key `plan` and the write both use — a row whose
        # inner "id" disagreed with its map key would otherwise be stamped in the DB but
        # returned with a null slot.
        return [
            {"parent": None, **cat, _COLOR_SLOT_FIELD: _previewed_slot(plan, cat_id, cat)}
            for cat_id, cat in items.items()
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
        # Migrate BEFORE the retry loop, on its own read. Inside the loop it would bump the
        # version between our read and our conditional write and GUARANTEE the first attempt
        # fails, burning attempt 1 of 2 on every create against an unmigrated store.
        # strict=True: on a write path a DB fault is a real failure, not something to defer.
        pre = self._get_config()
        pre_repainted = self._is_slot_migrated(pre)
        pre_plan, pre_settled = plan_color_slot_stage(pre["items"], repainted=pre_repainted)
        if pre_plan or not pre_repainted:
            self._write_color_slots(pre["version"], pre_plan, strict=True, settled=pre_settled)
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
            # Computed INSIDE the loop from the freshly-read items (same as `color` above): on
            # a retry we re-read, so two concurrent creates can never be handed the same slot.
            slot = plan_new_category_slot(items)
            new_cat = {"id": cat_id, "name": name, "icon": icon, "color": color,
                       "bucket": bucket, "parent": parent,
                       _COLOR_SLOT_FIELD: Decimal(slot)}
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
                # Store a Decimal (DynamoDB's number type) but RETURN a plain int, so the
                # POST body carries `2` like the GET does — not the `2.0` a Decimal encodes to.
                return {**new_cat, _COLOR_SLOT_FIELD: slot}
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
                # Same planner and the same _previewed_slot the read path uses, so PATCH can
                # never echo a colour GET disagrees with. Plain int, so the body carries `2`
                # like GET does rather than the `2.0` a Decimal encodes to. Pure: no extra
                # read, no extra write — `item`/`items` are already in hand.
                pending, _ = plan_color_slot_stage(
                    items, repainted=self._is_slot_migrated(item))
                return {**items[cat_id], "name": name, "bucket": bucket,
                        "icon": icon, "parent": resolved_parent,
                        _COLOR_SLOT_FIELD: _previewed_slot(pending, cat_id, items[cat_id])}
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
