"""Ask Abundo's data tools (card 609): the server does every sum, the model only picks which
lookups to run and writes the words.

Pure logic, no I/O. The chat worker reads the data once into a ChatData and every tool call
filters it in memory. The budget rules come from shared/spend.py (contributes_to_budget, the
same-bucket subtree, sum-then-floor), so a chat figure matches the Budgets and Insights screens.

Privacy: a transaction reaches the model only through safe_row, an allow-list, with long digit
runs (card, account and BSB numbers) blanked out of the merchant and description.
"""

import re
from dataclasses import dataclass, field
from datetime import date, timedelta
from decimal import ROUND_HALF_UP, Decimal

from api_constants import (
    CHAT_LIST_DEFAULT,
    CHAT_LIST_MAX,
    CHAT_MAX_LOOKBACK_CYCLES,
    CHAT_MAX_LOOKBACK_MONTHS,
    INCOME_BUCKET,
    SPEND_BUCKETS,
    UNCATEGORIZED_KEY,
)
from iso_date import valid_iso_date
from repository_category import SEED_CATEGORIES
from rule_engine import is_unfiled_category
from spend import (
    _spend_contribution,
    _summarise,
    build_category_children,
    contributes_to_budget,
    fold_subtree,
    nth_prior_cycle_window,
    subtree_ids,
    transactions_in_window,
)
from transaction_search import _category_label, _merchant_label

_CENT = Decimal("0.01")

# 4+ digits, allowing a single space or dash between them: card and account numbers, and a
# BSB ("063-000" is six digits with a dash).
_DIGIT_RUN = re.compile(r"\d(?:[ -]?\d){3,}")
_REDACTED = "•••"

_GROUP_BYS = ("none", "category", "merchant", "month", "pay_cycle")
_METRICS = ("sum", "avg", "count", "min", "max", "list")
# Which period filter each by-period grouping needs.
_PERIOD_FOR_GROUP = {"pay_cycle": "pay_cycles", "month": "months"}


@dataclass
class ChatData:
    """Everything one chat job's tools read, fetched once. `budgets` is the /budgets output, so
    current-cycle budget figures are the Budgets screen's own. `transactions` covers
    [floor, today]."""

    categories: list[dict]
    budgets: dict
    cycle_start: str
    length: int
    today: str
    floor: str
    transactions: list[dict]
    names: dict = field(init=False)
    bucket_by_id: dict = field(init=False)
    color_slots: dict = field(init=False)
    children: dict = field(init=False)

    def __post_init__(self):
        self.names = {category["id"]: category.get("name") or category["id"]
                      for category in self.categories}
        self.bucket_by_id = {category["id"]: category.get("bucket") for category in self.categories}
        self.color_slots = {category["id"]: category.get("colorSlot") for category in self.categories}
        self.children = build_category_children(self.categories)


