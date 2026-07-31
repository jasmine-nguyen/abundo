"""AI milestone-pacing client (WHIT-370).

Companion to insights_ai.py: the same server-side Anthropic call (urllib + SSM-cached key +
Cloudflare-friendly User-Agent + typed AnthropicError), but for the "Suggest a plan" feature.

Honesty boundary: the model is given ONLY a set of real, server-computed paydown points, each
with an integer index, plus the user's target payoff date and the real projected payoff date. It
chooses WHICH indexes to surface (the pacing) and writes a short WORD-ONLY label for each — it
returns [{index, label}] and never a number. OUR code maps each index back to the real
{targetBalance, targetDate}, so a hallucinated figure is structurally impossible; the handler
additionally scrubs digits out of each label, because the prompt is not the guarantee — the
server check is. Numbers only in, no PII (no account ids, no transactions) — matches insights_ai.

Reuses AnthropicError + get_api_key from insights_ai rather than re-deriving the key/error
plumbing; extracting a shared anthropic_client is deferred (WHIT-370 tech-debt) until a third
AI feature (WHIT-380) justifies touching the shipping insights path.
"""

import json
import re
import urllib.error
import urllib.request

from constants import (
    ANTHROPIC_BASE_URL,
    ANTHROPIC_MAX_TOKENS,
    ANTHROPIC_MESSAGES_PATH,
    ANTHROPIC_MODEL,
    ANTHROPIC_THINKING,
    ANTHROPIC_TIMEOUT_SECONDS,
    ANTHROPIC_USER_AGENT,
    ANTHROPIC_VERSION,
)
from insights_ai import AnthropicError, get_api_key

_SYSTEM_PROMPT = (
    "You help a mortgage-payoff app turn a real paydown schedule into a short, friendly "
    "milestone plan. You are given a list of CANDIDATE points, each with an integer "
    "\"index\" plus the real balance and date at that point, and the user's target payoff "
    "date and the actual projected payoff date. "
    "Choose 4 to 5 of the provided indexes to become milestones, spread across the journey so "
    "the user feels steady progress. You MAY shape the pacing — evenly spaced, front-loaded "
    "(more early wins), or back-loaded — but you may ONLY choose indexes from the list; never "
    "invent a point, a balance, or a date. "
    "For each chosen index write a short, warm \"label\" of at most a few words. Labels are "
    "WORDS ONLY: never put a number, a dollar amount, a percentage, or a date in a label — the "
    "app shows the real figures next to your label. Good labels: \"Great start\", \"Halfway "
    "there\", \"Almost home\", \"Mortgage-free\". Bad labels: \"$300k to go\", \"50% paid\", "
    "\"by 2032\". "
    "Reply with STRICT JSON only, no prose outside it, in exactly this shape: "
    '{"milestones": [{"index": <int>, "label": "<words>"}, ...]}'
)


def _parse_pacing(text: str) -> list:
    """Turn the model's reply into a list of {"index": int, "label": str}.

    Defensive: the model is asked for strict JSON but may wrap it in prose. Extract the first
    {...} span and json.loads it, then keep only well-formed entries (int index, str label). Any
    failure -> [] (never raises), so a chatty/malformed reply degrades to a soft failure instead
    of 500ing the endpoint — same contract as insights_ai._parse_reply.
    """
    match = re.search(r"\{.*\}", text or "", re.DOTALL)
    if not match:
        return []
    try:
        parsed = json.loads(match.group(0))
    except (ValueError, TypeError):
        return []
    milestones = parsed.get("milestones")
    if not isinstance(milestones, list):
        return []
    pacing = []
    for entry in milestones:
        if not isinstance(entry, dict):
            continue
        index = entry.get("index")
        label = entry.get("label")
        # bool is an int subclass — exclude it; label must be a real string.
        if isinstance(index, bool) or not isinstance(index, int) or not isinstance(label, str):
            continue
        pacing.append({"index": index, "label": label})
    return pacing


