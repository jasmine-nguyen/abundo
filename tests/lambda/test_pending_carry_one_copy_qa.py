"""WHIT-663 slice 1 QA — the webhook uses the ONE shared copy of the matching and the carry.

If a local copy creeps back into lambda/ (or lambda/merchant.py returns and shadows the layer's),
the age-out, settlement and the hourly mirror can silently disagree again.
"""

import ast
import pathlib
import subprocess
import sys

_REPO_ROOT = pathlib.Path(__file__).resolve().parents[2]
_MOVED = {
    "counts_to_budget", "with_carried_category", "merchant_matches_pending", "_merchant_gate",
    "_same_cleaned_merchant", "_merchant_in_description", "_words", "_within_days",
    "_is_carry_twin", "_find_carry_twin", "find_carry_twin", "_pending_is_filed",
    "_pending_category_is_user_set", "clean_merchant", "is_anz_pending", "pending_merchant_column",
}


def _tracked_lambda_modules() -> list[str]:
    listed = subprocess.run(["git", "ls-files", "--", ":(glob)lambda/*.py"], cwd=_REPO_ROOT,
                            capture_output=True, text=True, check=True)
    return listed.stdout.split()


# [A10] (P0) no webhook module defines its own copy of a moved helper, and lambda/merchant.py
# is gone (a copy in the webhook zip would shadow the layer's merchant.py).
def test_no_webhook_module_redefines_a_moved_helper():
    tracked = _tracked_lambda_modules()
    assert "lambda/age_out.py" in tracked and "lambda/reconcile.py" in tracked  # scan isn't vacuous
    assert "lambda/merchant.py" not in tracked

    redefined = []
    for path in tracked:
        tree = ast.parse((_REPO_ROOT / path).read_text())
        for node in ast.walk(tree):
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and node.name in _MOVED:
                redefined.append(f"{path}:{node.name}")
    assert redefined == []


# [A11] (P0) at runtime the webhook's names ARE the shared objects — one copy, not two.
def test_webhook_names_resolve_to_the_shared_objects(lam):
    pending_carry = sys.modules["pending_carry"]
    spend = sys.modules["spend"]

    assert pathlib.Path(lam.merchant.__file__).parent.name == "shared"
    assert pathlib.Path(pending_carry.__file__).parent.name == "shared"
    assert lam.reconcile.with_carried_category is pending_carry.with_carried_category
    assert lam.age_out.with_carried_category is pending_carry.with_carried_category
    assert lam.age_out.find_carry_twin is pending_carry.find_carry_twin
    assert lam.age_out.is_filed is pending_carry.is_filed
    assert lam.reconcile.merchant_matches_pending is lam.merchant.merchant_matches_pending
    assert lam.reconcile._merchant_gate is lam.merchant._merchant_gate
    assert lam.banksync.counts_to_budget is spend.counts_to_budget
    assert lam.rule_ingest.counts_to_budget is spend.counts_to_budget
