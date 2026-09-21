"""Home-loan payoff milestone celebration push (WHIT-301).

When the daily balance poll shows the mortgage balance has crossed a named payoff
milestone, send one bigger celebratory Expo push — once ever per milestone. The
milestone plan is transcribed from the Notion "IP1 Equity Milestones" db and kept
in lockstep with the client twin (src/milestones.ts); the drift-pin test asserts the
exact rows so a transcription slip fails loudly.

Detection lives in the balance poller, NOT the webhook: the webhook only sees the
gross repayment credit, never the outstanding balance. It is edge-triggered
(old > target >= new from the poll's before/after) and marks the milestone fired
REGARDLESS of send outcome. The stored prior balance is the natural high-water mark,
so shipping the feature never retroactively celebrates already-crossed milestones,
and a milestone can't double-fire. The trade-off — a transient Expo outage at the one
crossing poll loses that celebration — is acceptable for a feel-good push (the balance
only moves down, so the crossing is never re-detected to retry).
"""

import logging
import math
from dataclasses import dataclass
from decimal import Decimal, InvalidOperation
from typing import Optional

from milestone_rows import MalformedMilestoneRow, is_plan_list, row_date, row_target, row_text
from push import send_push

logger = logging.getLogger(__name__)

# A saved-plan milestone marker is "id:<id>:bal:<amount>" (WHIT-369), or the legacy id-less
# "bal:<amount>" for a row saved before ids were minted (WHIT-378). Both are namespaced so a
# $0–$4 custom target can't collide with a built-in "0".."4" sprint marker. _plan_marker builds
# them from these prefixes and _is_custom_marker recognizes them by the same prefixes — one
# source of truth so the key format and the reconcile filter (WHIT-385) can't drift apart.
_ID_PREFIX = "id:"
_BAL_PREFIX = "bal:"
_CUSTOM_KEY_PREFIXES = (_ID_PREFIX, _BAL_PREFIX)


@dataclass(frozen=True)
class Milestone:
    sprint: int
    label: str
    target_balance: int

    @property
    def key(self) -> str:
        """The dedup marker for the 'already celebrated' set. Built-in milestones key by
        sprint ("0".."4") — unchanged, so existing users' markers keep deduping (WHIT-384)."""
        return str(self.sprint)


@dataclass(frozen=True)
class PlanMilestone:
    """A milestone resolved from the user's SAVED plan (WHIT-384). Same duck-type surface
    (.label, .target_balance, .key) as Milestone, so crossed_milestones / notify treat both
    alike. target_balance is a Decimal (exact to the cent); key is the dedup marker built by
    _plan_marker — namespaced "id:<id>:bal:<amount>", so it can never collide with a built-in
    "0".."4" sprint marker."""
    label: str
    target_balance: Decimal
    key: str


def _plan_marker(milestone: dict) -> str:
    """The dedup marker for a SAVED milestone: its permanent id AND its cent-quantized target
    amount (WHIT-369). Keying on the id survives reorder / rename / delete, so an alert can't
    repeat or go missing; including the amount means re-pointing a target to a new number
    re-arms its celebration. Quantize to cents so the marker is byte-stable across polls
    regardless of how the stored Decimal formats (480000 / 480000.0 / 480000.00 all → the same
    "...bal:480000.00"). A legacy row saved before ids were minted (WHIT-378) has no id — fall
    back to the amount-only marker rather than raise, which the poller would swallow into a
    silently-skipped celebration."""
    # row_target already rejects a non-finite target (WHIT-387's guard, now shared — WHIT-394).
    # Quantize can still raise on a finite but huge target (from ~1e26, where cent precision
    # exceeds the decimal module's 28 working digits); re-raise it as the row error both read
    # paths skip on, or it would escape _resolve_plan into the poller's swallow and lose every
    # good row's celebration.
    target = row_target(milestone)
    try:
        amount = target.quantize(Decimal("0.01"))
    except InvalidOperation as e:
        raise MalformedMilestoneRow(f"milestone target too large to quantize: {target}") from e
    milestone_id = milestone.get("id")
    if milestone_id is None:
        return f"{_BAL_PREFIX}{amount}"
    return f"{_ID_PREFIX}{milestone_id}:{_BAL_PREFIX}{amount}"


