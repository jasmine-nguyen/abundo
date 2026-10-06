"""QA gap tests for WHIT-765: `json.dumps(..., default=float)` replaced DecimalEncoder in
the API response and the chat tool results. Decimals must still come out as plain JSON
numbers.
"""

import json
from decimal import Decimal


# [A14] (P0) every Decimal in an API response, at any depth, is a JSON number
def test_json_response_renders_nested_decimals_as_numbers(handler):
    body = {"amount": Decimal("-12.34"), "rows": [{"target": Decimal("100")}], "none": None}

    wire = handler._json_response(200, body)

    assert wire["statusCode"] == 200
    assert wire["headers"] == {"Content-Type": "application/json"}
    assert '"amount": -12.34' in wire["body"]
    assert json.loads(wire["body"]) == {"amount": -12.34, "rows": [{"target": 100.0}], "none": None}


# [A16] (P0) a chat tool's Decimal output reaches the model as JSON numbers
def test_chat_tool_result_renders_decimals_as_numbers(ai_chat, monkeypatch):
    monkeypatch.setitem(ai_chat.TOOL_FUNCTIONS, "qa_tool", lambda data, args: {"spent": Decimal("60.5")})

    block = ai_chat._run_tool({"name": "qa_tool", "id": "call-1"}, None, set())

    assert block["type"] == "tool_result"
    assert block["tool_use_id"] == "call-1"
    assert json.loads(block["content"]) == {"spent": 60.5}
