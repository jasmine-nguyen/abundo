"""AI spending-insights client (WHIT-104).

Calls the Anthropic Messages API server-side to turn the user's real spend
figures into a few plain-language observations + suggestions. The API key lives
only in SSM; the app never holds it.

The HTTP call, SSM-cached key and typed AnthropicError live in the shared
anthropic_client (WHIT-388); this module supplies the system prompt, the reply schema
(sent as structured outputs, so the API enforces the shape) and the parser, which
degrades a truncated or empty reply to a graceful empty result.

Scope: the model is given category spend, budgets and the pay cycle, and — when the
request carries one (WHIT-134) — an optional home-loan "goal" block (projected
mortgage-free month + the exact months-sooner-per-$100 sensitivity) so advice can
tie cuts to the payoff date. NO transaction descriptions/merchants/account ids.
"""

import json

from anthropic_client import post

_SYSTEM_PROMPT = (
    "You are a concise budgeting assistant. You get the user's spending for the current pay "
    "cycle (plus a prior cycle for trend) and their budget targets. "
    "Use only the numbers provided: never invent or estimate a figure, and never round beyond cents. "
    "Give a one-sentence summary of the cycle, then 2-4 short, specific cuts, each naming the "
    "category and its dollar figure. "
    "Each \"budgeted_parents\" entry is a parent budget's total already summed across its child "
    "categories: judge it against its \"budget\", but don't add it on top of the individual "
    "category rows (name the child to cut from those rows). Entries may nest, so never sum two "
    "\"budgeted_parents\" rows together. "
    "Be encouraging, not preachy; this is guidance, not financial advice. "
    "A \"goal\" block means the user is paying down a home loan: for one or two suggestions, say "
    "the dollars a cut frees each month could go onto the mortgage. The block has one of two "
    "shapes; use only the fields it actually contains. "
    "(a) goal.payoff_mode 'partial', 'flat' or 'ahead': the loan is on track, so cite "
    "goal.mortgage_free_date as the projected mortgage-free month; only if "
    "goal.months_sooner_per_100_extra is given, say each extra $100 a month brings it in by about "
    "that many months (never scale it up for larger amounts). "
    "(b) goal.payoff_mode 'shortfall': the loan will not be paid off at the current repayment; "
    "being mortgage-free by goal.goal_date needs about goal.required_repayment a month, "
    "goal.required_extra more than now. Tie cuts to closing that goal.required_extra gap, and "
    "don't mention a projected mortgage-free date. "
    "Never mention a goal field that isn't present, and never invent a different amount or date. "
    "If there is no \"goal\" block, do not mention the loan at all."
)

_REPLY_SCHEMA = {
    "type": "object",
    "properties": {
        "summary": {"type": "string", "description": "One sentence on how the cycle is going."},
        "suggestions": {"type": "array", "items": {"type": "string"}},
    },
    "required": ["summary", "suggestions"],
    "additionalProperties": False,
}


def _parse_reply(text: str) -> dict:
    """Turn the model's reply text into {"summary": str, "suggestions": [str]}.

    Structured outputs make the reply schema-valid JSON; a truncated (max_tokens) or empty
    reply still degrades to a graceful empty result (never raises).
    """
    try:
        parsed = json.loads(text)
    except (ValueError, TypeError):
        return {"summary": None, "suggestions": []}
    summary = parsed.get("summary")
    suggestions = parsed.get("suggestions")
    # Null a blank/whitespace-only summary so it counts as "no advice" — mirrors the
    # suggestions strip below. Without this a "   " summary is truthy and slips past
    # the empty-result soft-fail guard, caching a blank insight card (WHIT-138).
    if not isinstance(summary, str) or not summary.strip():
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
    with the system prompt's "use only these numbers" instruction.
    """
    text = post(_SYSTEM_PROMPT, "Here are my figures. Analyse them:\n", model_input, _REPLY_SCHEMA)
    return _parse_reply(text)