def mint_migration_markers(target: Decimal, minted_id: str) -> tuple:
    """The (legacy, id'd) once-ever markers for a milestone at `target` that has just been minted
    `minted_id` (WHIT-447). The save endpoint uses this pair to migrate a legacy id-less row's
    "already celebrated" marker `bal:<amount>` → `id:<minted_id>:bal:<amount>` at the moment it
    fills in the row's missing id, so the once-ever record follows the row instead of being swept
    as dead by the next poll (which now keys the saved row under the id'd form).

    Built through _plan_marker so the id'd marker is byte-identical to what the poller will later
    key the row to — same cent-quantize, same prefixes — and can never drift from it. `target` is
    the stored Decimal(str(balance)); it's already validated finite and capped at the save endpoint,
    so the quantize can't raise here."""
    legacy = _plan_marker({"targetBalance": target})
    idd = _plan_marker({"id": minted_id, "targetBalance": target})
    return legacy, idd


def _row_id_prefix(row) -> Optional[str]:
    """The "id:<row id>:" marker prefix for a row whose id we can read, else None.

    Used only when _plan_marker itself fails — an unreadable target amount, so no exact key can
    be built (WHIT-424). The row is still one the user has; we just can't say which amount it
    points at. Every once-ever marker it fired sits under this prefix, so keeping the prefix live
    keeps those markers from being swept as if the row were deleted. A readable id is what the save
    endpoint stores: a non-empty string. A non-mapping row, or one with no readable id, has no
    prefix to match on and stays on the "looks gone" behaviour.

    Deliberately STRICTER than _plan_marker's id test (which only special-cases None, so a blank or
    non-str id would still key): here a blank/non-str id yields no prefix, so such a row loses its
    record on an unreadable target. That is the safe direction — a conservative lose, never a wrong
    keep — and only a direct-write row can reach it (the save endpoint rejects blank/non-str ids)."""
    if not isinstance(row, dict):
        return None
    milestone_id = row.get("id")
    if not isinstance(milestone_id, str) or not milestone_id:
        return None
    return f"{_ID_PREFIX}{milestone_id}:"


def _is_custom_marker(key: str) -> bool:
    """True for a marker _plan_marker produced (a saved-milestone key), False for a built-in
    sprint marker ("0".."4"). The WHIT-385 reconcile sweep only ever removes custom markers, so
    a sprint marker is never swept."""
    return key.startswith(_CUSTOM_KEY_PREFIXES)


@dataclass(frozen=True)
class LiveMarkers:
    """Which fired markers the STORED plan still keeps alive, for the WHIT-385 sweep. A marker is
    live if a row keys to it EXACTLY (the normal case), or — for a row whose target amount is
    unreadable but whose id is readable (WHIT-424) — if it sits under that row's "id:<row id>:"
    prefix. The unreadable-target row is still one the user has; we just can't say which amount it
    points at, so we keep every once-ever marker under its id rather than sweep them as deleted.
    A re-targeted or deleted row keys to a NEW exact marker (or none), never a prefix, so its old
    marker is still swept — "gone" keeps meaning gone."""
    exact: frozenset
    id_prefixes: frozenset

    def covers(self, marker: str) -> bool:
        return marker in self.exact or any(marker.startswith(prefix) for prefix in self.id_prefixes)


_NO_LIVE_MARKERS = LiveMarkers(frozenset(), frozenset())