def _call_anthropic(system_prompt: str, user_prefix: str, model_input: dict, parse) -> list:
    """POST the numbers-only model_input to the Messages API and return parse(reply_text).

    The one place the urllib call, headers, timeout, and error taxonomy live — suggest_pacing
    and review_pacing differ only in their system prompt, user prefix, and reply parser.

    Raises AnthropicError on any non-2xx (carrying the upstream status) or transport failure
    (status None) — mirrors insights_ai.generate_suggestions.
    """
    body = {
        "model": ANTHROPIC_MODEL,
        "max_tokens": ANTHROPIC_MAX_TOKENS,
        # Disable Sonnet's default "thinking" so it can't eat the token budget and truncate the
        # JSON reply — a single-shot choice, no reasoning needed (mirrors insights_ai).
        "thinking": ANTHROPIC_THINKING,
        "system": system_prompt,
        "messages": [
            {"role": "user", "content": user_prefix + json.dumps(model_input, separators=(",", ":"))}
        ],
    }
    try:
        # get_api_key() reads SSM; a missing/denied param raises ValueError. Keep it inside the
        # try so that too becomes an AnthropicError (-> 502), never an uncaught 500.
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

    # Messages API: {"content": [{"type": "text", "text": "..."}], ...}. Pull the first text
    # block; anything unexpected degrades via the parser.
    content = payload.get("content") or []
    text = ""
    for block in content:
        if isinstance(block, dict) and block.get("type") == "text":
            text = block.get("text", "")
            break
    return parse(text)


def suggest_pacing(model_input: dict) -> list:
    """Call Anthropic with the candidate points + target/payoff dates and return the chosen
    [{index, label}, ...] (possibly empty). The numbers are passed as a JSON blob in the user
    turn, with the system prompt's "only choose provided indexes" instruction."""
    return _call_anthropic(
        _SYSTEM_PROMPT, "Here is the real paydown schedule. Choose the milestones:\n",
        model_input, _parse_pacing)


_REVIEW_SYSTEM_PROMPT = (
    "You help a mortgage-payoff app review a user's saved milestone plan against their real "
    "current pace. You are given a list of the user's milestones that are running BEHIND, each "
    "with an integer \"index\", its target, the real projected date it's actually reached at the "
    "current pace, and how many months behind it is (\"varianceMonths\"). "
    "Choose which of these indexes are worth flagging to the user (the most useful few, not "
    "necessarily all) and write a short, warm one-line \"reason\" for each — why it's worth "
    "nudging the milestone's date out. You may ONLY choose indexes from the list; never invent a "
    "milestone, a balance, or a date. "
    "Reasons are WORDS ONLY: never put a number, a dollar amount, a percentage, or a date in a "
    "reason — the app shows the real figures next to your words. Good reasons: \"running a little "
    "behind your plan\", \"drifting later than you hoped\". Bad reasons: \"3 months late\", "
    "\"$20k short\", \"behind since 2032\". "
    "Reply with STRICT JSON only, no prose outside it, in exactly this shape: "
    '{"adjustments": [{"index": <int>, "reason": "<words>"}, ...]}'
)


def _parse_review(text: str) -> list:
    """Turn the model's reply into a list of {"index": int, "reason": str}.

    Defensive twin of _parse_pacing: extract the first {...} span, json.loads it, keep only
    well-formed entries (int index — bool excluded — and a str reason). Any failure -> [] (never
    raises), so a chatty/malformed reply degrades to a soft failure instead of 500ing.
    """
    match = re.search(r"\{.*\}", text or "", re.DOTALL)
    if not match:
        return []
    try:
        parsed = json.loads(match.group(0))
    except (ValueError, TypeError):
        return []
    adjustments = parsed.get("adjustments")
    if not isinstance(adjustments, list):
        return []
    reviewed = []
    for entry in adjustments:
        if not isinstance(entry, dict):
            continue
        index = entry.get("index")
        reason = entry.get("reason")
        # bool is an int subclass — exclude it; reason must be a real string.
        if isinstance(index, bool) or not isinstance(index, int) or not isinstance(reason, str):
            continue
        reviewed.append({"index": index, "reason": reason})
    return reviewed


def review_pacing(model_input: dict) -> list:
    """Call Anthropic with the behind-schedule milestones and return the chosen
    [{index, reason}, ...] (possibly empty). Numbers only, no PII — matches suggest_pacing."""
    return _call_anthropic(
        _REVIEW_SYSTEM_PROMPT, "Here is the user's plan vs their real pace. Choose which to flag:\n",
        model_input, _parse_review)
