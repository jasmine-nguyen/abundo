# Maps BankSync account ids to whittle's internal account ids.
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

# SSM SecureString path holding the BankSync REST API key (read by whittle-sync-trigger).
BANKSYNC_API_KEY_PATH = "/whittle/banksync-api-key"

# Base URL for the BankSync REST API.
BANKSYNC_BASE_URL = "https://api.banksync.io"

# SSM SecureString path holding the shared-secret token that the API Gateway
# authorizer checks on the /enrichments routes. Read by the authorizer lambda
# (via this layer); the real value is set out-of-band (see terraform/ssm.tf).
API_AUTH_TOKEN_PATH = "/whittle/api-auth-token"

# Lookback window, in days, used when requesting a feed's transactions.
FEED_WINDOW_DAYS = 7

# Maximum number of items requested per DynamoDB query page.
MAX_PAGE_SIZE = 100

# Status value marking a transaction as not yet posted.
PENDING_STATUS = "pending"

# Seed pay cycle used by PayCycleRepository until the user sets their real payday:
# a fixed past date (a Wednesday, the app's original default last_pay_date) + a
# fortnightly length. Mirrored in lambda_api/constants.py, which shadows this at
# /var/task; kept here too so repository.py imports cleanly under the sync lambda
# (which has no shadowing constants.py), not only under the API lambda.
DEFAULT_PAYCYCLE = {"length": 14, "last_pay_date": "2024-01-03"}

# BankSync feeds triggered on every scheduled sync run, keyed by feed id -> label.
SYNC_FEED_IDS = {
    "xXkBR72EKo4Qxkz8667l": "spending-anz",
    "LwO4ZvpH5SMBhEkAO2br": "up-homeloan",
}

# HTTP timeout, in seconds, for a single sync-trigger request to BankSync.
SYNC_TIMEOUT_SECONDS = 30

# API Gateway route path for the read API that the whittle app calls.
TRANSACTION_PATH = "/transactions"
