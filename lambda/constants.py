ACCOUNT_ID_MAP = {
    "9h2FO6S58zunrwF3U3MhBoaEQNDDfqVlEC5bLSWNdN0": "anz-rewards-black-visa",
    "3zVQJ8Btz_IRmqp78VrQnQ": "up-spending",
    "T6d8ppsYssBDFCwl1qEb0w": "up-homeloan",
}

# The mortgage account's internal id (a value in ACCOUNT_ID_MAP). Everything posted here
# is loan movement — interest, repayment credits — never discretionary spend, so it
# doesn't count toward a spending budget (WHIT-50). Single source of truth for "is this
# the home loan", reused by the home-loan goal / repayment-notification (WHIT-8/WHIT-15).
HOMELOAN_ACCOUNT_ID = "up-homeloan"
# Guard against silent drift: if the mortgage's internal id is renamed in the map but
# not here, the account rule would quietly stop matching and loan movements would start
# hitting budgets again. Fail loudly at import instead.
assert HOMELOAN_ACCOUNT_ID in ACCOUNT_ID_MAP.values(), (
    "HOMELOAN_ACCOUNT_ID must be one of ACCOUNT_ID_MAP's values"
)

# Raw BankSync categories that are transfers/loan movements between the user's OWN
# accounts (own-account transfers, investments, card payments, home-loan repayments) —
# not discretionary spend, so they don't count toward a spending budget (WHIT-50).
# INCOME is deliberately NOT here: income is left counting so earn-targets can use it.
# Confirmed against real Up data (2026-07-03).
NON_BUDGET_CATEGORIES = {"TRANSFER_IN", "TRANSFER_OUT", "LOAN_PAYMENTS"}

PENDING_STATUS = "pending"
MAX_PAGE_SIZE = 100
TRANSACTION_PATH = "/transactions"
FEED_WINDOW_DAYS = 5
