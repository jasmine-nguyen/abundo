"""Ask Abundo chat worker (card 609).

POST /ai/chat creates a job row and async-invokes this function (the WHIT-537 job pattern: the
API Gateway window is 30s and can't stream). The worker reads the user's data once, runs the
model's tool loop — writing a one-line status to the job row before each lookup — and stores the
validated `respond` payload on the row. The app polls GET /ai/chat/jobs/{id}.

The server computes every figure (chat_tools); the model picks lookups and writes the sentence.
validate_reply drops any card number that no tool returned during this turn.

Logs carry the job id, round count, tool names and status only — never message text — unless
AI_CHAT_DEBUG_LOG=1 is set by hand on a dev worker to check what reaches the model.
"""

import json
import logging
import os
from decimal import ROUND_HALF_UP, Decimal, InvalidOperation

from anthropic_client import AnthropicError, post_messages
from api_constants import (
    ANTHROPIC_CHAT_MAX_TOKENS,
    ANTHROPIC_CHAT_TIMEOUT_SECONDS,
    CHAT_DEADLINE_MARGIN_SECONDS,
    CHAT_LIST_MAX,
    CHAT_MAX_LOOKBACK_CYCLES,
    CHAT_MAX_LOOKBACK_MONTHS,
    CHAT_MAX_TOOL_ROUNDS,
    CHAT_MESSAGE_MAX_LEN,
    CHAT_MIN_CALL_SECONDS,
    UNCATEGORIZED_KEY,
)
from budget_standing import budget_standing, standing_window
from chat_tools import TOOL_FUNCTIONS, ChatData, lookback_floor, tool_status_line
from encoders import DecimalEncoder
from iso_date import valid_iso_date
from repository import (
    BudgetRepository,
    CategoryRepository,
    DatabaseError,
    JobRepository,
    PayCycleRepository,
    TransactionRepository,
)
from repository_job import STATUS_FAILED, STATUS_SUCCEEDED
from repository_transaction import read_window
from spend import transactions_in_window

logger = logging.getLogger(__name__)
logger.setLevel(logging.INFO)

_DEBUG_LOG_ENV = "AI_CHAT_DEBUG_LOG"
_REPLY_TEXT_MAX = 1200
_SOURCE_MAX = 200
_LABEL_MAX = 60
_SERIES_MAX = CHAT_MAX_LOOKBACK_CYCLES + 1
_MAX_ACTIONS = 2
_CENT = Decimal("0.01")

# The API needs the first message to come from the user. A thread opened from the insights card
# starts with the card's summary as an assistant turn, so this goes in front of it.
_SEED_INTRO = "Here's the spending summary the app showed me."

_SYSTEM_PROMPT = """You are Abundo's spending assistant. Answer questions about the user's own \
transactions, budgets, categories and pay cycles. Today is {today} in Melbourne. Amounts are in \
Australian dollars.

- Always get figures from the tools; never calculate totals or averages yourself when a tool can. \
Every number in the card must be copied exactly from a tool result.
- Pay cycles are the primary time unit: say "per cycle" and use filters.pay_cycles. If the user \
says months, use calendar months (filters.months) instead.
- "Last N cycles" or "last N months" means completed periods. Only include the current, \
unfinished period if the user asks for it.
- Keep answers to 1-3 sentences and bold the key figure with **double asterisks**.
- Always fill `source` with the exact period used, e.g. "3 completed pay cycles · 12 Jun – 11 Sep".
- Include a metric_bars card when the answer is a figure over time: one series point per period \
with a short label such as "Jun" or "12 Jun".
- Offer at most 2 actions. A deeplink opens one category's transactions over the exact dates \
you used.
- For a fuzzy grouping with no category (e.g. "date nights"), list the transactions and group \
them yourself; say it's an estimate and name the merchants you counted.
- You can look back {cycles} pay cycles or {months} months at most. If the data can't answer \
the question, say so plainly and suggest a question it can answer.
- Don't give investment, tax or credit advice. Don't mention tools or internal ids.
- Always finish by calling `respond`."""

