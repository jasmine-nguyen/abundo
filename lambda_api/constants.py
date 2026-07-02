ACCOUNT_ID_MAP = {
    "9h2FO6S58zunrwF3U3MhBoaEQNDDfqVlEC5bLSWNdN0": "anz-rewards-black-visa",
    "3zVQJ8Btz_IRmqp78VrQnQ": "up-spending",
    "T6d8ppsYssBDFCwl1qEb0w": "up-homeloan",
}
PENDING_STATUS = "pending"
POSTED_STATUS = "posted"
MAX_PAGE_SIZE = 100
TRANSACTION_PATH = "/transactions"
FEED_WINDOW_DAYS = 5

# --- Categories (user-defined taxonomy) ------------------------------------
# API Gateway route path for the category CRUD endpoints.
CATEGORY_PATH = "/categories"

# Allowed spending buckets (mirrors the client Bucket union in src/context.tsx).
CATEGORY_BUCKETS = {"Living", "Lifestyle", "Income", "Savings"}

# Icon assigned when a create request omits one (a valid key in src/icons.tsx).
DEFAULT_CATEGORY_ICON = "tag"

# --- Budgets (per-category pay-cycle targets) ------------------------------
# API Gateway route path for the budget-target endpoints (GET all, PUT one).
BUDGET_PATH = "/budgets"

# --- Pay cycle (persisted length + payday last_pay_date) --------------------------
# API Gateway route path for the pay-cycle endpoints (GET current, PUT to set).
PAYCYCLE_PATH = "/paycycle"

# Cycle lengths (days) the client offers: Weekly / Fortnightly / Monthly. A PUT
# with any other length is rejected 400 — the window math assumes one of these.
PAYCYCLE_LENGTHS = frozenset({7, 14, 30})

# Seed until the user sets their real payday: a fixed past date (a Wednesday, the
# app's original default last_pay_date) + a fortnightly length. Any past date works —
# the window math walks forward from it in `length`-day steps (P14/Slice 2).
# Mirrored in shared/constants.py (imported by repository.py); keep the two equal.
DEFAULT_PAYCYCLE = {"length": 14, "last_pay_date": "2024-01-03"}
