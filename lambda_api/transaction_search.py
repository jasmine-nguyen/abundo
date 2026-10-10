"""Full-history transaction search for the Transactions tab (WHIT-576).

The app used to filter only the feed pages it had loaded (30 rows each), so a match deeper in
history showed "No matches" while "Load More" was still on screen. The handler now reads ALL
history once and this module decides which rows match.

It is the server twin of the app's transactionMatchesSearch (src/context.tsx): the same text is
searched (merchant label, description, category label, amount, notes and tags), so a row the app would keep is a row the server returns. The shared
truth table tests/fixtures/transaction_search_parity.json and a crosslang drift test hold the two
in step.

Pure logic, no I/O: the handler owns the scan (same split as merchant_groups).
"""

from rule_engine import is_unfiled_category

# Server copy of the app's CLEAN_NAME display-name map (src/context.tsx). Pinned equal by
# tests/lambda_api/test_transaction_search_twin_drift.py.
CLEAN_NAME = {
    "DD *DOORDASH HUTIEUGOO": "DoorDash",
    "UNIFLEX REMEDIAL MASSAGE": "Uniflex Massage",
    "UNIFLEXREMEDIALMASSAGE": "Uniflex Massage",
    "SQ *KKV INTERNATIONAL": "KKV International",
}

# Most matches one search returns, newest first. More than this sets `truncated`.
SEARCH_RESULT_LIMIT = 300

# Longest query accepted; the app's search box has the same maxLength.
SEARCH_QUERY_MAX_LEN = 100

# WHIT-846: an unfiled row matches either spelling. Mirrors the app's UNCATEGORISED_SEARCH_LABEL.
UNFILED_SEARCH_LABEL = "Uncategorised Uncategorized"


def _merchant_label(transaction: dict) -> str:
    merchant = transaction.get("merchant_name") or transaction.get("description") or ""
    return CLEAN_NAME.get(merchant) or merchant


def _category_label(category: str | None, category_names: dict[str, str]) -> str:
    if category == "income":
        return "Income"
    if is_unfiled_category(category, category_names):
        return "Uncategorized"
    return category_names[category]


def transaction_matches_search(transaction: dict, query: str, category_names: dict[str, str]) -> bool:
    """Whether a transaction matches the search box text. Case-insensitive substring over what
    the row shows; `$` and `,` are also stripped from the query so "$42" / "1,234" match."""
    normalised_query = query.strip().lower()
    if normalised_query == "":
        return True
    category = transaction.get("category")
    category_label = (
        UNFILED_SEARCH_LABEL
        if is_unfiled_category(category, category_names)
        else _category_label(category, category_names)
    )
    parts = [
        _merchant_label(transaction),
        transaction.get("description") or "",
        category_label,
        f"{abs(float(transaction.get('amount') or 0)):.2f}",
        transaction.get("notes") or "",
        " ".join(transaction.get("tags") or []),
    ]
    haystack = " ".join(parts).lower()
    return normalised_query in haystack or normalised_query.replace("$", "").replace(",", "") in haystack


def search_transactions(
    transactions: list[dict], query: str, category_names: dict[str, str], unfiled_only: bool
) -> tuple[list[dict], bool, int, float]:
    """The matching transactions, newest first, capped at SEARCH_RESULT_LIMIT, plus whether the
    cap cut any off, and the count and signed dollar total of EVERY match (summed in whole cents),
    so a cut-off search still shows exact figures. `unfiled_only` narrows to the Uncategorized tab's rows. The sort is stable,
    so rows on the same date keep the scan's account order — the same order the feed shows."""
    matches = [
        transaction
        for transaction in transactions
        if (not unfiled_only or is_unfiled_category(transaction.get("category"), category_names))
        and transaction_matches_search(transaction, query, category_names)
    ]
    matches.sort(key=lambda transaction: transaction.get("date") or "", reverse=True)
    total_cents = sum(round(float(transaction.get("amount") or 0) * 100) for transaction in matches)
    return matches[:SEARCH_RESULT_LIMIT], len(matches) > SEARCH_RESULT_LIMIT, len(matches), total_cents / 100