def _resolve_plan(milestone_repo=None, scope=None):
    """Return (plan, authoritative, live_markers).

    `live_markers` (a LiveMarkers) is every marker the STORED rows still keep alive — not the same
    as the markers in `plan`. A row that is present but unreadable (a bad date, a blank label)
    resolves out of `plan` yet is still a row the user has, so its marker belongs here: the
    WHIT-385 sweep below uses this to tell "unreadable" apart from "deleted", and only the latter
    should lose its once-ever record. A row we can key holds its EXACT marker; a row whose target
    amount is unreadable but whose id we can read holds its "id:<row id>:" prefix instead
    (WHIT-424), since we can't rebuild its exact amount. Empty for every non-authoritative case,
    where nothing is swept anyway.

    `plan` is the same list resolve_plan has always returned. `authoritative` is True when the
    store returned a genuine saved list (populated OR a real empty []) AND when the plan is UNSET
    (the user has never saved one) — both are definitive answers safe to reconcile against (WHIT-385).
    It is False for the two fallback-to-default cases (None repo or a READ FAILURE): reconciling
    against the built-in default in either would treat every custom marker as dead and delete it, so
    a transient store blip would wipe the once-ever "already celebrated" record. An UNSET plan now
    resolves to an authoritative EMPTY plan (celebrate nothing) rather than the default — the user
    sets their own milestones, so a plan they never chose must not fire pushes.

    `scope` is the multi-tenant seam (WHIT-369/375): None reads the single shared tenant (the
    repository's own default), a user id later reads that user's plan. One param, threaded to the
    fired-state + reconcile too, so multi-user is a per-user loop in the poller — not a rewrite."""
    if milestone_repo is None:
        return list(MILESTONES), False, _NO_LIVE_MARKERS
    try:
        if scope is None:
            stored = milestone_repo.get_milestones_raw()
        else:
            stored = milestone_repo.get_milestones_raw(scope)
    except Exception as e:
        logger.warning("milestones read failed, using the default plan: %s", e)
        return list(MILESTONES), False, _NO_LIVE_MARKERS
    if stored is None:
        # UNSET = the user has never saved a plan. They now set their own milestones, so there is
        # no plan to measure against — resolve to an authoritative EMPTY plan (celebrate nothing),
        # NOT the built-in default. A no-plan user must not get default-milestone pushes for a plan
        # they never chose. Authoritative + empty is safe: crossed_milestones([]) is empty and the
        # `authoritative and plan` sweep no-ops on an empty plan. Distinct from the read-failure /
        # None-repo fallbacks above, which still default so a real-plan user keeps their celebration
        # through a transient blip.
        return [], True, _NO_LIVE_MARKERS
    # A corrupt whole-plan write (a non-list scalar isn't iterable) degrades to an authoritative
    # EMPTY plan, not the default: an empty plan celebrates nothing and — via the WHIT-386
    # `and plan` guard — sweeps no markers, whereas falling back to the default would send a
    # WRONG default celebration for what is really corrupt data. Distinct alarm token so a
    # corrupt plan is visible, not silently eaten (WHIT-387).
    if not is_plan_list(stored):
        logger.error("MILESTONE_PLAN_MALFORMED stored milestone plan is not a list, treating as empty: %r", stored)
        return [], True, _NO_LIVE_MARKERS
    # Resolve row by row so ONE corrupt saved row is skipped + logged rather than raising the
    # whole poll's celebration into the poller's best-effort swallow — which would drop every
    # good row's push permanently, since the balance only moves down so the crossing is never
    # re-detected (WHIT-387).
    #
    # What counts as corrupt lives in milestone_rows, shared with the client read so the two
    # can't drift (WHIT-394) — including targetDate since WHIT-417, so a row the plan screen
    # hides can never still send a celebration for it.
    #
    # row_target COERCES to a finite Decimal: a legacy/direct-write row
    # can hold the target as a string ("120000"), which crossed_milestones would otherwise
    # compare as Decimal > str -> TypeError OUTSIDE this loop, back in the poller's swallow.
    # After coercion target_balance is always a FINITE Decimal, so the comparison can't raise.
    #
    # _plan_marker takes just a row rather than a pre-coerced target, which is the whole reason
    # it can be reasoned about (and tested) on its own. The target is therefore coerced twice per
    # row; a plan is capped at 50 rows, so that is deliberate.
    plan = []
    exact_keys = set()
    id_prefixes = set()
    for row in stored:
        key = None
        try:
            # The marker comes FIRST because it answers a different question from the rest of
            # the loop: "does the user still have this row?", not "can we celebrate it?".
            # A row we can key is a row that is still in the saved plan, even when the rest of
            # it is unreadable — so its exact marker stays live and the sweep below leaves it alone.
            key = _plan_marker(row)
            exact_keys.add(key)
            # WHIT-417: called for the rejection only — the poller has no use for the date.
            row_date(row, "targetDate")
            plan.append(PlanMilestone(label=row_text(row, "label"), target_balance=row_target(row), key=key))
        except MalformedMilestoneRow as e:
            # key is None ONLY when _plan_marker itself failed — the target amount is unreadable,
            # so no exact key exists. The row is still the user's: if its id is readable, keep every
            # "id:<row id>:..." marker alive rather than sweep them as deleted (WHIT-424). A
            # key-then-fail row (bad date/label) already added its exact key above and needs no
            # prefix; a row with no readable id has nothing to match on and stays "gone".
            if key is None:
                prefix = _row_id_prefix(row)
                if prefix is not None:
                    id_prefixes.add(prefix)
            logger.error("MILESTONE_ROW_MALFORMED skipping a corrupt saved milestone row, celebrating the rest: %r (%s)", row, e)
    return plan, True, LiveMarkers(frozenset(exact_keys), frozenset(id_prefixes))