_PERIOD_SPEC = {
    "type": "object",
    "properties": {
        "last_n": {"type": "integer", "minimum": 1, "maximum": 12},
        "include_current": {"type": "boolean"},
    },
    "required": ["last_n"],
}

TOOLS = [
    {
        "name": "query_transactions",
        "description": (
            "Filter the user's transactions and compute one metric on the server. Amounts are "
            "positive. Refunds reduce spend. A category includes its subcategories. avg over "
            "pay_cycles or months returns one row per period (zero periods included) plus the "
            "average."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "filters": {
                    "type": "object",
                    "description": (
                        "Use at most one of date_from/date_to, pay_cycles or months. With none, "
                        "the period is the current pay cycle."
                    ),
                    "properties": {
                        "category_ids": {
                            "type": "array", "items": {"type": "string"},
                            "description": f'Ids from get_categories; "{UNCATEGORIZED_KEY}" for uncategorized.',
                        },
                        "merchant_contains": {"type": "string", "description": "Case-insensitive."},
                        "description_contains": {"type": "string", "description": "Case-insensitive."},
                        "date_from": {"type": "string", "description": "YYYY-MM-DD"},
                        "date_to": {"type": "string", "description": "YYYY-MM-DD"},
                        "pay_cycles": {
                            **_PERIOD_SPEC,
                            "description": "The last N completed pay cycles, plus the current one if include_current.",
                        },
                        "months": {
                            **_PERIOD_SPEC,
                            "description": "The last N completed calendar months, plus this month if include_current.",
                        },
                        "min_amount": {"type": "number"},
                        "max_amount": {"type": "number"},
                        "direction": {"type": "string", "enum": ["spend", "income"]},
                    },
                },
                "group_by": {
                    "type": "string",
                    "enum": ["none", "category", "merchant", "month", "pay_cycle"],
                    "description": "month needs filters.months; pay_cycle needs filters.pay_cycles.",
                },
                "metric": {"type": "string", "enum": ["sum", "avg", "count", "min", "max", "list"]},
                "limit": {"type": "integer", "minimum": 1, "maximum": CHAT_LIST_MAX,
                          "description": "Rows for metric list (default 20)."},
            },
            "required": ["metric"],
        },
    },
    {
        "name": "get_budgets",
        "description": "Each budget's limit, spend and what's left, for the current or a past pay cycle.",
        "input_schema": {
            "type": "object",
            "properties": {
                "pay_cycle": {
                    "description": '"current", or {"offset": n} for n completed cycles back.',
                    "anyOf": [
                        {"type": "string", "enum": ["current"]},
                        {"type": "object", "properties": {"offset": {"type": "integer", "minimum": 1}},
                         "required": ["offset"]},
                    ],
                },
            },
        },
    },
    {
        "name": "get_pay_cycles",
        "description": "The last N completed pay cycles plus the current one, with start and end dates.",
        "input_schema": {
            "type": "object",
            "properties": {"last_n": {"type": "integer", "minimum": 1, "maximum": 12}},
        },
    },
    {
        "name": "get_categories",
        "description": "The user's categories: id, name, bucket, parent and colour.",
        "input_schema": {"type": "object", "properties": {}},
    },
    {
        "name": "respond",
        "description": "Give the final answer to the user.",
        "input_schema": {
            "type": "object",
            "properties": {
                "text": {"type": "string"},
                "card": {
                    "type": "object",
                    "properties": {
                        "type": {"type": "string", "enum": ["metric_bars"]},
                        "label": {"type": "string", "description": 'e.g. "Eating Out · 3-cycle average"'},
                        "value": {"type": "number"},
                        "delta": {
                            "type": "object",
                            "properties": {
                                "amount": {"type": "number",
                                           "description": "value minus the comparison. Positive = more than it."},
                                "vs": {"type": "string", "enum": ["budget", "previous"],
                                       "description": '"budget" compares value with budget_line, so set budget_line.'},
                            },
                            "required": ["amount", "vs"],
                        },
                        "category_id": {"type": "string"},
                        "budget_line": {"type": "number"},
                        "series": {
                            "type": "array",
                            "items": {
                                "type": "object",
                                "properties": {"label": {"type": "string"}, "value": {"type": "number"}},
                                "required": ["label", "value"],
                            },
                        },
                    },
                    "required": ["type", "label", "value", "series"],
                },
                "source": {"type": "string"},
                "actions": {
                    "type": "array",
                    "maxItems": _MAX_ACTIONS,
                    "items": {
                        "type": "object",
                        "properties": {
                            "kind": {"type": "string", "enum": ["deeplink", "prompt"]},
                            "label": {"type": "string"},
                            "category_id": {"type": "string", "description": "deeplink only"},
                            "date_from": {"type": "string", "description": "deeplink only, YYYY-MM-DD"},
                            "date_to": {"type": "string", "description": "deeplink only, YYYY-MM-DD"},
                            "text": {"type": "string", "description": "prompt only: the question to send"},
                        },
                        "required": ["kind", "label"],
                    },
                },
            },
            "required": ["text"],
        },
    },
]


