"""A fake Lambda context for the worker suites: only the remaining time is read.

Resolved by pytest.ini's `pythonpath = tests/shared`.
"""


class FakeContext:
    def __init__(self, remaining_ms=200_000):
        self.remaining_ms = remaining_ms

    def get_remaining_time_in_millis(self):
        return self.remaining_ms
