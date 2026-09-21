"""Every exact-path route the handler dispatches must be registered in API Gateway.

A route the handler answers but terraform never declares is invisible: the Lambda code is
perfect, and the app still gets a 404 from the gateway. Nothing caught that until it shipped —
WHIT-506 added GET /transactions/uncategorized/feed to the handler and not to
`local.app_route_keys`, so the new Uncategorized tab would have 404'd on deploy.

This walks the handler's exact-match dispatch lines (`path == SOME_PATH and method == "VERB"`),
resolves each constant to its value, and asserts the matching "VERB /path" route key exists in
terraform/apigateway.tf. Pattern routes (`path.startswith(...)`) are skipped — their terraform
keys carry `{id}` placeholders this can't derive.
"""

import pathlib
import re

_REPO_ROOT = pathlib.Path(__file__).resolve().parents[2]
_HANDLER = _REPO_ROOT / "lambda_api" / "handler.py"
_CONSTANTS = _REPO_ROOT / "lambda_api" / "constants.py"
_APIGATEWAY = _REPO_ROOT / "terraform" / "apigateway.tf"

# `if path == NAME and method == "VERB":` — the exact-match dispatch shape.
_DISPATCH = re.compile(r'path == ([A-Z][A-Z0-9_]*) and method == "([A-Z]+)"')
# `NAME = "/some/path"` in constants.py.
_PATH_CONSTANT = re.compile(r'^([A-Z][A-Z0-9_]*)\s*=\s*"(/[^"]*)"', re.MULTILINE)
# One quoted route key inside the app_route_keys list.
_ROUTE_KEY = re.compile(r'"([A-Z]+ /[^"]*)"')


def _terraform_route_keys() -> set[str]:
    source = _APIGATEWAY.read_text()
    block = source.split("app_route_keys = toset([", 1)[1].split("])", 1)[0]
    return set(_ROUTE_KEY.findall(block))


def _handler_exact_routes() -> set[str]:
    path_values = dict(_PATH_CONSTANT.findall(_CONSTANTS.read_text()))
    routes = set()
    for constant, method in _DISPATCH.findall(_HANDLER.read_text()):
        # A dispatch on a constant that isn't a literal path (none today) would be a silent
        # miss, so fail loudly rather than skipping it.
        assert constant in path_values, f"{constant} is dispatched on but has no path value"
        routes.add(f"{method} {path_values[constant]}")
    return routes


def test_the_scan_finds_real_routes_on_both_sides():
    # Guards a vacuous pass: if either regex stops matching, the comparison below is empty
    # and would "pass" while checking nothing.
    handler_routes = _handler_exact_routes()
    terraform_routes = _terraform_route_keys()
    assert len(handler_routes) > 5
    assert len(terraform_routes) > 20
    assert "GET /transactions/feed" in handler_routes
    assert "GET /transactions/feed" in terraform_routes


def test_every_exact_handler_route_is_registered_in_api_gateway():
    missing = sorted(_handler_exact_routes() - _terraform_route_keys())
    assert missing == [], (
        "these routes are answered by lambda_api/handler.py but not declared in "
        f"terraform/apigateway.tf, so they 404 at the gateway once deployed: {missing}"
    )
