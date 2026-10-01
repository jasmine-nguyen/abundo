"""WHIT-608 QA — after lambda/repository.py -> lambda/webhook_repository.py, every webhook entry
point still binds the WEBHOOK TransactionRepository (with the reconcile/dedup overrides), not the
shared facade's one that a bare `from repository import` would now resolve to."""

import pathlib

_LAMBDA_DIR = pathlib.Path(__file__).resolve().parents[2] / "lambda"


# [A13] (P0) handler / age_out / reprocess all use the webhook subclass.
def test_every_webhook_entry_point_binds_the_webhook_repository(lam):
    webhook_class = lam.repository.TransactionRepository
    assert webhook_class.__module__ == "webhook_repository"
    for module in (lam.handler, lam.age_out, lam.reprocess):
        assert module.TransactionRepository is webhook_class, module.__name__


# [A14] (P0) the old file is gone, so the raw-folder webhook zip can't ship a shadowing copy.
def test_old_webhook_repository_file_is_gone():
    assert not (_LAMBDA_DIR / "repository.py").exists()
    assert (_LAMBDA_DIR / "webhook_repository.py").exists()


# [A15] (P1) the webhook-only methods still live on the class the entry points use.
def test_webhook_only_methods_reachable_from_the_handler(lam):
    for name in ("insert_or_reconcile", "has_event", "mark_event", "get_pending_transactions_for_account"):
        method = getattr(lam.handler.TransactionRepository, name)
        assert method.__module__ == "webhook_repository", name
