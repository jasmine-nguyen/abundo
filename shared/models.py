from decimal import Decimal
from typing import Optional, TypedDict


class Transaction(TypedDict):
    transaction_id: str
    date: str  # Use date if parsed into a datetime object
    authorized_date: str
    description: str
    merchant_name: str
    amount: Decimal
    account_id: str
    account_name: str
    category: str
    status: str
    type: str
    counts_to_budget: bool
    # The bank id of the pending transaction this posted one settled from, when
    # BankSync provides it. Currently always None (they don't populate it yet), so
    # reconciliation falls back to a heuristic match; kept here so the exact-link
    # path lights up automatically the day they do. None on pending rows too.
    # Only the webhook sets this; the read API leaves it unset (sparse on write).
    pending_transaction_id: Optional[str]
    # User-authored, optional, sparse (WHIT-275). A free-text note and free-text
    # tags. Cleared fields are REMOVEd (not stored as ""/[]), so an absent value
    # reads back as None rather than an empty string/list.
    notes: Optional[str]
    tags: Optional[list[str]]
    # User override (WHIT-296). When True, the user has manually excluded this
    # transaction from budgets ("mark as transfer"), overriding the bank-derived
    # counts_to_budget. Sparse: only True is stored, so absent reads back as None
    # (not excluded). Kept separate from counts_to_budget so a re-import recompute
    # of the bank value can't wipe the user's choice; carried across re-sync like
    # notes/tags.
    budget_excluded: Optional[bool]


class Category(TypedDict):
    id: str
    name: str
    icon: str
    color: str
    bucket: str
    # Id of the parent this category rolls up into, or None for a top-level
    # category. Absent on rows written before sub-categories existed; the
    # repository defaults it to None on read.
    parent: Optional[str]
