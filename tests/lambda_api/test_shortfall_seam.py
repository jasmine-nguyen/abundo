"""WHIT-126 (adversarial gaps) — the SHORTFALL goal's whole-stack seam + sanitise
bounds the implementer's tests don't reach.

The existing threading/cache-bust tests (WHIT-134) only exercise the 'ahead' payoff
goal; this suite proves a raw client SHORTFALL block flows _extract_goal ->
_sanitise_goal -> assemble_insight_input -> input_hash and busts a spend-only cache,
and pins the $1M sanitise cap + the required_extra >= 0 boundary.

Reuses the conftest `handler` fixture. The fakes are tiny local infra (not test
cases) — kept standalone so this file is independently runnable.
"""
import hashlib
import json
from decimal import Decimal
from functools import partial

from _budget_endpoint_fakes import _FakeCategoryRepo, _FakePayCycleRepo
from _insight_fakes import insight_puts, insight_repo
from _transaction_range_fakes import _WindowKeyedTransactionRepo


# --- local fakes (mirror the sibling suite's; infra, not duplicated test cases) ----

FakeCategoryRepo = partial(_FakeCategoryRepo, [{"id": "groceries", "name": "Groceries", "bucket": "Living"}])


class _FakeBudgetRepo:
    def list_budgets(self):
        return {"groceries": {"target": Decimal("300")}}


FakePayCycleRepo = partial(_FakePayCycleRepo, length=14, last_pay_date="2024-01-03")


def _txn(category, amount, status="posted"):
    return {"category": category, "amount": Decimal(str(amount)), "status": status,
            "counts_to_budget": True}


def _hash(model_input):
    return hashlib.sha256(
        json.dumps(model_input, sort_keys=True, default=str).encode()).hexdigest()


# The raw shape the CLIENT posts for a shortfall (before sanitise). goal_date is the
# "Mon YYYY" label the client derives from the goal date — never the ISO string.
_RAW_SHORTFALL = {
    "payoff_mode": "shortfall",
    "goal_date": "Jun 2035",
    "required_repayment": 4500,
    "required_extra": 333,
    "current_extra_monthly": 500,
}


# --- the whole-stack seam: a shortfall goal threads through + busts the cache -------

def test_generate_threads_shortfall_goal_into_model_input_and_hash(handler, monkeypatch):
    cycle = FakePayCycleRepo().get_paycycle()
    start, end = handler.current_cycle_window(cycle["last_pay_date"], cycle["length"])
    txn_repo = _WindowKeyedTransactionRepo({(start, end): [_txn("groceries", -50)]})
    captured = {}

    def _capture(mi):
        captured["mi"] = mi
        return {"summary": "s", "suggestions": []}

    monkeypatch.setattr(handler, "generate_suggestions", _capture)
    repo = insight_repo(existing=None)
    event = {"body": json.dumps({"goal": dict(_RAW_SHORTFALL)})}

    resp = handler.generate_ai_insights(
        FakeCategoryRepo(), _FakeBudgetRepo(), txn_repo, FakePayCycleRepo(), repo, event)

    assert resp["statusCode"] == 200
    # The sanitised SHORTFALL goal reached the model, keeping its shortfall fields...
    assert captured["mi"]["goal"]["payoff_mode"] == "shortfall"
    assert captured["mi"]["goal"]["required_extra"] == 333.0
    assert "mortgage_free_date" not in captured["mi"]["goal"]
    # ...and is baked into the stored cache hash (a later goal change -> cache miss).
    assert insight_puts(repo)[0]["input_hash"] == _hash(captured["mi"])


def test_shortfall_goal_busts_an_otherwise_matching_spend_only_cache(handler, monkeypatch):
    # Same cycle + same spend as a cached SPEND-ONLY insight, but now with a shortfall
    # goal: the hash differs, so the stale row must NOT be served — it regenerates.
    cycle = FakePayCycleRepo().get_paycycle()
    start, end = handler.current_cycle_window(cycle["last_pay_date"], cycle["length"])
    window = {(start, end): [_txn("groceries", -50)]}
    spend_only, cycle_start = handler.assemble_insight_input(
        FakeCategoryRepo(), _FakeBudgetRepo(), _WindowKeyedTransactionRepo(dict(window)), FakePayCycleRepo())
    repo = insight_repo(existing={
        "summary": "spend-only cached", "suggestions": [], "generated_at": "t",
        "input_hash": _hash(spend_only)}, cycle_start=cycle_start)
    monkeypatch.setattr(handler, "generate_suggestions",
                        lambda mi: {"summary": "regenerated with shortfall", "suggestions": []})
    event = {"body": json.dumps({"goal": dict(_RAW_SHORTFALL)})}

    resp = handler.generate_ai_insights(
        FakeCategoryRepo(), _FakeBudgetRepo(), _WindowKeyedTransactionRepo(dict(window)),
        FakePayCycleRepo(), repo, event)

    body = json.loads(resp["body"])
    assert body["cached"] is False
    assert body["summary"] == "regenerated with shortfall"
    assert len(insight_puts(repo)) == 1


# --- the $1M sanitise cap boundary (silent-drop threshold) --------------------------

def test_sanitise_goal_shortfall_accepts_required_repayment_at_the_1m_cap(handler):
    # Exactly 1_000_000 is inside [low, high] -> accepted (boundary is inclusive).
    g = handler._sanitise_goal({**_RAW_SHORTFALL, "required_repayment": 1_000_000})
    assert g is not None and g["required_repayment"] == 1_000_000.0


def test_sanitise_goal_shortfall_drops_required_repayment_over_the_1m_cap(handler):
    # A big loan + near date makes the client emit > 1M; the server SILENTLY drops the
    # whole shortfall block (degrades to spend-only) with no user feedback. Pins that
    # threshold so a change to the cap is caught. See the critique for the UX risk.
    assert handler._sanitise_goal({**_RAW_SHORTFALL, "required_repayment": 1_000_000.01}) is None


# --- the required_extra >= 0 boundary (the "always > 0" invariant is NOT enforced) --

def test_sanitise_goal_shortfall_accepts_zero_required_extra(handler):
    # The client's 'none' math makes required_extra strictly > 0, but the server only
    # requires >= 0: a 0 gap is ACCEPTED (would prompt "roughly $0 more than now").
    # Characterises current behaviour; flip -> a real invariant break to review.
    g = handler._sanitise_goal({**_RAW_SHORTFALL, "required_extra": 0})
    assert g is not None and g["required_extra"] == 0.0


def test_sanitise_goal_shortfall_rejects_negative_required_extra(handler):
    assert handler._sanitise_goal({**_RAW_SHORTFALL, "required_extra": -1}) is None