def resolve_plan(milestone_repo=None, scope=None) -> list:
    """The plan the celebration push measures against: the user's SAVED milestone list when
    they have one, else an EMPTY plan when they have never saved one (they set their own
    milestones — a plan they never chose must not fire pushes). Falls back to the built-in default
    MILESTONES only when the READ fails or the repo is None (WHIT-384) — a store hiccup must
    degrade to the default, never skip a real-plan user's celebration (the balance only moves down,
    so a dropped crossing is never re-detected). Within a genuine saved list, any row milestone_rows rejects (WHIT-394) is
    skipped + logged with a distinct alarm token and the rest still celebrate — never a WRONG
    default celebration in its place, and never the whole poll's push lost to the poller's
    swallow (WHIT-387). An empty list is a genuinely empty plan — reachable only by a direct write, since the API
    rejects an empty save. A None repo (every pre-WHIT-384 caller) also gets the default."""
    return _resolve_plan(milestone_repo, scope)[0]


# The payoff plan, transcribed from the Notion "IP1 Equity Milestones" db and kept in
# lockstep with src/milestones.ts (targetBalance/label). targetDate is not needed here —
# this trigger is balance-based, not date-based. If the plan in Notion changes, update
# BOTH this table and src/milestones.ts; the drift-pin test pins the exact rows.
MILESTONES = (
    Milestone(0, "Kickoff", 544000),
    Milestone(1, "Quarter way", 420000),
    Milestone(2, "Halfway", 295000),
    Milestone(3, "Three-quarters", 170000),
    Milestone(4, "Target", 55000),
)

def _assert_strictly_paid_down(milestones) -> None:
    """Each later milestone must be a lower balance (mirrors src/milestones.ts), or "first
    target below the balance" and the crossing check would silently pick the wrong one.
    Fails loud at import so a transcription typo trips immediately."""
    for prev, cur in zip(milestones, milestones[1:]):
        if not (cur.target_balance < prev.target_balance):
            raise ValueError(f"MILESTONES must have strictly decreasing target_balance (sprint {cur.sprint})")