def _shift_month(first: date, months: int) -> date:
    index = first.year * 12 + first.month - 1 + months
    return date(index // 12, index % 12 + 1, 1)


def lookback_floor(cycle_start: str, length: int, today: str, grace_periods: int = 0) -> str:
    """The earliest date the chat (and the drill-in date range) may reach: the earlier of the
    start of the 12th completed pay cycle back and the 1st of the month 12 months back. Pay
    cycles alone aren't enough — on a weekly cycle 12 cycles is 84 days, too short for
    "last 3 months". `grace_periods` reaches that many cycles/months further back (the drill-in
    passes CHAT_LINK_GRACE_PERIODS so an answer's link survives the floor moving forward)."""
    cycles_floor, _ = nth_prior_cycle_window(cycle_start, length, CHAT_MAX_LOOKBACK_CYCLES + grace_periods)
    this_month = date.fromisoformat(today).replace(day=1)
    months_floor = _shift_month(this_month, -(CHAT_MAX_LOOKBACK_MONTHS + grace_periods)).isoformat()
    return min(cycles_floor, months_floor)


def cycle_windows(cycle_start: str, length: int, today: str, n: int,
                  include_current: bool) -> list[tuple[str, str]]:
    """The last `n` completed pay cycles, oldest first, plus the current one if asked."""
    windows = [nth_prior_cycle_window(cycle_start, length, k) for k in range(n, 0, -1)]
    if include_current:
        windows.append((cycle_start, today))
    return windows


def month_windows(today: str, n: int, include_current: bool) -> list[tuple[str, str]]:
    """The last `n` completed calendar months, oldest first, plus this month so far if asked."""
    this_month = date.fromisoformat(today).replace(day=1)
    windows = []
    for back in range(n, 0, -1):
        start = _shift_month(this_month, -back)
        end = _shift_month(start, 1) - timedelta(days=1)
        windows.append((start.isoformat(), end.isoformat()))
    if include_current:
        windows.append((this_month.isoformat(), today))
    return windows


def redact(text: str) -> str:
    return _DIGIT_RUN.sub(_REDACTED, text or "")


def _money(value) -> float:
    return float(Decimal(value).quantize(_CENT, rounding=ROUND_HALF_UP))


def _category_key(transaction: dict, data: ChatData) -> str:
    category = transaction.get("category")
    if is_unfiled_category(category, data.names):
        return UNCATEGORIZED_KEY
    return category


def safe_row(transaction: dict, data: ChatData, sign: int = -1) -> dict:
    """The ONLY shape a transaction reaches the model in. An allow-list: account ids/names, the
    raw bank JSON, storage keys, notes and tags are never copied. `sign` makes the amount
    positive for the direction asked about (spend is stored negative)."""
    amount = Decimal(str(transaction.get("amount") or 0))
    return {
        "date": transaction.get("date"),
        "amount": _money(sign * amount),
        "merchant": redact(_merchant_label(transaction)),
        "description": redact(transaction.get("description") or ""),
        "category": _category_label(transaction.get("category"), data.names),
        "category_id": _category_key(transaction, data),
        "status": transaction.get("status"),
    }


def _floored_total(rows: list[dict], sign: int) -> Decimal:
    """Posted and pending summed separately, each floored at 0, then added — the same
    sum-then-floor rule fold_subtree applies to a Budgets bar, so a refund reduces the total."""
    per_key = _summarise(rows, keep=lambda _category: True, key=lambda _category: "all",
                         sign=sign, clamp=False)
    folded = fold_subtree(per_key, {"all"})
    return folded["posted"] + folded["pending"]


def _contribution(transaction: dict, sign: int) -> Decimal:
    return _spend_contribution(transaction, sign=sign)[1]


def _resolve_period(data: ChatData, filters: dict):
    """(windows, period, clamped) for the query's period filter. Exactly one of a date range,
    `pay_cycles` or `months`; none means the current pay cycle. Anything before the lookback
    floor or after today is clamped, and `clamped` says so."""
    date_from, date_to = filters.get("date_from"), filters.get("date_to")
    kinds = [kind for kind in ("pay_cycles", "months") if filters.get(kind)]
    if date_from or date_to:
        kinds.append("range")
    if len(kinds) > 1:
        raise ValueError("use only one of date_from/date_to, pay_cycles or months")

    clamped = False
    if not kinds:
        kind = "current_cycle"
        windows = [(data.cycle_start, data.today)]
    elif kinds[0] == "range":
        kind = "range"
        date_from = date_from or data.floor
        date_to = date_to or data.today
        if not (valid_iso_date(date_from) and valid_iso_date(date_to)):
            raise ValueError("date_from and date_to must be YYYY-MM-DD dates")
        clamped = date_from < data.floor or date_to > data.today
        date_from, date_to = max(date_from, data.floor), min(date_to, data.today)
        if date_from > date_to:
            raise ValueError("date_from is after date_to")
        windows = [(date_from, date_to)]
    else:
        kind = kinds[0]
        spec = filters[kind]
        cap = CHAT_MAX_LOOKBACK_CYCLES if kind == "pay_cycles" else CHAT_MAX_LOOKBACK_MONTHS
        requested = int(spec.get("last_n", 1))
        last_n = min(max(requested, 1), cap)
        clamped = last_n != requested
        include_current = bool(spec.get("include_current", False))
        if kind == "pay_cycles":
            windows = cycle_windows(data.cycle_start, data.length, data.today, last_n, include_current)
        else:
            windows = month_windows(data.today, last_n, include_current)

    period = {"kind": kind, "from": windows[0][0], "to": windows[-1][1]}
    if kind in ("pay_cycles", "months"):
        period[kind] = [{"from": start, "to": end} for start, end in windows]
    return windows, period, clamped


def _row_filter(data: ChatData, filters: dict):
    """The predicate for which rows count. Spend = the /breakdown rule (a spend-bucket category
    or unfiled); income = an Income-bucket category. Both need contributes_to_budget. A category
    id brings in its same-bucket subcategories."""
    direction = filters.get("direction") or "spend"
    if direction not in ("spend", "income"):
        raise ValueError("direction must be spend or income")
    category_ids = filters.get("category_ids") or []
    unknown = [cid for cid in category_ids if cid != UNCATEGORIZED_KEY and cid not in data.names]
    if unknown:
        raise ValueError(f"unknown category ids {unknown}; call get_categories")
    wanted = set()
    for cid in category_ids:
        if cid != UNCATEGORIZED_KEY:
            wanted |= subtree_ids(cid, data.children, data.bucket_by_id)
    want_unfiled = UNCATEGORIZED_KEY in category_ids
    spend_ids = {cid for cid, bucket in data.bucket_by_id.items() if bucket in SPEND_BUCKETS}
    income_ids = {cid for cid, bucket in data.bucket_by_id.items() if bucket == INCOME_BUCKET}
    merchant = (filters.get("merchant_contains") or "").lower()
    description = (filters.get("description_contains") or "").lower()
    min_amount = filters.get("min_amount")
    max_amount = filters.get("max_amount")

    def keep(transaction: dict) -> bool:
        if not contributes_to_budget(transaction):
            return False
        category = transaction.get("category")
        unfiled = is_unfiled_category(category, data.names)
        if direction == "spend" and not (category in spend_ids or unfiled):
            return False
        if direction == "income" and category not in income_ids:
            return False
        if category_ids and not (category in wanted or (want_unfiled and unfiled)):
            return False
        if merchant and merchant not in _merchant_label(transaction).lower():
            return False
        if description and description not in (transaction.get("description") or "").lower():
            return False
        size = abs(Decimal(str(transaction.get("amount") or 0)))
        if min_amount is not None and size < Decimal(str(min_amount)):
            return False
        if max_amount is not None and size > Decimal(str(max_amount)):
            return False
        return True

    return keep, (-1 if direction == "spend" else 1)


def _metric_value(rows: list[dict], metric: str, sign: int, windows: list[tuple[str, str]]):
    """One number for `rows`: sum = the floored total; avg = the floored total of each window,
    averaged over EVERY window (a window with no spend counts as 0); count; min/max of a single
    transaction. Money comes back as a Decimal, count as an int, min/max of nothing as None."""
    if metric == "sum":
        return _floored_total(rows, sign)
    if metric == "avg":
        totals = [_floored_total(transactions_in_window(rows, start, end), sign)
                  for start, end in windows]
        return sum(totals, Decimal(0)) / len(totals)
    if metric == "count":
        return len(rows)
    if not rows:
        return None
    pick = min if metric == "min" else max
    return pick(_contribution(transaction, sign) for transaction in rows)


def _emit(value, metric: str):
    if value is None or metric == "count":
        return value
    return _money(value)


def query_transactions(data: ChatData, args: dict) -> dict:
    """The one general lookup: filter, pick a period, group, and compute a metric.

    avg over pay cycles or months (with no other grouping) is returned per period, so the
    model has the series for a chart as well as the average. Every period in range gets a
    row, zeros included."""
    filters = args.get("filters") or {}
    group_by = args.get("group_by") or "none"
    metric = args.get("metric") or "sum"
    if group_by not in _GROUP_BYS:
        raise ValueError(f"group_by must be one of {list(_GROUP_BYS)}")
    if metric not in _METRICS:
        raise ValueError(f"metric must be one of {list(_METRICS)}")

    windows, period, clamped = _resolve_period(data, filters)
    keep, sign = _row_filter(data, filters)
    rows = [transaction for transaction in
            transactions_in_window(data.transactions, windows[0][0], windows[-1][1])
            if keep(transaction)]
    result: dict = {"period": period}
    if clamped:
        result["clamped"] = True

    if metric == "list":
        if group_by != "none":
            raise ValueError("a list can't be grouped; use group_by none")
        limit = min(max(int(args.get("limit") or CHAT_LIST_DEFAULT), 1), CHAT_LIST_MAX)
        newest_first = sorted(rows, key=lambda transaction: transaction.get("date") or "", reverse=True)
        result["rows"] = [safe_row(transaction, data, sign) for transaction in newest_first[:limit]]
        result["count"] = len(rows)
        result["truncated"] = len(rows) > limit
        return result

    needed_period = _PERIOD_FOR_GROUP.get(group_by)
    if needed_period and period["kind"] != needed_period:
        raise ValueError(f"group_by {group_by} needs filters.{needed_period}")
    by_period = needed_period or (
        metric == "avg" and group_by == "none" and period["kind"] in ("pay_cycles", "months"))

    if by_period:
        per_window_metric = "sum" if metric == "avg" else metric
        values = [_metric_value(transactions_in_window(rows, start, end), per_window_metric, sign,
                                [(start, end)])
                  for start, end in windows]
        result["rows"] = [{"from": start, "to": end, "value": _emit(value, per_window_metric)}
                          for (start, end), value in zip(windows, values)]
        if per_window_metric in ("sum", "count"):
            total = sum(values)
            result["total"] = _emit(total, per_window_metric)
            result["avg"] = _money(Decimal(total) / len(values))
        return result

    if group_by == "none":
        value = _metric_value(rows, metric, sign, windows)
        row = {"value": _emit(value, metric)}
        if metric in ("min", "max") and rows:
            extreme = next(transaction for transaction in rows
                           if _contribution(transaction, sign) == value)
            row["transaction"] = safe_row(extreme, data, sign)
        result["rows"] = [row]
        return result

    groups: dict[str, list[dict]] = {}
    for transaction in rows:
        if group_by == "category":
            key = _category_key(transaction, data)
        else:
            key = redact(_merchant_label(transaction))
        groups.setdefault(key, []).append(transaction)
    grouped = []
    for key, members in groups.items():
        value = _metric_value(members, metric, sign, windows)
        if group_by == "category":
            grouped.append({"category_id": key, "name": data.names.get(key, "Uncategorized"),
                            "value": value})
        else:
            grouped.append({"merchant": key, "value": value})
    grouped.sort(key=lambda group: group["value"], reverse=True)
    for group in grouped:
        group["value"] = _emit(group["value"], metric)
    result["rows"] = grouped
    return result


def _budget_row(data: ChatData, category_id: str, limit, spent, available) -> dict:
    return {
        "category_id": category_id,
        "name": data.names.get(category_id, category_id),
        "limit": _money(limit),
        "spent": _money(spent),
        "remaining": _money(available - spent),
        "color_slot": data.color_slots.get(category_id),
        "earn_target": data.bucket_by_id.get(category_id) == INCOME_BUCKET,
    }


def get_budgets(data: ChatData, args: dict) -> dict:
    """Each budget's target, spend and what's left. The current cycle reads the /budgets rows
    as-is (so it matches the Budgets screen, carryover included). A past cycle ({"offset": n})
    folds that cycle's subtree spend the /budgets way; its limit is today's target, because
    past targets aren't stored."""
    pay_cycle = args.get("pay_cycle") or "current"
    if pay_cycle == "current":
        rows = [_budget_row(data, category_id, row["target"], row["posted"] + row["pending"],
                            row["available"])
                for category_id, row in data.budgets.items()]
        return {"period": {"from": data.cycle_start, "to": data.today}, "budgets": rows}

    offset = int(pay_cycle["offset"])
    if not 1 <= offset <= CHAT_MAX_LOOKBACK_CYCLES:
        raise ValueError(f"offset must be 1..{CHAT_MAX_LOOKBACK_CYCLES}")
    start, end = nth_prior_cycle_window(data.cycle_start, data.length, offset)
    in_window = transactions_in_window(data.transactions, start, end)
    rows = []
    for category_id, row in data.budgets.items():
        ids = subtree_ids(category_id, data.children, data.bucket_by_id)
        sign = 1 if data.bucket_by_id.get(category_id) == INCOME_BUCKET else -1
        spent = _floored_total([t for t in in_window if t.get("category") in ids], sign)
        rows.append(_budget_row(data, category_id, row["target"], spent, row["target"]))
    return {
        "period": {"from": start, "to": end},
        "note": "limit is today's target; past targets aren't kept",
        "budgets": rows,
    }


def get_pay_cycles(data: ChatData, args: dict) -> list[dict]:
    """The last `last_n` completed pay cycles plus the current one, oldest first."""
    last_n = min(max(int(args.get("last_n") or 6), 1), CHAT_MAX_LOOKBACK_CYCLES)
    windows = cycle_windows(data.cycle_start, data.length, data.today, last_n, include_current=True)
    return [{"start": start, "end": end, "is_current": start == data.cycle_start}
            for start, end in windows]


def get_categories(data: ChatData, args: dict) -> list[dict]:
    return [
        {
            "id": category["id"],
            "name": data.names[category["id"]],
            "bucket": category.get("bucket"),
            "parent": category.get("parent"),
            "color_slot": category.get("colorSlot"),
            "is_builtin": category["id"] in SEED_CATEGORIES,
        }
        for category in data.categories
    ]


TOOL_FUNCTIONS = {
    "query_transactions": query_transactions,
    "get_budgets": get_budgets,
    "get_pay_cycles": get_pay_cycles,
    "get_categories": get_categories,
}


def _short_date(iso: str) -> str:
    day = date.fromisoformat(iso)
    return f"{day.day} {day:%b}"


def _period_phrase(filters: dict) -> str:
    for kind, unit in (("pay_cycles", "cycle"), ("months", "month")):
        spec = filters.get(kind)
        if spec:
            last_n = int(spec.get("last_n", 1))
            phrase = f"last {unit}" if last_n == 1 else f"last {last_n} {unit}s"
            if spec.get("include_current"):
                phrase += f" and this {unit}"
            return phrase
    if filters.get("date_from") and filters.get("date_to"):
        return f"{_short_date(filters['date_from'])} – {_short_date(filters['date_to'])}"
    if filters.get("date_from"):
        return f"since {_short_date(filters['date_from'])}"
    return "this cycle"


def tool_status_line(name: str, args: dict, category_names: dict) -> str:
    """The progress line the app shows while a tool runs, built from the call's arguments —
    never written by the model."""
    if name == "query_transactions":
        filters = args.get("filters") or {}
        names = [category_names.get(cid, "Uncategorized") for cid in filters.get("category_ids") or []]
        if names:
            subject = ", ".join(names)
        elif filters.get("merchant_contains"):
            subject = filters["merchant_contains"]
        elif filters.get("direction") == "income":
            subject = "your income"
        else:
            subject = "your spending"
        return f"Looking at {subject}, {_period_phrase(filters)}…"
    if name == "get_budgets":
        return "Checking your budgets…"
    if name == "get_pay_cycles":
        return "Checking your pay cycles…"
    if name == "get_categories":
        return "Looking up your categories…"
    return "Working on it…"
