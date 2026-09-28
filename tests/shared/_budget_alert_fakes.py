"""Shared budget-alert debounce wiring (WHIT-577, WHIT-625).

The webhook alert suites run the REAL NotifyRepository over a FakeTable, so the conditional claim
(ADD only when the marker is absent), the release and the String-Set markers run as production
wrote them. Dependency-light: the shared layer is imported lazily, inside ``notify_repo``.
"""

from _dynamo_fakes import FakeTable


def notify_repo():
    """A real NotifyRepository over its own empty FakeTable."""
    from repository_notify import NotifyRepository

    repo = NotifyRepository()
    repo._table = FakeTable()
    return repo


def released_markers(repo):
    """Every marker the repository asked to release (DELETE from a cycle's set), in call order —
    a release the table refused still counts, since it was attempted."""
    released = []
    for expression, _names, values in repo._table.update_calls:
        if expression.startswith("DELETE"):
            released.extend(sorted(values[":m"]))
    return released


def claimed_meanwhile(repo, cycle_start, length, *markers):
    """Another delivery claims ``markers`` after this one read its snapshot, just before this
    one's first write lands."""
    def claim(key, table):
        for marker in markers:
            repo.mark_fired(cycle_start, length, marker)
    repo._table.before_next_write(claim)


def fail_nth_write(repo, verb, number, error=None):
    """The ``number``-th write whose UpdateExpression starts with ``verb`` raises ``error`` (default:
    a throttle ClientError, which the repository turns into a DatabaseError). ``"ADD"`` is a claim
    or mark, ``"DELETE"`` a release."""
    table = repo._table
    seen = []

    def nth(key):
        if not table.update_calls[-1][0].startswith(verb):
            return False
        seen.append(key)
        return len(seen) == number

    table.fail("update_item", error=error, when=nth)
