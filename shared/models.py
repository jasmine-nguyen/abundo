from decimal import Decimal
from typing import TypedDict, Optional


class Transaction(TypedDict):
    transaction_id: str
    account_id: str
    account_name: str
    counts_to_budget: bool  # If a transaction should be counted toward a budget
    date: str  # Use date if parsed into a datetime object
    amount: Decimal  # Best practice for financial transactions
    closing_balance: Decimal
    payee: str
    original_payee: str
    status: str
    type: str
    memo: Optional[str]
    source: str
    ps_category: Optional[str]
    category: Optional[str]  # Expresses that 'None' or 'str' is allowed
    notes: Optional[str]  # Expresses that 'None' or 'str' is allowed
    updated_at: str  # ISO 8601, from PocketSmith raw payload
