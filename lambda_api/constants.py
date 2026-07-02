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

# Default budget rollup window length (days) when the client doesn't send one.
# INTERIM: a rolling last-N-days window, NOT yet aligned to a pay-cycle anchor —
# real payday alignment is P14. Isolated in current_cycle_window() so only that
# seam changes when P14 lands. 14 = the client's default payCycle.length.
CYCLE_WINDOW_DAYS = 14
