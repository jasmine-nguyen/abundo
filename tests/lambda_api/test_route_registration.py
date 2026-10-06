"""Every exact-path route the handler dispatches must be registered in API Gateway.

A route the handler answers but terraform never declares is invisible: the Lambda code is
perfect, and the app still gets a 404 from the gateway. Nothing caught that until it shipped —
WHIT-506 added GET /transactions/uncategorized/feed to the handler and not to
`local.app_route_keys`, so the new Uncategorized tab would have 404'd on deploy.

This reads the handler's exact-match route table (`_EXACT_ROUTES`, keyed (method, path)) and
asserts the matching "VERB /path" route key exists in terraform/apigateway.tf. Prefix routes are
skipped — their terraform keys carry `{id}` placeholders this can't derive.
"""

from _terraform import app_route_keys, exact_route_keys


def test_the_scan_finds_real_routes_on_both_sides(handler):
    # Guards a vacuous pass: if either side comes back empty, the comparison below is empty
    # and would "pass" while checking nothing.
    handler_routes = exact_route_keys(handler)
    terraform_routes = app_route_keys()
    assert len(handler_routes) > 5
    assert len(terraform_routes) > 20
    assert "GET /transactions/feed" in handler_routes
    assert "GET /transactions/feed" in terraform_routes


def test_every_exact_handler_route_is_registered_in_api_gateway(handler):
    missing = sorted(exact_route_keys(handler) - app_route_keys())
    assert missing == [], (
        "these routes are answered by lambda_api/handler.py but not declared in "
        f"terraform/apigateway.tf, so they 404 at the gateway once deployed: {missing}"
    )
