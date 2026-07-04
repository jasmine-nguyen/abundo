"""AI spending-insights client (WHIT-104).

Calls the Anthropic Messages API server-side to turn the user's real spend
figures into a few plain-language observations + suggestions. The API key lives
only in SSM; the app never holds it.

Mirrors the BankSync client (banksync_enrichments.py): urllib + an SSM-cached key
+ a custom User-Agent (api.anthropic.com is Cloudflare-fronted, which 403s the
default urllib agent), with a typed error the handler maps to a response. The
model is asked to reply as strict JSON, and we parse defensively (extract the
first {...} span, fall back to a graceful empty result) so a chatty model can
never 500 the endpoint.

Scope: the model is given category spend, budgets and the pay cycle, and — when the
request carries one (WHIT-134) — an optional home-loan "goal" block (projected
mortgage-free month + the exact months-sooner-per-$100 sensitivity) so advice can
tie cuts to the payoff date. NO transaction descriptions/merchants/account ids.
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
    ANTHROPIC_TIMEOUT_SECONDS,
    ANTHROPIC_USER_AGENT,
    ANTHROPIC_VERSION,
)
from ssm import get_param

_api_key = None

_SYSTEM_PROMPT = (
    "You are a concise personal-budgeting assistant inside a budgeting app. "
    "You are given the user's REAL spending figures for the current pay cycle "
    "(and a prior cycle for trend), plus their budget targets. "
    "Use ONLY the numbers provided — never invent, estimate, or infer any figure "
    "that isn't in the data, and never round beyond cents. "
    "Give a one-sentence summary of how the cycle is going, then 2-4 short, "
    "specific, actionable suggestions about where to cut back, grounded in the "
    "actual category totals (name the category and the dollar figure). "
    "Be encouraging, not preachy. This is guidance, not financial advice. "
    "If a \"goal\" block is present, the user is paying down a home loan and wants to "
    "be mortgage-free sooner (projected month: goal.mortgage_free_date). For ONE or "
    "TWO suggestions, connect a specific category cut to the loan — the dollars it "
    "frees each month could go onto the mortgage — and reference "
    "goal.mortgage_free_date as the current projection. Only if "
    "goal.months_sooner_per_100_extra is given may you mention a payoff-time effect, "
    "and ONLY as roughly that many months sooner for each extra $100 per month; NEVER "
    "scale it up for larger amounts or invent a different month count. If there is no "
    "\"goal\" block, do not mention the loan at all. "
    "Reply with STRICT JSON only, no prose outside it, in exactly this shape: "
    '{"summary": "<one sentence>", "suggestions": ["<tip>", "<tip>"]}'
)


class AnthropicError(Exception):
    """A failed Anthropic call. `upstream_status` is the HTTP status, or None for a
    network/transport failure. The API key is never included in the message."""

    def __init__(self, upstream_status, message=""):
        super().__init__(message)
        self.upstream_status = upstream_status


def get_api_key() -> str:
    """Fetch + cache the Anthropic API key from SSM for the life of the container."""
    global _api_key
    if _api_key is None:
        _api_key = get_param(ANTHROPIC_API_KEY_PATH)
    return _api_key


def _parse_reply(text: str) -> dict:
    """Turn the model's reply text into {"summary": str, "suggestions": [str]}.

    Defensive: the model is asked for strict JSON, but may still wrap it in prose.
    Extract the first {...} span and json.loads it; coerce the fields to the
    expected shape. Any failure -> a graceful empty result (never raises), so a
    chatty/malformed reply degrades instead of 500ing the endpoint.
    """
    match = re.search(r"\{.*\}", text or "", re.DOTALL)
    if not match:
        return {"summary": None, "suggestions": []}
    try:
        parsed = json.loads(match.group(0))
    except (ValueError, TypeError):
        return {"summary": None, "suggestions": []}
    summary = parsed.get("summary")
    suggestions = parsed.get("suggestions")
    if not isinstance(summary, str):
        summary = None
    if not isinstance(suggestions, list):
        suggestions = []
    suggestions = [s for s in suggestions if isinstance(s, str) and s.strip()]
    return {"summary": summary, "suggestions": suggestions}


def generate_suggestions(model_input: dict) -> dict:
    """Call Anthropic with the assembled spend figures and return
    {"summary": str|None, "suggestions": [str, ...]}.

    Raises AnthropicError on any non-2xx (carrying the upstream status) or transport
    failure (status None). The numbers are passed as a JSON blob in the user turn,
    with the system prompt's "use ONLY these numbers" instruction.
    """
    body = {
        "model": ANTHROPIC_MODEL,
        "max_tokens": ANTHROPIC_MAX_TOKENS,
        "system": _SYSTEM_PROMPT,
        "messages": [
            {
                "role": "user",
                "content": "Here are my figures. Analyse them:\n"
                + json.dumps(model_input, separators=(",", ":")),
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
    # first text block; anything unexpected degrades via _parse_reply.
    content = payload.get("content") or []
    text = ""
    for block in content:
        if isinstance(block, dict) and block.get("type") == "text":
            text = block.get("text", "")
            break
    return _parse_reply(text)
