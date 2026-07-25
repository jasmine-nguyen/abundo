"""WHIT-333: the four twin-matching tiers now share their candidate-pick / pop tail.

The deterministic pick-and-remove — the money-safety core that DELETES a financial
row — lives in `_pop_lowest_id`, used by all four tiers. The three tiers whose whole
candidate set is a single predicate (exact, tip, blank-auth) additionally share
`_select_twin`. These lock both helpers and the exact tier's amount-less pairing.

Each is fail-on-revert: break the extracted behaviour (wrong pick, dropped pop, an
added guard) and the named assert goes red. The four tiers' end-to-end behaviour is
already pinned by the existing tests/lambda/test_reconcile*.py suite.
"""

from decimal import Decimal


def _row(txn_id, amount=Decimal("-9.00")):
    return {"transaction_id": txn_id, "amount": amount, "authorized_date": "2026-06-29"}


# --- the shared money-safety core: deterministic pick + remove ---------------


def test_pop_lowest_id_picks_lowest_among_indices_and_pops_it(repo):
    # Only indices 0 and 2 are offered; the helper must pick the lower transaction_id
    # BETWEEN THEM ("A") and pop just it — the un-offered lower id at index 1 ("0") and
    # the loser both survive. min->max or the wrong pop target fails an assert.
    pool = [_row("A"), _row("0"), _row("C")]
    picked = repo._pop_lowest_id(pool, [0, 2])
    assert picked["transaction_id"] == "A"
    assert [r["transaction_id"] for r in pool] == ["0", "C"]


def test_pop_lowest_id_missing_transaction_id_sorts_first(repo):
    # `.get("transaction_id", "")` defaults a keyless row to "" so it wins the min
    # instead of raising. Drop the default and this raises KeyError.
    keyless = {"amount": Decimal("-9.00")}
    pool = [_row("A"), keyless]
    picked = repo._pop_lowest_id(pool, [0, 1])
    assert "transaction_id" not in picked
    assert [r.get("transaction_id") for r in pool] == ["A"]


# --- the shared candidate-select tail (exact / tip / blank-auth) --------------


def test_select_twin_filters_then_picks_lowest_and_pops(repo):
    # The predicate rejects the lowest-id row ("A"); among the matches ("M","N") the
    # helper picks the lower id and pops only it. A regression that min'd over the whole
    # pool would pick "A"; one that popped a candidate-list position not the pool index
    # would drop the wrong row.
    pool = [_row("A", Decimal("-1.00")), _row("M"), _row("N")]
    picked = repo._select_twin(pool, lambda item: item.get("amount") == Decimal("-9.00"))
    assert picked["transaction_id"] == "M"
    assert [r["transaction_id"] for r in pool] == ["A", "N"]


def test_select_twin_no_candidate_returns_none_and_keeps_pool(repo):
    pool = [_row("A")]
    assert repo._select_twin(pool, lambda item: False) is None
    assert len(pool) == 1


# --- a per-tier behaviour the extraction must not have changed ----------------


def test_exact_tier_matches_a_null_amount_pair(repo):
    # The exact tier deliberately has NO `amount is not None` guard, so a posted row with
    # a null amount still pairs with a null-amount pending on an equal date. Add a guard
    # "to clean up" and this goes red.
    pending = {"transaction_id": "A", "amount": None, "authorized_date": "2026-06-29"}
    posted = {"account_id": "ACC", "amount": None, "authorized_date": "2026-06-29",
              "transaction_id": "P"}
    twin = repo._find_exact_twin(posted, {"ACC": [pending]})
    assert twin is not None
    assert twin["transaction_id"] == "A"
