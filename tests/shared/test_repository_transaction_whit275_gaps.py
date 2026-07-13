"""WHIT-275 adversarial GAP tests for update_transaction_fields.

The implementer covers clearing NOTES and TAGS (index 1/2 REMOVE aliases) and the
SET+REMOVE mix. This adds the CATEGORY-clear path (index 0, alias #f0): the repo is
a lower-level primitive that will REMOVE category on a falsy value even though the
handler forbids clearing category — a deliberate divergence worth pinning so a
future change to the alias/loop can't silently break the #f0 REMOVE branch, and so
the handler stays the sole gate. Reuses the `repo` fixture from conftest.
"""


def test_update_fields_clears_category_when_passed_falsy(repo):  # [A12]
    # The repo REMOVEs category on "" (the #f0 alias REMOVE branch). The handler
    # blocks this at the edge; the repo itself does not — this pins that split.
    key = ("ACCOUNT#acct", "TXN#t1")
    repo._table.store = {key: {"pk": key[0], "sk": key[1], "category": "GROCERIES", "notes": "n"}}
    assert repo.update_transaction_fields(key[0], key[1], category="") is True
    row = repo._table.store[key]
    assert "category" not in row   # category REMOVEd via the #f0 branch
    assert row["notes"] == "n"     # an unpassed field is untouched


def test_update_fields_remove_only_omits_expression_attribute_values(repo, monkeypatch):  # [A13]
    # A REMOVE-only update (clear category) must NOT send ExpressionAttributeValues —
    # DynamoDB rejects an UpdateItem carrying an empty values map. Capture the kwargs
    # the repo hands the table and assert the key is absent entirely.
    key = ("ACCOUNT#acct", "TXN#t1")
    repo._table.store = {key: {"pk": key[0], "sk": key[1], "category": "X"}}
    captured = {}
    original = repo._table.update_item
    def spy(**kwargs):
        captured.update(kwargs)
        return original(**kwargs)
    monkeypatch.setattr(repo._table, "update_item", spy)

    assert repo.update_transaction_fields(key[0], key[1], category="") is True
    assert "ExpressionAttributeValues" not in captured
    assert captured["UpdateExpression"].strip().startswith("REMOVE")
