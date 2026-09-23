"""Full-history transaction search for the Transactions tab (WHIT-576).

The app used to filter only the feed pages it had loaded (30 rows each), so a match deeper in
history showed "No matches" while "Load More" was still on screen. The handler now reads ALL
history once and this module decides which rows match.

It is the server twin of the app's transactionMatchesSearch (src/context.tsx): the same text is
searched (merchant label, description, category label, amount, and notes + tags when
SEARCH_NOTES_AND_TAGS is on), so a row the app would keep is a row the server returns. The shared
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

# Whether the user's own notes and tags are searched too. Must equal the app's switch.
SEARCH_NOTES_AND_TAGS = True

# Most matches one search returns, newest first. More than this sets `truncated`.
SEARCH_RESULT_LIMIT = 300

# Longest query accepted; the app's search box has the same maxLength.
SEARCH_QUERY_MAX_LEN = 100


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
    parts = [
        _merchant_label(transaction),
        transaction.get("description") or "",
        _category_label(transaction.get("category"), category_names),
        f"{abs(float(transaction.get('amount') or 0)):.2f}",
    ]
    if SEARCH_NOTES_AND_TAGS:
        parts.append(transaction.get("notes") or "")
        parts.append(" ".join(transaction.get("tags") or []))
    haystack = " ".join(parts).lower()
    return normalised_query in haystack or normalised_query.replace("$", "").replace(",", "") in haystack


def search_transactions(
    transactions: list[dict], query: str, category_names: dict[str, str], unfiled_only: bool
) -> tuple[list[dict], bool]:
    """The matching transactions, newest first, capped at SEARCH_RESULT_LIMIT, plus whether the
    cap cut any off. `unfiled_only` narrows to the Uncategorized tab's rows. The sort is stable,
    so rows on the same date keep the scan's account order — the same order the feed shows."""
    matches = [
        transaction
        for transaction in transactions
        if (not unfiled_only or is_unfiled_category(transaction.get("category"), category_names))
        and transaction_matches_search(transaction, query, category_names)
    ]
    matches.sort(key=lambda transaction: transaction.get("date") or "", reverse=True)
    return matches[:SEARCH_RESULT_LIMIT], len(matches) > SEARCH_RESULT_LIMIT
