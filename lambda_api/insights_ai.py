"""AI spending-insights client (WHIT-104).

Calls the Anthropic Messages API server-side to turn the user's real spend
figures into a few plain-language observations + suggestions. The API key lives
only in SSM; the app never holds it.

The HTTP call, SSM-cached key, typed AnthropicError, and first-{...}-span JSON
extraction live in the shared anthropic_client (WHIT-388); this module supplies only
the system prompt and the reply-shaping parser. The model is asked to reply as strict
JSON, and we parse defensively (fall back to a graceful empty result) so a chatty
model can never 500 the endpoint.

Scope: the model is given category spend, budgets and the pay cycle, and — when the
request carries one (WHIT-134) — an optional home-loan "goal" block (projected
mortgage-free month + the exact months-sooner-per-$100 sensitivity) so advice can
tie cuts to the payoff date. NO transaction descriptions/merchants/account ids.
"""

from anthropic_client import extract_first_json, post

_SYSTEM_PROMPT = (
    "You are a concise personal-budgeting assistant inside a budgeting app. "
    "You are given the user's REAL spending figures for the current pay cycle "
    "(and a prior cycle for trend), plus their budget targets. "
    "Use ONLY the numbers provided — never invent, estimate, or infer any figure "
    "that isn't in the data, and never round beyond cents. "
    "Give a one-sentence summary of how the cycle is going, then 2-4 short, "
    "specific, actionable suggestions about where to cut back, grounded in the "
    "actual category totals (name the category and the dollar figure). "
    "A \"budgeted_parents\" block, when present, lists parent categories whose budget "
    "covers several of the individual category rows: each entry's posted/pending is the "
    "TOTAL already summed across its child categories, so judge that parent group against "
    "its \"budget\", but do NOT add it on top of the individual category rows (that would "
    "double-count) — use the individual rows to name the specific child to cut. These "
    "entries may themselves nest (one parent's total can already include another's), so "
    "never sum two \"budgeted_parents\" rows together either. "
    "Be encouraging, not preachy. This is guidance, not financial advice. "
    "If a \"goal\" block is present, the user is paying down a home loan; for ONE or "
    "TWO suggestions, connect a specific category cut to the loan — the dollars it "
    "frees each month could go onto the mortgage. The goal block has one of two "
    "shapes, and you must use ONLY the fields it actually contains: "
    "(a) if goal.payoff_mode is 'partial', 'flat', or 'ahead', the loan IS on track to "
    "be paid off — reference goal.mortgage_free_date as the current projected "
    "mortgage-free month, and only if goal.months_sooner_per_100_extra is given may you "
    "say the payoff moves in by roughly that many months for each extra $100 per month "
    "(NEVER scale it up for larger amounts or invent a different month count); "
    "(b) if goal.payoff_mode is 'shortfall', the loan will NOT be paid off at the "
    "current repayment, but the user wants to be mortgage-free by goal.goal_date — "
    "reaching that needs about goal.required_repayment per month, roughly "
    "goal.required_extra more than they pay now. Tie the category cuts to closing that "
    "monthly gap of goal.required_extra, and do NOT mention a projected mortgage-free "
    "date in this case (there is none). "
    "Never mention a goal field that isn't present, and never invent a different amount "
    "or date. If there is no \"goal\" block, do not mention the loan at all. "
    "Reply with STRICT JSON only, no prose outside it, in exactly this shape: "
    '{"summary": "<one sentence>", "suggestions": ["<tip>", "<tip>"]}'
)


def _parse_reply(text: str) -> dict:
    """Turn the model's reply text into {"summary": str, "suggestions": [str]}.

    Defensive: the model is asked for strict JSON, but may still wrap it in prose.
    extract_first_json pulls the first {...} object; we then coerce the fields to the
    expected shape. Any failure -> a graceful empty result (never raises), so a
    chatty/malformed reply degrades instead of 500ing the endpoint.
    """
    parsed = extract_first_json(text)
    if parsed is None:
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
    with the system prompt's "use ONLY these numbers" instruction.
    """
    text = post(_SYSTEM_PROMPT, "Here are my figures. Analyse them:\n", model_input)
    return _parse_reply(text)
