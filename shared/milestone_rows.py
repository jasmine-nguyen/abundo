"""The one rule for reading a STORED milestone row (WHIT-394).

Both read paths — the poller's shared/milestones._resolve_plan and the client read in
shared/repository_milestone._to_client — carried their own copy of "is this saved row
usable", and had drifted: the poller rejected a non-finite target (WHIT-387) while the
client read cast with float(). This module owns the rule; each read path keeps only its
genuine differences (log level and alarm token, and Decimal vs float for the target).

On reachability, so the next reader isn't misled about which guard earns its keep:
  - REACHABLE through a legacy or hand-edited row — a blank label, a missing or unparsable
    targetDate, a string/None/bytes target. The bad date is the one that actually bit: it
    reaches lambda_api._review_candidates' date.fromisoformat outside any per-row guard and
    500s the review endpoint.
  - DEFENCE-IN-DEPTH — NaN and +Infinity, which boto3's TypeSerializer rejects before the
    wire ("Infinity and NaN not supported"), and a target above ~1e126, which it rejects as
    Overflow (its DYNAMODB_CONTEXT caps the exponent at 126 — far below float()'s ~1e309
    limit, which is why row_target_float has to check separately). Worth keeping (the rule is
    about what the STORE can hand back, not what today's writer sends), but they are not live
    bugs. Note boto3 is asymmetric: it serialises Decimal("-Infinity") happily, so that one is
    not clearly unreachable.
The save endpoint blocks all of the above, so any such row predates it or bypassed it.

Flat top-level module on purpose: the Lambda layer stages shared/ with a NON-RECURSIVE
`cp shared/*.py` (terraform/layers.tf), so a package directory here would be silently
dropped and every Lambda importing it would 500 on import.
"""

import math
from datetime import date
from decimal import Decimal, InvalidOperation


class MalformedMilestoneRow(ValueError):
    """A stored row that can't be read as a milestone. Both read paths catch exactly this
    and skip the row — each with its own log level and alarm token."""


def is_plan_list(stored) -> bool:
    """True when the stored `milestones` attribute is a row list at all. A corrupt whole-plan
    write can leave a scalar or a map there, which isn't iterable as rows."""
    return isinstance(stored, list)


def row_field(row, name):
    """A required field's raw value. Raises for a missing key, or for a row that isn't a
    mapping at all (a bare string/int/None sitting in the list)."""
    try:
        return row[name]
    except (KeyError, TypeError) as e:
        raise MalformedMilestoneRow(f"milestone row missing {name}: {row!r}") from e


def row_text(row, name) -> str:
    """A required non-blank text field, returned unchanged (the write path already trims;
    re-trimming on read would silently change what the screen shows).

    WHIT-394: the save endpoint rejects a blank label, so this only bites on a legacy or
    directly-written row — one that would otherwise reach a celebration push, or the plan
    screen, with an empty name.
    """
    value = row_field(row, name)
    if not isinstance(value, str) or not value.strip():
        raise MalformedMilestoneRow(f"milestone row has a blank {name}: {row!r}")
    return value


def row_date(row, name) -> str:
    """A required date the consumer can actually parse, returned unchanged.

    The bar is exactly `date.fromisoformat` — what lambda_api._review_candidates calls on
    this field. A blank or unparsable stored date raises there, outside any per-row guard,
    which 500s the review endpoint (WHIT-394).

    Both read paths apply it. The poller has no use for the value, but WHIT-417 decided a row
    the plan screen hides must not still celebrate: the user would tap "🎉 Milestone reached"
    and land on a plan the milestone isn't in.
    """
    value = row_field(row, name)
    if not isinstance(value, str):
        raise MalformedMilestoneRow(f"milestone row has a non-text {name}: {row!r}")
    try:
        date.fromisoformat(value)
    except ValueError as e:
        raise MalformedMilestoneRow(f"milestone row has an unparsable {name}: {row!r}") from e
    return value


def row_target(row) -> Decimal:
    """targetBalance as an exact, FINITE Decimal — the poller's view, exact to the cent.

    row_field is called OUTSIDE the try below on purpose: MalformedMilestoneRow IS a
    ValueError, so catching ValueError around it would swallow the precise "missing field"
    error and re-wrap it as "non-numeric".
    """
    value = row_field(row, "targetBalance")
    try:
        target = Decimal(value)
    except (TypeError, ValueError, InvalidOperation) as e:
        # InvalidOperation is an ArithmeticError, NOT a ValueError — it has to be listed.
        raise MalformedMilestoneRow(f"non-numeric milestone target: {value!r}") from e
    if not target.is_finite():
        raise MalformedMilestoneRow(f"non-finite milestone target: {value!r}")
    return target


def row_target_float(row) -> float:
    """targetBalance as a float — the client's view.

    Checks the RESULT is finite, not just the Decimal: a target above ~1e309 is a perfectly
    finite Decimal that float() still turns into inf, and inf serialises as a bare Infinity
    token that no JSON parser accepts.
    """
    target = row_target(row)
    as_float = float(target)
    if not math.isfinite(as_float):
        raise MalformedMilestoneRow(f"milestone target too large for a float: {target}")
    return as_float
