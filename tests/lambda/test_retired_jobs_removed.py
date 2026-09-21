"""WHIT-450 — guard that the retired one-time jobs' shared DB helper is gone.

backfill_swipe_dates.py and dedupe_cleanup.py were deleted (one-time jobs, finished with).
Their only shared reader, TransactionRepository.get_all_transactions_for_account, was called
by nothing else, so it died with them. Re-adding the method (or a caller) reddens this.
Reuses the webhook suite's `lam` fixture (tests/lambda/conftest.py).
"""


def test_get_all_transactions_for_account_is_removed(lam):
    assert not hasattr(lam.repository.TransactionRepository, "get_all_transactions_for_account"), (
        "the one-time-job-only helper should have been removed with WHIT-450"
    )
