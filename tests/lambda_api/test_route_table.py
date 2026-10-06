"""WHIT-791: the handler dispatches fixed paths through one (method, path) table.

API Gateway's fixed-path route keys (no `{id}` placeholder) and the table must match both ways:
a key the table lacks 404s inside the Lambda, a table entry the gateway lacks 404s at the gateway.
The registration test covers only the second direction.
"""

import importlib.util
import pathlib

_spec = importlib.util.spec_from_file_location(
    "route_registration", pathlib.Path(__file__).with_name("test_route_registration.py")
)
route_registration = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(route_registration)
_terraform_route_keys = route_registration._terraform_route_keys


def test_route_table_answers_exactly_the_fixed_paths_api_gateway_declares(handler):
    table_routes = {f"{method} {path}" for method, path in handler._EXACT_ROUTES}
    gateway_fixed_routes = {key for key in _terraform_route_keys() if "{" not in key}

    assert "GET /transactions/feed" in gateway_fixed_routes
    assert table_routes == gateway_fixed_routes
