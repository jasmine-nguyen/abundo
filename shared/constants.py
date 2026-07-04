from decimal import Decimal

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

# Maximum fraction by which a settled (posted) charge may exceed its pending
# authorisation and still be reconciled as the SAME purchase — i.e. a tip added at
# settlement (restaurants/delivery/rideshare). ONE-DIRECTIONAL: a tip only makes
# spend larger, so a smaller (or opposite-sign, e.g. a refund) settled amount is
# never a tip-match. Used by the reconciler's tip-adjusted tier (WHIT-116).
# +25% = a generous but bounded tip.
TIP_HEADROOM = Decimal("0.25")

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

# BankSync (bid, aid) coordinates for the home-loan account, used by the balance
# poller to call getBalance (`GET /v1/banks/{bid}/accounts/{aid}/balances`) and
# read the live mortgage balance (WHIT-8). `aid` is the same value that keys
# ACCOUNT_ID_MAP -> HOMELOAN_ACCOUNT_ID; `bid` is the Fiskil bank id, which lives
# nowhere else in the config. If Up is ever re-linked and either id rotates the
# poller 404s, logs, and leaves the last-good balance untouched (never zeroes it).
HOMELOAN_BALANCE_SOURCE = {"bid": "fiskil_3", "aid": "T6d8ppsYssBDFCwl1qEb0w"}

# HTTP timeout, in seconds, for a single balance-poller request to BankSync.
HOMELOAN_BALANCE_TIMEOUT_SECONDS = 30

# API Gateway route path for the read API that the whittle app calls.
TRANSACTION_PATH = "/transactions"

# --- Push notifications (Expo Push) ----------------------------------------
# Expo Push send endpoint. shared/push.py POSTs a batch of messages here.
EXPO_PUSH_URL = "https://exp.host/--/api/v2/push/send"
# HTTP timeout, in seconds, for a single Expo Push request.
EXPO_PUSH_TIMEOUT_SECONDS = 15
# Expo accepts at most 100 messages per push request.
EXPO_PUSH_BATCH_MAX = 100
# SSM SecureString path holding the Expo access token (a PAT). Required because
# the Expo project has "Enhanced Security for Push Notifications" enabled, so
# every send must carry Authorization: Bearer <token>. Seeded as a placeholder by
# terraform/ssm.tf; the real value is set out-of-band (console/CLI). Read only by
# the shared push sender — NOT under lambda_api (see the warning in push.py).
EXPO_ACCESS_TOKEN_PATH = "/whittle/expo-access-token"
