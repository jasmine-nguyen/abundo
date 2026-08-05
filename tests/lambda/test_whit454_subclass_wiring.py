"""WHIT-454 — the webhook TransactionRepository now SUBCLASSES the shared one.

These are wiring/regression guards, not behaviour re-tests: the CRUD behaviour
(insert / save-failed uuid sk / TTL) is owned and covered by
tests/shared/test_repository_transaction.py. Here we prove the dedup didn't
silently (a) drop a webhook-only method, (b) let the shared parent SHADOW the
webhook's paginated get_pending override, or (c) reintroduce a local copy of an
inherited method. Backed by the webhook suite's in-memory FakeTable (`repo`)."""

# Every method the deployed webhook must still expose by name after the dedup.
_INHERITED_CRUD = (
    "__init__", "_get_table", "insert_transactions",
    "save_failed_transactions", "_batch_put",
)
_WEBHOOK_ONLY = (
    "get_transaction", "get_pending_transactions_for_account",
    "get_failed_transactions", "delete_failed_transaction",
    "insert_or_reconcile", "has_event", "mark_event",
)


def test_subclass_still_exposes_every_inherited_and_webhook_method(repo):
    # [A-W1] regression guard: a dropped method would surface here as AttributeError
    # at the first caller in prod — catch it at the class surface instead.
    for name in _INHERITED_CRUD + _WEBHOOK_ONLY:
        assert callable(getattr(type(repo), name, None)), f"missing method: {name}"


def test_get_pending_is_the_webhook_paginated_override_not_the_parent(repo):
    # [A-W2] the money/pagination-critical guard. get_pending_transactions_for_account
    # MUST resolve to the webhook's own paginated (WHIT-82) override. If the shared
    # parent ever grows a same-named method, MRO would still pick the subclass's — but
    # if the subclass's copy were dropped, resolution would fall through to a parent
    # that PAGINATES DIFFERENTLY (or not at all). Pin it to the webhook module.
    method = type(repo).get_pending_transactions_for_account
    assert method.__module__ == "repository", method.__module__

    parent = type(repo).__mro__[1]
    assert parent.__module__ == "repository_transaction", parent.__module__
    # And the parent must NOT define it in its own body (no shadow/conflict today).
    assert "get_pending_transactions_for_account" not in vars(parent)


def test_inherited_crud_methods_are_the_shared_ones_not_local_recopies(repo):
    # [A-W3] "don't reintroduce a local copy" guard: each inherited CRUD method object
    # must BE the shared parent's function, not a byte-copy re-added on the subclass.
    parent = type(repo).__mro__[1]
    for name in ("insert_transactions", "save_failed_transactions", "_batch_put"):
        assert name not in vars(type(repo)), f"{name} was re-copied onto the subclass"
        assert getattr(type(repo), name) is getattr(parent, name)


def test_inherited_insert_transactions_writes_through_subclass(repo):
    # [A-W4] smoke that the inherited insert reaches the table THROUGH the subclass:
    # correct pk/sk prefixes and None fields stripped (sanitise_transaction).
    repo.insert_transactions([
        {"account_id": "acc1", "transaction_id": "t1", "amount": "-5", "notes": None},
    ])
    (key, item), = repo._table.store.items()
    assert key == ("ACCOUNT#acc1", "TXN#t1")
    assert item["amount"] == "-5"
    assert "notes" not in item  # None stripped by sanitise_transaction


def test_inherited_save_failed_stamps_uuid_sk_and_ttl_through_subclass(repo):
    # [A-W5] thin inheritance guard (NOT a re-run of the frozen-clock collision test in
    # tests/shared/test_repository_transaction.py). Calling THROUGH the webhook subclass
    # must reach the shared impl: the dead-letter sort key carries the WHIT-84 uuid
    # (shape "{iso}#{uuid}") and the row carries the WHIT-54 integer TTL. Asserting the
    # sk SHAPE (not a same-microsecond race) reddens if the uuid tail is ever dropped.
    import uuid as _uuid

    repo.save_failed_transactions([{"id": "a"}])
    (key, item), = [(k, v) for k, v in repo._table.store.items() if k[0] == "FAILED"]
    iso, sep, tail = key[1].partition("#")
    assert sep == "#", f"dead-letter sk lost its uuid separator: {key[1]!r}"
    _uuid.UUID(tail)  # raises if the tail isn't a real uuid (WHIT-84)
    assert item["pk"] == "FAILED"
    assert isinstance(item["expires_at"], int) and item["expires_at"] > 0  # WHIT-54 TTL
    assert item["failed_at"]
