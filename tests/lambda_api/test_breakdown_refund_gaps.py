"""QA GAP tests for GET /breakdown __rollup__.refunds (list_category_breakdown, WHIT-349
slice 3+4).

The implementer's test_breakdown.py already locks the headline refund cases: a single-
level net-refunded child, a refund under a collapsed mid-parent, a refund on the parent's
own direct spend, the no-refunds-key case, and the JSON serialisation. These add the
ADVERSARIAL edges it does not (see the ranked critique for the verdict on each):

  * the INDEPENDENT posted/pending clamp gap — a subtree with a posted SURPLUS but a
    PENDING refund: the node floors pending independently, but the refund line reports the
    member's COMBINED net, so the emitted rollup CANNOT reconcile (the plan's known minor),
  * a GRANDCHILD refund under a NET-POSITIVE mid-parent — the refund attaches to the
    mid-parent (which has a node), NOT to the top-level ancestor,
  * a refunded SUB-PARENT (a refunded member that itself has children) — reported by the
    direct child's id with its whole subtree's net; the sub-parent gets no node,
  * INCOME and SAVINGS categories never leak into nodes/refunds even when net-negative,
    while __earned__ and __uncategorized__ still coexist.

Local fakes mirror test_breakdown.py's stand-ins so the file stands alone (matches the
test_budget_transactions_gaps.py precedent). The `handler` fixture comes from conftest.py.
"""

from decimal import Decimal


class FakeCategoryRepo:
    def __init__(self, categories=None):
        self._categories = categories or []

    def list_categories(self):
        return [dict(c) for c in self._categories]


class FakeTransactionRepo:
    """Serves a single page then empties, so the per-account loop counts each txn once."""

    def __init__(self, transactions=None):
        self._queue = [(list(transactions or []), None)]
        self.calls = []

    def get_transactions_by_date_range(self, account_id, start_date, end_date, limit=20, cursor=None):
        self.calls.append((account_id, start_date, end_date, limit, cursor))
        return self._queue.pop(0) if self._queue else ([], None)


class FakePayCycleRepo:
    def __init__(self, length=14, last_pay_date="2024-01-03"):
        self._cycle = {"length": length, "last_pay_date": last_pay_date}

    def get_paycycle(self):
        return dict(self._cycle)


def _category(cat_id, bucket, name=None):
    return {"id": cat_id, "name": name or cat_id.title(), "icon": "tag",
            "color": "#123456", "bucket": bucket}


def _child(cat_id, bucket, parent):
    return {**_category(cat_id, bucket), "parent": parent}


def _transaction(category, amount, status="posted", counts=True):
    return {"category": category, "amount": Decimal(str(amount)), "status": status,
            "counts_to_budget": counts}


# --- The independent posted/pending clamp gap (the plan's known minor) --------


def test_rollup_posted_surplus_with_pending_refund_cannot_reconcile(handler):
    # GAP: petrol has a POSTED spend of 100; tolls has a PENDING refund of 30. The node
    # folds posted and pending INDEPENDENTLY (fold_subtree), so the -30 pending floors to 0
    # at the node -> node = {posted 100, pending 0} = 100. But tolls' COMBINED net is -30, so
    # it's emitted as a refund line of -30. The expanded list (petrol 100 + refund -30 = 70)
    # therefore does NOT equal the node (100): off by the clamped pending remainder (30).
    # This pins the ACTUAL behaviour — an emitted rollup the client can't reconcile.
    cats = FakeCategoryRepo([
        _category("car", "Living"),
        _child("petrol", "Living", "car"),
        _child("tolls", "Living", "car"),
    ])
    txns = FakeTransactionRepo([
        _transaction("petrol", -100, "posted"),   # +100 posted spend
        _transaction("tolls", 30, "pending"),      # -30 pending refund (positive amount)
    ])

    result = handler.list_category_breakdown(cats, txns, FakePayCycleRepo())
    rollup = result["__rollup__"]

    assert rollup["nodes"]["car"] == {"posted": Decimal("100"), "pending": Decimal("0")}
    assert rollup["refunds"] == {"car": [{"id": "tolls", "amount": Decimal("-30")}]}

    node_total = rollup["nodes"]["car"]["posted"] + rollup["nodes"]["car"]["pending"]   # 100
    shown_petrol = result["petrol"]["posted"] + result["petrol"]["pending"]             # 100
    refund_sum = sum(r["amount"] for r in rollup["refunds"]["car"])                     # -30
    reconciled = shown_petrol + refund_sum                                              # 70
    assert node_total == Decimal("100")
    assert reconciled == Decimal("70")
    assert reconciled != node_total   # <-- the gap: the expanded list under-sums by 30


# --- multi-level: a grandchild refund under a NET-POSITIVE mid-parent --------