class ChatError(Exception):
    """The model never produced a usable answer."""


def system_prompt(today: str) -> str:
    return _SYSTEM_PROMPT.format(today=today, cycles=CHAT_MAX_LOOKBACK_CYCLES,
                                 months=CHAT_MAX_LOOKBACK_MONTHS)


def to_model_messages(messages: list[dict]) -> list[dict]:
    """The app's [{role, text}] history as Messages API turns: consecutive same-role turns are
    merged, and an assistant-first history (the insights-card seed) gets a user turn in front."""
    model_messages: list[dict] = []
    if messages[0]["role"] == "assistant":
        model_messages.append({"role": "user", "content": _SEED_INTRO})
    for message in messages:
        if model_messages and model_messages[-1]["role"] == message["role"]:
            model_messages[-1]["content"] += "\n\n" + message["text"]
        else:
            model_messages.append({"role": message["role"], "content": message["text"]})
    return model_messages


def _cents(value) -> Decimal:
    return Decimal(str(value)).quantize(_CENT, rounding=ROUND_HALF_UP)


def _collect_numbers(value, found: set) -> None:
    """Every number in a tool result, to the cent, so a card can be checked against them."""
    if isinstance(value, bool) or value is None:
        return
    if isinstance(value, (int, float, Decimal)):
        found.add(_cents(value))
    elif isinstance(value, dict):
        for item in value.values():
            _collect_numbers(item, found)
    elif isinstance(value, list):
        for item in value:
            _collect_numbers(item, found)


def _known_category(category_id, data: ChatData) -> bool:
    return category_id == UNCATEGORIZED_KEY or category_id in data.names


def _validate_delta(delta, value: Decimal, budget_line, tool_numbers: set):
    """A delta is kept only if it's exactly the card value minus the budget line (vs budget) or
    minus a tool number (vs previous). Signed, because the app colours it by sign: positive
    reads "over", so an under-budget gap sent as positive would show a red "+$28.89 vs budget"."""
    if not delta or delta.get("vs") not in ("budget", "previous"):
        return None
    amount = _cents(delta["amount"])
    if delta["vs"] == "budget":
        compared = [] if budget_line is None else [budget_line]
    else:
        compared = tool_numbers
    # Zero says nothing, and "vs previous" would always pass it (value is itself a tool number).
    if amount == 0 or not any(value - other == amount for other in compared):
        return None
    return {"amount": float(amount), "vs": delta["vs"]}


