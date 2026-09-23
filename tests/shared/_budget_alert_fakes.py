"""Shared budget-alert debounce fake (WHIT-577).

Three webhook alert suites each carried a private copy of the notify-repo stand-in; the
WHIT-577 claim/release methods would have had to be added to all three and could drift. They
import this one instead. Dependency-light: no shared/-layer import.
"""


class FakeNotifyRepo:
    """Debounce markers keyed by (cycle_start, length) so cycles are isolated. `claim_fired`
    mirrors the conditional ADD: it claims only an absent marker. `lose_claims` models another
    delivery having claimed first, so every claim returns False."""

    def __init__(self, lose_claims=False):
        self.store: dict = {}
        self.lose_claims = lose_claims
        self.released: list = []

    def fired_markers(self, cycle_start, length):
        return set(self.store.get((cycle_start, length), set()))

    def mark_fired(self, cycle_start, length, marker):
        self.store.setdefault((cycle_start, length), set()).add(marker)

    def claim_fired(self, cycle_start, length, marker):
        markers = self.store.setdefault((cycle_start, length), set())
        if self.lose_claims or marker in markers:
            return False
        markers.add(marker)
        return True

    def release_fired(self, cycle_start, length, marker):
        self.store.get((cycle_start, length), set()).discard(marker)
        self.released.append(marker)
