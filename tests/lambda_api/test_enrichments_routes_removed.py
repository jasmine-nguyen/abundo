"""WHIT-535 — regression guards for the DELETED /enrichments BankSync proxy.

The proxy routes (GET/POST /enrichments, PUT/DELETE /enrichments/{id}), their handlers, the
_banksync_error_response translator, and the ENRICHMENTS_PATH / BANKSYNC_TIMEOUT_SECONDS constants
were removed (WHIT-535). The old behaviour was tested in the deleted test_enrichments.py; these are
forward guards at the DISPATCH + constants boundaries — they go red if the routes, symbols or
constants come back, and prove the SURVIVING /rules store route + the balance-refresh get_api_key
wrapper are undisturbed.

Reuses the suite's `handler` fixture (tests/lambda_api/conftest.py) and the shared constants reader.
"""

import json
import pathlib

import pytest

from _feed_fakes import FakeCategoryRepo
from _lambda_api_constants import constants_namespace
from _rule_fakes import FakeRuleRepo

_ROOT = pathlib.Path(__file__).resolve().parents[2]


def _event(method, path, path_params=None):
    ev = {"rawPath": path, "requestContext": {"http": {"method": method}}}
    if path_params is not None:
        ev["pathParameters"] = path_params
    return ev


@pytest.mark.parametrize("method, path, path_params", [
    ("GET", "/enrichments", None),
    ("POST", "/enrichments", None),
    ("PUT", "/enrichments/enr_1", {"id": "enr_1"}),
    ("DELETE", "/enrichments/enr_1", {"id": "enr_1"}),
])
def test_every_enrichments_route_now_returns_404(handler, method, path, path_params):
    # The exact requests the old app sent must fall through to the gateway 404 default —
    # not be served, and not surface the proxy's old 200/201/502.
    resp = handler.lambda_handler(_event(method, path, path_params), None)
    assert resp["statusCode"] == 404
    assert json.loads(resp["body"]) == {"error": "Not found"}


def test_enrichment_handler_symbols_are_gone(handler):
    for name in ("get_enrichments", "create_enrichment", "update_enrichment",
                 "delete_enrichment", "_banksync_error_response", "BankSyncError"):
        assert not hasattr(handler, name), f"{name} should have been removed from handler"


def test_enrichments_constants_removed_from_lambda_api(handler):
    api = constants_namespace(_ROOT / "lambda_api" / "constants.py")
    assert "ENRICHMENTS_PATH" not in api
    assert "BANKSYNC_TIMEOUT_SECONDS" not in api
    # The kept BankSync values the balance refresh still imports survive.
    assert api["BANKSYNC_API_KEY_PATH"] == "/abundo/banksync-api-key"
    assert api["BANKSYNC_BASE_URL"] == "https://api.banksync.io"


def test_rules_store_route_still_works_after_the_proxy_removal(handler, monkeypatch):
    # The replacement store route is undisturbed: GET /rules still lists.
    monkeypatch.setattr(handler, "RuleRepository", lambda: FakeRuleRepo())
    monkeypatch.setattr(handler, "CategoryRepository", lambda: FakeCategoryRepo(("groceries",)))
    resp = handler.lambda_handler(_event("GET", "/rules"), None)
    assert resp["statusCode"] == 200
    assert json.loads(resp["body"]) == []


def test_enrichments_routes_gone_from_api_gateway():
    apigateway = (_ROOT / "terraform" / "apigateway.tf").read_text()
    assert "/enrichments" not in apigateway
    # The surviving store routes remain declared.
    assert '"GET /rules"' in apigateway
    assert '"DELETE /rules/{id}"' in apigateway