_assert_strictly_paid_down(MILESTONES)

_TITLE = "\U0001f389 Milestone reached — {label}!"
_BODY_FULL = "You're ${paid} down on your mortgage, with ${equity} in equity unlocked. Keep building! \U0001f4aa"
_BODY_BARE = "Another mortgage milestone in the bag. Keep building! \U0001f4aa"


def usable_equity(home_value: float, balance: float, lvr: float) -> int:
    """Usable equity toward a deposit: property value × LVR − balance, clamped at 0,
    whole dollars. Mirrors src/milestones.ts usableEquity — INCLUDING its Math.round, which
    rounds a half-dollar UP (toward +∞). Python's built-in round() is half-to-even (banker's),
    so it would disagree with the in-app screen by exactly $1 on a half-dollar; math.floor(x +
    0.5) reproduces Math.round so the push figure always matches the screen (WHIT-307)."""
    return max(0, math.floor(home_value * lvr - balance + 0.5))


def crossed_milestones(old_balance, new_balance, plan=None) -> list:
    """The milestones the balance crossed on this poll (old > target >= new), furthest-
    along first (lowest target). `plan` is the resolved milestone list; it defaults to the
    built-in MILESTONES so existing 2-arg callers are unchanged. Empty when old_balance is
    None (the first-ever poll — the seed guard), the balance rose, or nothing was crossed."""
    if old_balance is None:
        return []
    if plan is None:
        plan = MILESTONES
    crossed = [m for m in plan if old_balance > m.target_balance >= new_balance]
    return sorted(crossed, key=lambda m: m.target_balance)


def _dollars(amount) -> str:
    """Whole dollars with thousands separators, e.g. 305000 -> '305,000'."""
    return f"{amount:,.0f}"


def _body(new_balance, loanfacts_repo) -> str:
    """The celebratory body: paid-down + usable-equity figures when the user's loan
    facts are set, else a number-free line. new_balance is a Decimal; loan facts are
    floats, so cast to float before the arithmetic (avoids a float/Decimal TypeError)."""
    facts = loanfacts_repo.get_loanfacts()
    if not facts:
        return _BODY_BARE
    # Clamp at 0 (like usable_equity) so misconfigured facts (original < balance) never render a
    # negative "$-N down" in a celebration.
    paid = max(0.0, facts["original"] - float(new_balance))
    equity = usable_equity(facts["homeValue"], float(new_balance), facts["lvr"])
    return _BODY_FULL.format(paid=_dollars(paid), equity=_dollars(equity))