def _validate_card(card, data: ChatData, tool_numbers: set):
    """The card, or None when any figure on it wasn't returned by a tool this turn."""
    if not card:
        return None
    value = _cents(card["value"])
    series = [(str(point["label"])[:_LABEL_MAX], _cents(point["value"]))
              for point in (card.get("series") or [])[:_SERIES_MAX]]
    budget_line = None if card.get("budget_line") is None else _cents(card["budget_line"])
    figures = [value, *(point_value for _label, point_value in series)]
    if budget_line is not None:
        figures.append(budget_line)
    if any(figure not in tool_numbers for figure in figures):
        logger.info("chat card dropped: a figure didn't come from a tool")
        return None
    out = {
        "type": "metric_bars",
        "label": str(card.get("label") or "")[:_LABEL_MAX],
        "value": float(value),
        "series": [{"label": label, "value": float(point_value)} for label, point_value in series],
    }
    if _known_category(card.get("category_id"), data):
        out["categoryId"] = card["category_id"]
    if budget_line is not None:
        out["budgetLine"] = float(budget_line)
    delta = _validate_delta(card.get("delta"), value, budget_line, tool_numbers)
    if delta is not None:
        out["delta"] = delta
    return out


def _validate_action(action, data: ChatData):
    label = str(action.get("label") or "").strip()[:_LABEL_MAX]
    if not label:
        return None
    if action.get("kind") == "prompt":
        text = str(action.get("text") or "").strip()
        if not text or len(text) > CHAT_MESSAGE_MAX_LEN:
            return None
        return {"kind": "prompt", "label": label, "text": text}
    if action.get("kind") != "deeplink":
        return None
    category_id = action.get("category_id")
    date_from, date_to = action.get("date_from"), action.get("date_to")
    if not _known_category(category_id, data):
        return None
    if not (valid_iso_date(date_from) and valid_iso_date(date_to)):
        return None
    if not data.floor <= date_from <= date_to <= data.today:
        return None
    return {"kind": "deeplink", "label": label, "categoryId": category_id,
            "dateFrom": date_from, "dateTo": date_to}


def validate_reply(reply: dict, data: ChatData, tool_numbers: set) -> dict:
    """The `respond` input, checked and converted to the app's camelCase shape.

    The text is required. A card survives only if every figure on it matches a tool result to
    the cent. An action survives only with a known category and dates inside the lookback."""
    text = str(reply.get("text") or "").strip()
    if not text:
        raise ChatError("empty answer")
    out: dict = {"text": text[:_REPLY_TEXT_MAX]}
    source = str(reply.get("source") or "").strip()
    if source:
        out["source"] = source[:_SOURCE_MAX]
    try:
        card = _validate_card(reply.get("card"), data, tool_numbers)
    except (KeyError, TypeError, ValueError, InvalidOperation):
        logger.info("chat card dropped: malformed")
        card = None
    if card is not None:
        out["card"] = card
    actions = []
    for action in reply.get("actions") or []:
        if isinstance(action, dict):
            checked = _validate_action(action, data)
            if checked is not None:
                actions.append(checked)
    if actions:
        out["actions"] = actions[:_MAX_ACTIONS]
    return out


def _run_tool(call: dict, data: ChatData, tool_numbers: set) -> dict:
    """One tool_result block. A bad argument or tool failure is returned as is_error so the model
    can correct itself on the next round."""
    try:
        output = TOOL_FUNCTIONS[call["name"]](data, call.get("input") or {})
    except Exception as e:
        return {"type": "tool_result", "tool_use_id": call["id"], "content": f"Error: {e}",
                "is_error": True}
    _collect_numbers(output, tool_numbers)
    return {"type": "tool_result", "tool_use_id": call["id"],
            "content": json.dumps(output, cls=DecimalEncoder)}


