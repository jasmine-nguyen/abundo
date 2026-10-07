"""WHIT-791: the handler dispatches fixed paths through one (method, path) table.

API Gateway's fixed-path route keys (no `{id}` placeholder) and the table must match both ways:
a key the table lacks 404s inside the Lambda, a table entry the gateway lacks 404s at the gateway.
This test is the only check in both directions.
"""

from _terraform import app_route_keys, exact_route_keys


def test_route_table_answers_exactly_the_fixed_paths_api_gateway_declares(handler):
    table_routes = exact_route_keys(handler)
    gateway_fixed_routes = {key for key in app_route_keys() if "{" not in key}

    assert "GET /transactions/feed" in gateway_fixed_routes
    assert table_routes == gateway_fixed_routes
