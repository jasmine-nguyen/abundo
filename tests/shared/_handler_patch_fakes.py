"""Shared fakes for the PATCH /transactions/{id} handler suites.

Three suites drive patch_transaction with the same transaction-repo fake and the same
PATCH event builder: the impl suite tests/lambda_api/test_handler.py and its two gap
suites, test_handler_whit275_gaps.py and test_handler_whit296_gaps.py. They live here, in
ONE definition, so all three `import` them instead of copying FakeRepo (a copy of the
sentinel-gated update_transaction_fields could drift and start recording a field the real
signature no longer accepts — WHIT-445).

Resolved by pytest.ini's `pythonpath = tests/shared`. Pure stdlib, no shared/-layer import,
so no conftest `_REIMPORT` entry is needed.
"""

# Sentinel marking "field not provided" — distinct from any real value (including None), so
# update_transaction_fields records ONLY the fields a request actually carried.
_UNSET = object()


class FakeRepo:
    """Stand-in for TransactionRepository that records the field write it's asked to do.

    Records each update as (pk, sk, {only the provided fields}), mirroring
    update_transaction_fields' keyword-only, sentinel-gated signature."""

    def __init__(self, keys=None, update_result=True):
        self._keys = keys
        self._update_result = update_result
        self.update_calls = []

    def get_transaction_keys_by_id(self, transaction_id):
        return self._keys

    def update_transaction_fields(
        self, pk, sk, *, category=_UNSET, notes=_UNSET, tags=_UNSET, budget_excluded=_UNSET
    ):
        provided = {
            field: value
            for field, value in (
                ("category", category),
                ("notes", notes),
                ("tags", tags),
                ("budget_excluded", budget_excluded),
            )
            if value is not _UNSET
        }
        self.update_calls.append((pk, sk, provided))
        return self._update_result


def _patch_event(transaction_id="txn-1", body='{"category": "groceries"}', is_b64=False):
    return {
        "rawPath": f"/transactions/{transaction_id}",
        "requestContext": {"http": {"method": "PATCH"}},
        "pathParameters": {"id": transaction_id},
        "body": body,
        "isBase64Encoded": is_b64,
    }
