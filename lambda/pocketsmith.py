from decimal import Decimal
from ssm import get_param
from typing import List, Optional, TypedDict
from urllib.parse import urlencode
import json
import urllib.request


POCKETSMITH_DEVELOPER_KEY_PATH = "/whittle-app/pocketsmith-developer-key"
GET_TRANSACTIONS_ENDPOINT = (
    "https://api.pocketsmith.com/v2/transaction_accounts/{account_id}/transactions"
)


class Transaction(TypedDict):
    transaction_id: str
    account_id: str
    account_name: str
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


class PocketSmithClient:
    def __init__(self) -> None:
        self._developer_key = None
        self.path = "/whittle-app/pocketsmith-developer-key"

    @property
    def developer_key(self) -> str:
        if self._developer_key is None:
            self._developer_key = get_param(self.path)
        return self._developer_key

    def _get_headers(self) -> dict:
        return {
            "X-Developer-Key": self.developer_key,
            "Accept": "application/json",
        }

    @staticmethod
    def _get_next_url(link_header: str) -> Optional[str]:
        for part in link_header.split(","):
            if 'rel="next"' in part:
                return part.split(";")[0].strip().strip("<>")
        return None

    @staticmethod
    def _normalise(raw_data: list) -> List[Transaction]:
        """Maps PocketSmith's specific fields to Whittle's standard format"""
        normalised = []
        for txn in raw_data:
            txn_account: dict = txn["transaction_account"]
            normalised.append(
                {
                    "transaction_id": str(txn["id"]),
                    "account_id": str(txn_account["account_id"]),
                    "account_name": txn_account["name"],
                    "date": txn["date"],
                    "amount": Decimal(str(txn["amount"])),
                    "closing_balance": Decimal(str(txn["closing_balance"])),
                    "payee": txn["payee"],
                    "original_payee": txn["original_payee"],
                    "status": txn["status"],
                    "type": txn["type"],
                    "memo": txn.get("memo", None),
                    "source": txn["transaction_account"]["institution"]["title"],
                    "ps_category": cat["title"]
                    if (cat := txn.get("category"))
                    else None,
                    "category": None,
                    "notes": None,
                }
            )

        return normalised

    def get_transactions(
        self, account_id: str, updated_since: str
    ) -> List[Transaction]:
        base_url: str = GET_TRANSACTIONS_ENDPOINT.format(account_id=account_id)
        params = {"updated_since": updated_since}
        query_string = urlencode(params)
        final_url = f"{base_url}?{query_string}"

        transactions = []
        url = final_url
        try:
            while url:
                req = urllib.request.Request(url=url, headers=self._get_headers())
                with urllib.request.urlopen(req) as response:
                    raw_data = json.loads(response.read().decode())
                    transactions.extend(raw_data)
                    link_header = response.headers.get("Link", "")
                    url = self._get_next_url(link_header) if link_header else None
        except Exception as e:
            raise RuntimeError(f"PocketSmith API call failed: {e}")

        return self._normalise(transactions)
