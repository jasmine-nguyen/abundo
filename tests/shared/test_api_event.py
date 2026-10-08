"""WHIT-825: the shared fake-request builder emits the same event dict the hand-written builders did."""

import pytest

from _api_event import api_event

GET_GOALS = {"rawPath": "/goals", "requestContext": {"http": {"method": "GET"}}}


@pytest.mark.parametrize(
    "kwargs, expected",
    [
        ({"method": "GET", "path": "/goals"}, GET_GOALS),
        (
            {"method": "PUT", "path": "/goals/g1", "body": {"target": 50}, "path_params": {"id": "g1"}},
            {
                "rawPath": "/goals/g1",
                "requestContext": {"http": {"method": "PUT"}},
                "pathParameters": {"id": "g1"},
                "body": '{"target": 50}',
            },
        ),
        (
            {"method": "POST", "path": "/rules", "body": {"ignored": True}, "raw": "{not json", "is_base64": False},
            {
                "rawPath": "/rules",
                "requestContext": {"http": {"method": "POST"}},
                "body": "{not json",
                "isBase64Encoded": False,
            },
        ),
        (
            {"method": "GET", "path": "/milestones", "raw": ""},
            {"rawPath": "/milestones", "requestContext": {"http": {"method": "GET"}}, "body": ""},
        ),
        (
            {"method": "GET", "path": "/transactions", "query": {"limit": "10"}, "path_params": {}},
            {
                "rawPath": "/transactions",
                "requestContext": {"http": {"method": "GET"}},
                "pathParameters": {},
                "queryStringParameters": {"limit": "10"},
            },
        ),
        (
            {"method": "PUT", "path": "/categories/c1", "raw": "eyJhIjogMX0=", "is_base64": True},
            {
                "rawPath": "/categories/c1",
                "requestContext": {"http": {"method": "PUT"}},
                "body": "eyJhIjogMX0=",
                "isBase64Encoded": True,
            },
        ),
    ],
    ids=["minimal-get", "json-body-and-path-params", "raw-wins-over-body", "empty-raw-body", "query", "base64"],
)
def test_api_event_builds_the_api_gateway_event_with_only_the_keys_passed(kwargs, expected):
    assert api_event(**kwargs) == expected
