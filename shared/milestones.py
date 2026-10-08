"""Home-loan payoff milestone celebration push (WHIT-301).

When the daily balance poll shows the mortgage balance has crossed a named payoff
milestone, send one bigger celebratory Expo push — once ever per milestone. The
milestones are the user's saved plan; with no readable plan there is nothing to celebrate.

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

from milestone_rows import MalformedMilestoneRow, is_plan_list, row_date, row_field, row_target, row_text
from push import send_push

logger = logging.getLogger(__name__)

# A saved-plan milestone marker is "id:<id>:bal:<amount>" (WHIT-369). _plan_marker builds it from
# these prefixes and _row_id_prefix matches on the same id prefix, so the two can't drift apart.
_ID_PREFIX = "id:"
_BAL_PREFIX = "bal:"


@dataclass(frozen=True)
class PlanMilestone:
    """A milestone resolved from the user's SAVED plan (WHIT-384). target_balance is a Decimal
    (exact to the cent); key is the dedup marker built by _plan_marker."""
    label: str
    target_balance: Decimal
    key: str


def _plan_marker(milestone: dict) -> str:
    """The dedup marker for a SAVED milestone: its permanent id AND its cent-quantized target
    amount (WHIT-369). Keying on the id survives reorder / rename / delete, so an alert can't
    repeat or go missing; including the amount means re-pointing a target to a new number
    re-arms its celebration. Quantize to cents so the marker is byte-stable across polls
    regardless of how the stored Decimal formats (480000 / 480000.0 / 480000.00 all → the same
    "...bal:480000.00"). A row with no id is malformed (WHIT-830), the same rule as the client
    read."""
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
    milestone_id = row_field(milestone, "id")
    if milestone_id is None:
        raise MalformedMilestoneRow(f"milestone row has no id: {milestone!r}")
    return f"{_ID_PREFIX}{milestone_id}:{_BAL_PREFIX}{amount}"


def _row_id_prefix(row) -> Optional[str]:
    """The "id:<row id>:" marker prefix for a row whose id we can read, else None.

    Used only when _plan_marker itself fails — an unreadable target amount, so no exact key can
    be built (WHIT-424). The row is still one the user has; we just can't say which amount it
    points at. Every once-ever marker it fired sits under this prefix, so keeping the prefix live
    keeps those markers from being swept as if the row were deleted. A readable id is what the save
    endpoint stores: a non-empty string. A non-mapping row, or one with no readable id, has no
    prefix to match on and stays on the "looks gone" behaviour.

    Deliberately STRICTER than _plan_marker's id test (which only rejects a missing or None id, so a
    blank or non-str id would still key): here a blank/non-str id yields no prefix, so such a row
    loses its record on an unreadable target. That is the safe direction — a conservative lose,
    never a wrong keep — and only a direct-write row can reach it (the save endpoint rejects
    blank/non-str ids)."""
    if not isinstance(row, dict):
        return None
    milestone_id = row.get("id")
    if not isinstance(milestone_id, str) or not milestone_id:
        return None
    return f"{_ID_PREFIX}{milestone_id}:"


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


def _resolve_plan(milestone_repo, scope=None):
    """Return (plan, live_markers).

    `live_markers` (a LiveMarkers) is every marker the STORED rows still keep alive — not the same
    as the markers in `plan`. A row that is present but unreadable (a bad date, a blank label)
    resolves out of `plan` yet is still a row the user has, so its marker belongs here: the
    WHIT-385 sweep uses this to tell "unreadable" apart from "deleted", and only the latter
    should lose its once-ever record. A row we can key holds its EXACT marker; a row whose target
    amount is unreadable but whose id we can read holds its "id:<row id>:" prefix instead
    (WHIT-424), since we can't rebuild its exact amount.

    `plan` is the list the celebration push measures against. A read failure, an unset plan and a
    corrupt whole-plan write all resolve to an EMPTY plan — celebrate nothing, sweep nothing
    (WHIT-830). The user sets their own milestones, so there is never a plan they didn't choose.

    `scope` is the multi-tenant seam (WHIT-369/375): None reads the single shared tenant, a
    user id later reads that user's plan. One param, threaded to the fired-state + reconcile
    too, so multi-user is a per-user loop in the poller — not a rewrite."""
    try:
        stored = milestone_repo.get_milestones_raw(scope)
    except Exception as e:
        logger.warning("milestones read failed, no plan this poll: %s", e)
        return [], _NO_LIVE_MARKERS
    if stored is None:
        return [], _NO_LIVE_MARKERS
    # Distinct alarm token so a corrupt whole-plan write is visible, not silently eaten (WHIT-387).
    if not is_plan_list(stored):
        logger.error("MILESTONE_PLAN_MALFORMED stored milestone plan is not a list, treating as empty: %r", stored)
        return [], _NO_LIVE_MARKERS
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
    return plan, LiveMarkers(frozenset(exact_keys), frozenset(id_prefixes))


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


def crossed_milestones(old_balance, new_balance, plan) -> list:
    """The milestones the balance crossed on this poll (old > target >= new), furthest-
    along first (lowest target). `plan` is the resolved milestone list. Empty when old_balance is
    None (the first-ever poll — the seed guard), the balance rose, or nothing was crossed."""
    if old_balance is None:
        return []
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


def notify_milestone_crossing(old_balance, new_balance, *, loanfacts_repo, device_repo, notify_repo, milestone_repo, scope=None) -> int:
    """Send one celebratory push when the balance crosses a payoff milestone.

    Measures against the user's saved plan; no readable plan means nothing to celebrate
    (WHIT-830). Fires the furthest-along newly-crossed milestone and
    marks EVERY freshly-crossed one fired (so a lump-sum jump past several doesn't nag later) —
    marking REGARDLESS of send outcome, because the stored prior balance means a crossing is
    never re-detected, so "mark only on send" would lose the push forever on a transient
    failure. Short-circuits before any I/O when nothing new was crossed, and before sending
    when no device is registered — EXCEPT that a non-empty plan first reads the marker
    set to reconcile away dead markers (WHIT-385), so that path does one read (and a write only
    when there's a dead key) even on a no-crossing poll. Returns 1 if a push was sent, else 0.
    Best-effort: the caller swallows.

    `scope` is the multi-tenant seam (WHIT-369): it selects WHOSE plan is read AND whose
    fired-state is read / reconciled / marked — the SAME owner for all. None is the single shared
    tenant today; the poller passes a user id per user when multi-user lands, and nothing else
    here changes."""
    plan, live_markers = _resolve_plan(milestone_repo, scope)

    # WHIT-385: reconcile away dead markers so a re-targeted or deleted milestone's old marker
    # can't accumulate forever. Runs BEFORE the "nothing crossed" short-circuit, since a re-target
    # poll usually crosses nothing. Any marker no stored row keeps alive is removed — including
    # leftovers nothing can match any more, like the old "0".."4" sprint markers or the id-less
    # "bal:<amount>" ones (WHIT-830).
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
    # WHIT-386: require a non-empty plan. An empty plan (unset, corrupt, or a READ FAILURE) would
    # make EVERY marker stale and delete the whole "already celebrated" record in one sweep — on a
    # read failure, from one transient store blip.
    #
    # Deliberately `plan`, not `live_markers`: a plan whose rows are ALL unreadable has markers but
    # is no evidence the store was read correctly, so it skips the sweep entirely. The cost — a
    # genuinely dead marker isn't reaped that poll — is harmless: the next readable poll reaps it,
    # and an unmatched marker never re-fires.
    fired = None
    if plan:
        # Best-effort: reconcile is bookkeeping, so a marker read/write blip must never suppress a
        # genuine celebration (the crossing is never re-detected once the balance moves past it).
        # On any error, skip the sweep this poll — the next poll retries. If the read succeeded but
        # the delete failed, `fired` still holds the pre-delete set: the stale keys aren't in
        # `crossed`, so dedup below is unaffected.
        try:
            fired = notify_repo.fired_milestones(scope)
            stale = {k for k in fired if not live_markers.covers(k)}
            if stale:
                notify_repo.remove_milestone_markers(stale, scope)
        except Exception as e:
            logger.warning("milestone marker reconcile failed, skipping the sweep: %s", e)

    crossed = crossed_milestones(old_balance, new_balance, plan)
    if not crossed:
        return 0

    if fired is None:  # the sweep's marker read failed above; read again for the dedup
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


def owed(amount):
    """The positive amount still owed from a SIGNED stored loan amount; None stays None."""
    if amount is None:
        return None
    return abs(amount)


def notify_homeloan_milestone(old_amount, new_amount, *, loanfacts_repo, device_repo, notify_repo, milestone_repo) -> int:
    """notify_milestone_crossing for the home loan's SIGNED stored amounts (WHIT-792).

    The ACCTBAL row keeps the mortgage negative; milestones measure the positive amount still
    owed. `old_amount` is None on the first-ever reading (the seed guard). Shared by the daily
    poller and the pull-to-refresh, so whichever sees the change first celebrates it."""
    return notify_milestone_crossing(
        owed(old_amount), abs(new_amount),
        loanfacts_repo=loanfacts_repo, device_repo=device_repo,
        notify_repo=notify_repo, milestone_repo=milestone_repo,
    )
