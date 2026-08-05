"""Shared server-side Anthropic Messages client (WHIT-388).

The single home for the plumbing insights_ai.py and milestone_ai.py used to each
copy: the urllib POST (custom User-Agent, since api.anthropic.com is Cloudflare-
fronted and 403s the default urllib agent), an SSM-cached API key, the typed
AnthropicError the handler maps to a response, and the first-{...}-span JSON
extraction. Each caller supplies only its own system prompt, user prefix, and
reply parser.

Lives in lambda_api/ (not the shared layer) on purpose: the ANTHROPIC_* constants
it reads live only in lambda_api/constants.py, and lambda_api is the only function
that calls Anthropic.
"""

import json
import re
import urllib.error
import urllib.request

from constants import (
    ANTHROPIC_API_KEY_PATH,
    ANTHROPIC_BASE_URL,
    ANTHROPIC_MAX_TOKENS,
    ANTHROPIC_MESSAGES_PATH,
    ANTHROPIC_MODEL,
    ANTHROPIC_THINKING,
    ANTHROPIC_TIMEOUT_SECONDS,
    ANTHROPIC_USER_AGENT,
    ANTHROPIC_VERSION,
)
from api_key import get_api_key as _fetch_api_key


class AnthropicError(Exception):
    """A failed Anthropic call. `upstream_status` is the HTTP status, or None for a
    network/transport failure. The API key is never included in the message."""

    def __init__(self, upstream_status, message=""):
        super().__init__(message)
        self.upstream_status = upstream_status


def get_api_key() -> str:
    """The Anthropic API key (fetched + cached in shared/api_key.py, keyed by path)."""
    return _fetch_api_key(ANTHROPIC_API_KEY_PATH)


def post(system: str, user_prefix: str, model_input: dict) -> str:
    """POST one system + user turn to the Messages API and return the first text block.

    The user turn is `user_prefix` followed by the compact-JSON model_input. Returns
    the first text block's text, or "" when the envelope carries none (so a malformed
    reply degrades through the caller's parser instead of raising).

    Raises AnthropicError on any non-2xx (carrying the upstream status) or transport
    failure (status None).
    """
    body = {
        "model": ANTHROPIC_MODEL,
        "max_tokens": ANTHROPIC_MAX_TOKENS,
        # Disable Sonnet's default "thinking" so it can't eat the token budget and
        # truncate the JSON reply — a single-shot answer, no reasoning needed.
        "thinking": ANTHROPIC_THINKING,
        "system": system,
        "messages": [
            {
                "role": "user",
                "content": user_prefix + json.dumps(model_input, separators=(",", ":")),
            }
        ],
    }
    try:
        # get_api_key() reads SSM; a missing/denied param raises ValueError. Keep it
        # inside the try so that too becomes an AnthropicError (-> 502), never an
        # uncaught 500.
        req = urllib.request.Request(
            f"{ANTHROPIC_BASE_URL}{ANTHROPIC_MESSAGES_PATH}",
            data=json.dumps(body).encode(),
            headers={
                "x-api-key": get_api_key(),
                "anthropic-version": ANTHROPIC_VERSION,
                "content-type": "application/json",
                "User-Agent": ANTHROPIC_USER_AGENT,
            },
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=ANTHROPIC_TIMEOUT_SECONDS) as resp:
            payload = json.loads(resp.read())
    except urllib.error.HTTPError as e:
        raise AnthropicError(e.code, f"Anthropic messages -> {e.code}") from e
    except urllib.error.URLError as e:
        raise AnthropicError(None, "Anthropic unreachable") from e
    except (ValueError, TypeError) as e:
        raise AnthropicError(None, "Anthropic key unavailable or non-JSON envelope") from e

    # Messages API: {"content": [{"type": "text", "text": "..."}], ...}. Pull the
    # first text block; anything unexpected degrades via the caller's parser.
    content = payload.get("content") or []
    for block in content:
        if isinstance(block, dict) and block.get("type") == "text":
            return block.get("text", "")
    return ""


def extract_first_json(text: str) -> dict | None:
    """Extract the first {...} span from the model's reply and json.loads it.

    The model is asked for strict JSON but may wrap it in prose. Returns the parsed
    object, or None on no match / invalid JSON — callers coerce None to their own
    empty result so a chatty reply never 500s the endpoint. A matched {...} span is
    always a JSON object, so the result is a dict whenever it isn't None.
    """
    match = re.search(r"\{.*\}", text or "", re.DOTALL)
    if not match:
        return None
    try:
        return json.loads(match.group(0))
    except (ValueError, TypeError):
        return None