def test_rollup_grandchild_refund_attaches_to_positive_mid_parent_not_top(handler):
    # car > travel(own +50) > tolls(-30 refund); a sibling petrol(+60) directly under car.
    # travel's subtree nets +20 (positive) -> travel HAS a node and is NOT a refund under car.
    # The tolls refund attaches to travel (its direct parent), so travel reconciles as
    # "Directly in travel" 50 + refund -30 = 20 == travel node. car lists NO refund.
    cats = FakeCategoryRepo([
        _category("car", "Living"),
        _child("petrol", "Living", "car"),
        _child("travel", "Living", "car"),
        _child("tolls", "Living", "travel"),
    ])
    txns = FakeTransactionRepo([
        _transaction("petrol", -60, "posted"),
        _transaction("travel", -50, "posted"),   # travel's own direct spend
        _transaction("tolls", 30, "posted"),      # -30 refund two levels down
    ])

    result = handler.list_category_breakdown(cats, txns, FakePayCycleRepo())
    rollup = result["__rollup__"]

    assert rollup["nodes"]["car"] == {"posted": Decimal("80"), "pending": Decimal("0")}   # 60+50-30
    assert rollup["nodes"]["travel"] == {"posted": Decimal("20"), "pending": Decimal("0")}
    # The refund lands on travel (the parent in nodes with the negative child), NOT on car.
    assert rollup["refunds"] == {"travel": [{"id": "tolls", "amount": Decimal("-30")}]}


# --- a refunded SUB-PARENT (a refunded member that itself has children) -------


def test_rollup_refunded_subparent_reported_by_child_id_with_whole_subtree_net(handler):
    # car > petrol(+200); car > shopping(sub-parent) > {shoes(+40), clothes(-120)}.
    # shopping's whole subtree nets -80 (< 0) -> shopping COLLAPSES (no node) and is reported
    # as a single refund line under car keyed by shopping with amount -80 (its subtree net),
    # even though shopping is itself a parent. car node = 200 + (-80) = 120.
    cats = FakeCategoryRepo([
        _category("car", "Living"),
        _child("petrol", "Living", "car"),
        _child("shopping", "Living", "car"),
        _child("shoes", "Living", "shopping"),
        _child("clothes", "Living", "shopping"),
    ])
    txns = FakeTransactionRepo([
        _transaction("petrol", -200, "posted"),
        _transaction("shoes", -40, "posted"),
        _transaction("clothes", 120, "posted"),   # -120 refund
    ])

    result = handler.list_category_breakdown(cats, txns, FakePayCycleRepo())
    rollup = result["__rollup__"]

    assert rollup["nodes"]["car"] == {"posted": Decimal("120"), "pending": Decimal("0")}
    assert "shopping" not in rollup["nodes"]   # collapsed sub-parent, no node
    assert rollup["refunds"] == {"car": [{"id": "shopping", "amount": Decimal("-80")}]}


# --- income / savings never in refunds; earned + uncategorized coexist -------


def test_rollup_income_and_savings_never_in_nodes_or_refunds(handler):
    # A spend parent with a refunded child, PLUS an Income earn and a net-negative Savings
    # subtree and a raw uncategorized charge. The rollup must carry ONLY the spend parent:
    # income/savings are never spend_ids, so they can't inflate nodes NOR appear as refunds,
    # even when the savings subtree nets negative. __earned__/__uncategorized__ still ride along.
    cats = FakeCategoryRepo([
        _category("car", "Living"),
        _child("petrol", "Living", "car"),
        _child("tolls", "Living", "car"),
        _category("salary", "Income"),
        _category("vault", "Savings"),
        _child("vault_sub", "Savings", "vault"),
    ])
    txns = FakeTransactionRepo([
        _transaction("petrol", -60, "posted"),
        _transaction("tolls", 30, "posted"),        # -30 spend refund
        _transaction("salary", 2000, "posted"),      # income (earned)
        _transaction("vault_sub", -100, "posted"),
        _transaction("vault_sub", 250, "posted"),    # savings subtree nets negative
        _transaction("MEDICAL", -20, "posted"),      # raw uncategorized
    ])

    result = handler.list_category_breakdown(cats, txns, FakePayCycleRepo())
    rollup = result["__rollup__"]

    assert set(rollup["nodes"].keys()) == {"car"}                 # no salary/vault node
    assert rollup["refunds"] == {"car": [{"id": "tolls", "amount": Decimal("-30")}]}
    assert "salary" not in rollup["refunds"] and "vault" not in rollup["refunds"]
    assert "vault_sub" not in rollup["refunds"]
    assert result["__earned__"]["posted"] == Decimal("2000")     # earned still emitted
    assert "__uncategorized__" in result                          # raw charge still bucketed
