"""The one rule for a valid milestone/goal date string (WHIT-418).

A stored or submitted date must be an ISO YYYY-MM-DD calendar date and nothing else. The
write path (lambda_api.handler) and both milestone read paths (shared/milestone_rows.row_date,
reached from the balance poller and the client read) share this one definition, so the read
guard can't drift looser than the write guard again. Bare date.fromisoformat also accepts
"20300101" and "2030-W01-1" on Python 3.11+ (the Lambdas run 3.12); the app can't parse those
as a date, and the server's review maths would read "2030-W01-1" as a different day than the
screen shows.

Flat top-level module on purpose: the Lambda layer stages shared/ with a NON-RECURSIVE
`cp shared/*.py` (terraform/layers.tf), so a package directory here would be silently dropped.
Imports only re and datetime.date — no shared constant — so it never touches the
lambda_api/constants.py shadow (WHIT-136).
"""

import re
from datetime import date

# Shape first — the regex rejects the basic ("20300101") and week ("2030-W01-1") ISO forms bare
# date.fromisoformat would accept, but would itself pass an impossible day like "2026-02-30".
# date.fromisoformat then rejects that impossible calendar day.
ISO_DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")


def valid_iso_date(value) -> bool:
    """True when `value` is a real ISO YYYY-MM-DD calendar date string. The regex checks
    shape (it would pass 2026-02-30); date.fromisoformat checks the calendar."""
    if not isinstance(value, str) or not ISO_DATE_RE.match(value):
        return False
    try:
        date.fromisoformat(value)
    except ValueError:
        return False
    return True
