"""QA gap test for WHIT-765: `json.dumps(..., default=float)` replaced DecimalEncoder in
the chat tool results. Decimals must still reach the model as plain JSON numbers.
"""

import json
from decimal import Decimal


# [A16] (P0) a chat tool's Decimal output reaches the model as JSON numbers
def test_chat_tool_result_renders_decimals_as_numbers(ai_chat, monkeypatch):
    monkeypatch.setitem(ai_chat.TOOL_FUNCTIONS, "qa_tool", lambda data, args: {"spent": Decimal("60.5")})

    block = ai_chat._run_tool({"name": "qa_tool", "id": "call-1"}, None, set())

    assert block["type"] == "tool_result"
    assert block["tool_use_id"] == "call-1"
    assert json.loads(block["content"]) == {"spent": 60.5}
