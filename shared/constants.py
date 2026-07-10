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

# A home-loan repayment CREDIT leg lands on the up-homeloan account as an incoming
# transfer (positive amount) — the same identity the read API's get_repayment uses
# (WHIT-115). The webhook's repayment-push detector (WHIT-15) anchors on the account
# + this type, so it can't drift from the budget rule or the description ("Transfer
# from Spending" varies). Mirrors lambda_api/constants.py (which shadows this layer at
# /var/task); kept equal here so the webhook lambda — which has no shadow — can import
# it. (WHIT-136 sync guard.)
REPAYMENT_INCOMING_TYPE = "TRANSFER_INCOMING"

# Minimum home-loan repayment amount (dollars) that fires a push (WHIT-15). The real
# Up feed carries tiny "OHA test" repayments ($1/$2/$5); this floor skips them. A
# plain int (not Decimal) so the WHIT-136 mirror in lambda_api/constants.py needs no
# Decimal import; `Decimal(amount) >= 10` compares cleanly.
MIN_REPAYMENT_NOTIFY = 10

# Raw BankSync categories that are transfers/loan movements between the user's OWN
# accounts (own-account transfers, investments, card payments, home-loan repayments) —
# not discretionary spend, so they don't count toward a spending budget (WHIT-50).
# INCOME is deliberately NOT here: income is left counting so earn-targets can use it.
# Confirmed against real Up data (2026-07-03).
NON_BUDGET_CATEGORIES = {"TRANSFER_IN", "TRANSFER_OUT", "LOAN_PAYMENTS"}

# SSM SecureString path holding the BankSync REST API key (read by whittle-transaction-trigger).
BANKSYNC_API_KEY_PATH = "/whittle/banksync-api-key"

# Base URL for the BankSync REST API.
BANKSYNC_BASE_URL = "https://api.banksync.io"

# Lookback window, in days, used when requesting a feed's transactions.
FEED_WINDOW_DAYS = 7

# Settlement window, in days, after which a still-pending transaction is reaped as a
# ghost that will never settle (WHIT-79). Measured from the bank `date` (the only age
# signal on a stored row — there is no ingest timestamp). Set safely PAST FEED_WINDOW_DAYS
# (7): BankSync stops re-sending a transaction after that window, so a pending older than
# 10 days can no longer receive a settlement push — it is genuinely frozen. Used only by
# lambda/age_out.py (a webhook-lambda module, not a shared repository_* module), so the
# WHIT-136 sync guard does not require a lambda_api/constants.py mirror.
PENDING_AGE_OUT_DAYS = 10

# Maximum number of items requested per DynamoDB query page.
MAX_PAGE_SIZE = 100

# Status value marking a transaction as not yet posted.
PENDING_STATUS = "pending"

# Status value marking a settled transaction. Kept in the shared layer (as well as
# the lambda_api shadow) so the shared spend summariser + budget-alert detection —
# which the webhook lambda loads — can import it. (WHIT-136 sync guard.)
POSTED_STATUS = "posted"

# Retention window for a budget-alert debounce marker (WHIT-22). Written as a
# DynamoDB TTL (epoch-seconds `expires_at`) so a marker self-cleans after its cycle
# instead of accumulating. 60 days — comfortably longer than the max 30-day cycle
# (a new cycle re-arms via a fresh pk, so the marker only needs to outlive its own).
NOTIFY_TTL_SECONDS = 60 * 24 * 60 * 60

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

# Every account the balance poller reads a live balance for — the Accounts tab shows one
# card per account with its current balance (WHIT-212). Each `aid` MUST be a key in
# ACCOUNT_ID_MAP so the signed balance is stored under the SAME internal id the account's
# transactions carry (that's how the app joins a balance to a card); `bid` is its Fiskil
# bank id. The home loan appears here too — polled for its SIGNED per-account balance —
# and, separately, via HOMELOAN_BALANCE_SOURCE above for the Goal screen's ABS
# outstanding-principal row. Poller-only (no shared repository_* imports it), so the
# WHIT-136 sync guard needs no lambda_api/constants.py mirror.
BALANCE_SOURCES = [
    {"bid": "fiskil_3", "aid": "3zVQJ8Btz_IRmqp78VrQnQ"},                       # up-spending
    {"bid": "fiskil_3", "aid": "T6d8ppsYssBDFCwl1qEb0w"},                       # up-homeloan
    {"bid": "fiskil_4", "aid": "9h2FO6S58zunrwF3U3MhBoaEQNDDfqVlEC5bLSWNdN0"},  # anz-rewards-black-visa
]
# Drift guard (mirrors the HOMELOAN_ACCOUNT_ID assert): a source whose aid isn't mapped
# would store a balance under a raw id the app can never join to an account. Fail at import
# rather than silently polling a balance nothing displays.
assert all(s["aid"] in ACCOUNT_ID_MAP for s in BALANCE_SOURCES), (
    "every BALANCE_SOURCES `aid` must be a key in ACCOUNT_ID_MAP"
)

# API Gateway route path for the read API that the whittle app calls.
TRANSACTION_PATH = "/transactions"
# Date-range transactions query route (WHIT-34). Consumed only by lambda_api/handler.py
# (which imports the shadowing lambda_api/constants.py at runtime); mirrored here for
# parity with that copy. Distinct from the /transactions feed — see lambda_api/constants.py.
TRANSACTIONS_RANGE_PATH = "/transactions/range"

# Retention window for FAILED# dead-letter items (WHIT-54). Written as a DynamoDB
# TTL (epoch-seconds `expires_at`), so a stuck row auto-expires instead of
# accumulating forever — long enough to notice + reprocess (see the recovery
# lambda, WHIT-55), short enough not to pile up. 30 days.
DEAD_LETTER_TTL_SECONDS = 30 * 24 * 60 * 60