def notify_milestone_crossing(old_balance, new_balance, *, loanfacts_repo, device_repo, notify_repo, milestone_repo=None, scope=None) -> int:
    """Send one celebratory push when the balance crosses a payoff milestone.

    Measures against the user's SAVED plan when `milestone_repo` is given and they have one,
    else the built-in default (WHIT-384). Fires the furthest-along newly-crossed milestone and
    marks EVERY freshly-crossed one fired (so a lump-sum jump past several doesn't nag later) —
    marking REGARDLESS of send outcome, because the stored prior balance means a crossing is
    never re-detected, so "mark only on send" would lose the push forever on a transient
    failure. Short-circuits before any I/O when nothing new was crossed, and before sending
    when no device is registered — EXCEPT that an authoritative custom plan first reads the marker
    set to reconcile away dead markers (WHIT-385), so that path does one read (and a write only
    when there's a dead key) even on a no-crossing poll. Returns 1 if a push was sent, else 0.
    Best-effort: the caller swallows.

    `scope` is the multi-tenant seam (WHIT-369): it selects WHOSE plan is read AND whose
    fired-state is read / reconciled / marked — the SAME owner for all. None is the single shared
    tenant today; the poller passes a user id per user when multi-user lands, and nothing else
    here changes."""
    plan, authoritative, live_markers = _resolve_plan(milestone_repo, scope)

    # WHIT-385: reconcile away dead custom markers so a re-targeted or deleted milestone's old
    # marker can't accumulate forever. Runs BEFORE the "nothing crossed" short-circuit, since a
    # re-target poll usually crosses nothing. Only on an AUTHORITATIVE plan (a genuine saved list)
    # with at least one row — never on a fallback default (None repo / unset / read failure), which
    # would wipe live markers on a transient blip. Only custom markers ("id:<id>:bal:<amount>" or
    # the legacy "bal:<amount>", per _is_custom_marker) are ever removed, so built-in sprint markers
    # ("0".."4") are untouched.
    #
    # "Dead" means the row is GONE from the saved plan — deleted, or re-targeted so it keys to a
    # new amount. It does NOT mean the row failed validation: an unreadable row is still a row the
    # user has, and wiping its marker would re-arm a celebration they already had. That is why
    # liveness comes from `live_markers` (every stored row we could key, plus the id-prefix of a
    # row whose only unreadable field is its target amount — WHIT-424) and not from `plan` (only
    # the rows we could fully read). Using `plan` cost a row its once-ever record the moment either
    # read path gained a new rejection — WHIT-394's blank label, then WHIT-417's bad date.
    #
    # `fired` is reused for the dedup below without subtracting `stale`:
    # every stale key is a target NOT in the plan and `crossed` ⊆ plan, so no fresh key can be
    # stale — subtracting would be dead work.
    #
    # WHIT-386: require a non-empty plan (`and plan`), not just authoritative. An authoritative
    # empty [] would make EVERY custom marker stale and delete the whole "already celebrated"
    # record in one sweep. That [] is API-unreachable today (the save endpoint rejects an empty
    # list), so this is defence in depth: if that guard ever regresses, an empty plan sweeps
    # nothing instead of silently erasing the once-ever record. The cost — a directly-DB-written
    # empty plan no longer self-heals its dead markers — is harmless: an unmatched marker never
    # re-fires.
    #
    # Deliberately `plan`, not `live_markers`: a plan whose rows are ALL unreadable has markers but
    # is no evidence the store was read correctly, so it skips the sweep entirely. Same harmless
    # cost — a genuinely dead marker isn't reaped that poll, and the next readable poll reaps it.
    fired = None
    if authoritative and plan:
        # Best-effort: reconcile is bookkeeping, so a marker read/write blip must never suppress a
        # genuine celebration (the crossing is never re-detected once the balance moves past it).
        # On any error, skip the sweep this poll — the next poll retries. If the read succeeded but
        # the delete failed, `fired` still holds the pre-delete set: the stale keys aren't in
        # `crossed`, so dedup below is unaffected.
        try:
            fired = notify_repo.fired_milestones(scope)
            stale = {k for k in fired if _is_custom_marker(k) and not live_markers.covers(k)}
            if stale:
                notify_repo.remove_milestone_markers(stale, scope)
        except Exception as e:
            logger.warning("milestone marker reconcile failed, skipping the sweep: %s", e)

    crossed = crossed_milestones(old_balance, new_balance, plan)
    if not crossed:
        return 0

    if fired is None:  # non-authoritative path: keep the original no-I/O-until-crossing behaviour
        fired = notify_repo.fired_milestones(scope)
    fresh = [m for m in crossed if m.key not in fired]
    if not fresh:
        return 0

    tokens = device_repo.list_tokens()
    if not tokens:
        return 0

    furthest = fresh[0]  # sorted asc by target → lowest balance = furthest paid down
    send_push(
        _TITLE.format(label=furthest.label),
        _body(new_balance, loanfacts_repo),
        tokens,
        data={"type": "milestone"},  # deep-link a tap to the milestone plan screen (WHIT-322)
    )
    for milestone in fresh:  # mark regardless of send outcome (see docstring)
        notify_repo.mark_milestone_fired(milestone.key, scope)
    return 1
