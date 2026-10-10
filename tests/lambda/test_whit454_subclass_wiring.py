"""WHIT-454 — the webhook TransactionRepository now SUBCLASSES the shared one.

These are wiring/regression guards, not behaviour re-tests: the CRUD behaviour
(insert / save-failed uuid sk / TTL) is owned and covered by
tests/shared/test_repository_transaction.py. Here we prove the dedup didn't
reintroduce a local copy of an inherited method, and that every webhook entry point
binds the webhook subclass. Backed by the webhook suite's in-memory FakeTable (`repo`)."""


def test_inherited_crud_methods_are_the_shared_ones_not_local_recopies(repo):
    # [A-W3] "don't reintroduce a local copy" guard: each inherited CRUD method object
    # must BE the shared parent's function, not a byte-copy re-added on the subclass.
    parent = type(repo).__mro__[1]
    for name in ("insert_transactions", "save_failed_transactions", "_batch_put"):
        assert name not in vars(type(repo)), f"{name} was re-copied onto the subclass"
        assert getattr(type(repo), name) is getattr(parent, name)


def test_every_webhook_entry_point_binds_the_webhook_repository(lam):
    # WHIT-608: handler / age_out / reprocess all use the webhook subclass (with the
    # reconcile/dedup overrides), not the shared parent class.
    webhook_class = lam.repository.TransactionRepository
    assert webhook_class.__module__ == "webhook_repository"
    for module in (lam.handler, lam.age_out, lam.reprocess):
        assert module.TransactionRepository is webhook_class, module.__name__
