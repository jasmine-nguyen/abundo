from decimal import Decimal
from typing import TypedDict


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


class Category(TypedDict):
    id: str
    name: str
    icon: str
    color: str
    bucket: str