def run_chat(job_id: str, messages: list[dict], data: ChatData, job_repo, seconds_left) -> dict:
    """The tool loop. Rounds 1..N-1 must call some tool; the last round must call `respond`, so a
    runaway loop ends with an answer (or a failure) rather than hanging.

    `seconds_left()` reads the worker's remaining time. Each model call gets that minus a margin
    (capped per call); with too little left the run fails before paying for another call."""
    system = system_prompt(data.today)
    model_messages = to_model_messages(messages)
    tool_numbers: set = set()
    for round_number in range(1, CHAT_MAX_TOOL_ROUNDS + 1):
        if round_number == CHAT_MAX_TOOL_ROUNDS:
            tool_choice = {"type": "tool", "name": "respond"}
        else:
            tool_choice = {"type": "any"}
        budget = seconds_left() - CHAT_DEADLINE_MARGIN_SECONDS
        if budget < CHAT_MIN_CALL_SECONDS:
            raise ChatError(f"out of time before round {round_number}")
        if os.environ.get(_DEBUG_LOG_ENV) == "1":
            logger.info("chat debug request: %s", json.dumps({"system": system, "messages": model_messages}))
        reply = post_messages(system, model_messages, TOOLS, tool_choice,
                              ANTHROPIC_CHAT_MAX_TOKENS, min(ANTHROPIC_CHAT_TIMEOUT_SECONDS, budget))
        calls = [block for block in reply.get("content") or [] if block.get("type") == "tool_use"]
        logger.info("chat job %s round %d tools %s", job_id, round_number,
                    [call["name"] for call in calls])
        answer = next((call for call in calls if call["name"] == "respond"), None)
        if answer is not None:
            return validate_reply(answer.get("input") or {}, data, tool_numbers)
        if not calls:
            raise ChatError(f"no tool call (stop_reason {reply.get('stop_reason')})")

        model_messages.append({"role": "assistant", "content": reply["content"]})
        results = []
        for call in calls:
            try:
                status = tool_status_line(call["name"], call.get("input") or {}, data.names)
            except (TypeError, ValueError, AttributeError):
                status = "Working on it…"
            job_repo.set_tool_status(job_id, status)
            results.append(_run_tool(call, data, tool_numbers))
        model_messages.append({"role": "user", "content": results})
    raise ChatError("no answer within the round limit")


def load_chat_data(transaction_repo, category_repo, budget_repo, paycycle_repo) -> ChatData:
    """Read everything the tools need once: categories, the pay cycle, and every transaction
    back to the lookback floor. The budget rows are worked out from that same read (the
    /budgets maths, budget_standing.py) — read-only: only GET /budgets saves settlements."""
    targets = budget_repo.list_budgets()
    window = standing_window(targets, paycycle_repo.get_paycycle())
    cycle_start, length, today = window.cycle_start, window.length, window.today
    floor = lookback_floor(cycle_start, length, today)
    categories = category_repo.list_categories()
    transactions = read_window(transaction_repo, min(floor, window.fetch_start), today)
    budgets, _ = budget_standing(
        targets, window, categories, transactions_in_window(transactions, window.fetch_start, today)
    )
    return ChatData(
        categories=categories,
        budgets=budgets,
        cycle_start=cycle_start,
        length=length,
        today=today,
        floor=floor,
        transactions=transactions_in_window(transactions, floor, today),
    )


def lambda_handler(event: dict, context=None) -> dict:
    """Answer one chat message. Event: {"jobId", "messages": [{"role", "text"}, ...]} — already
    validated and trimmed by the POST. Every failure marks the job failed so a poll never hangs."""
    job_id = event["jobId"]
    job_repo = JobRepository()
    try:
        data = load_chat_data(TransactionRepository(), CategoryRepository(), BudgetRepository(),
                              PayCycleRepository())
        reply = run_chat(job_id, event["messages"], data, job_repo,
                         lambda: context.get_remaining_time_in_millis() / 1000)
        job_repo.finish_chat_job(job_id, STATUS_SUCCEEDED, json.dumps(reply))
        logger.info("chat job %s succeeded", job_id)
        return {"jobId": job_id, "status": STATUS_SUCCEEDED}
    except Exception as e:
        logger.error("chat job %s failed: %s %s", job_id, type(e).__name__, e)
        error = "assistant unavailable" if isinstance(e, AnthropicError) else "could not answer"
        try:
            job_repo.finish_chat_job(job_id, STATUS_FAILED, error=error)
        except DatabaseError:
            logger.error("chat job %s could not be marked failed", job_id)
        return {"jobId": job_id, "status": STATUS_FAILED}
