"""The one rule for reading a STORED milestone row (WHIT-394).

Both read paths — the poller's shared/milestones._resolve_plan and the client read in
shared/repository_milestone._to_client — carried their own copy of "is this saved row
usable", and had already drifted: the poller rejected a non-finite target (WHIT-387) while
the client read cast with float(), which turns NaN/Infinity into a bare NaN/Infinity token.
That token is not valid JSON, so ONE corrupt row made the whole milestones response
unparsable. This module owns the rule; each read path keeps only its genuine differences
(log level and alarm token, and Decimal vs float for the target).

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
    which 500s the review endpoint (WHIT-394). Only the client read needs this: the poller
    path never reads targetDate.
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
    value = row_field(row, "targetBalance")
    target = float(row_target(row))
    if not math.isfinite(target):
        raise MalformedMilestoneRow(f"milestone target too large for a float: {value!r}")
    return target
