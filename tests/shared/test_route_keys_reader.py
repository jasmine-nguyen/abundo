"""WHIT-805: a route key commented out in apigateway.tf is switched off, so the reader must skip it."""

from _terraform import route_keys

_APIGATEWAY_SAMPLE = '''
locals {
  app_route_keys = toset([
    # Transactions
    "GET /a",
    # "DELETE /b",
    // "PUT /c",
    "POST /d", # note
  ])
}
'''


def test_route_keys_skip_commented_out_routes():
    assert route_keys(_APIGATEWAY_SAMPLE) == {"GET /a", "POST /d"}
