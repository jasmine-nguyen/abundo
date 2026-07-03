ACCOUNT_ID_MAP = {
    "9h2FO6S58zunrwF3U3MhBoaEQNDDfqVlEC5bLSWNdN0": "anz-rewards-black-visa",
    "3zVQJ8Btz_IRmqp78VrQnQ": "up-spending",
    "T6d8ppsYssBDFCwl1qEb0w": "up-homeloan",
}
PENDING_STATUS = "pending"
POSTED_STATUS = "posted"
MAX_PAGE_SIZE = 100
TRANSACTION_PATH = "/transactions"
# Lookback window, in days, for the recent-transactions feed (get_recent_transactions).
FEED_WINDOW_DAYS = 7

# --- BankSync Enrichments (categorisation rules) ---------------------------
# lambda_api ships its OWN constants.py (it shadows the shared layer at
# /var/task), so the BankSync values the shared layer already defines have to be
# repeated here for the enrichments proxy to import them. Keep equal to
# shared/constants.py.
BANKSYNC_BASE_URL = "https://api.banksync.io"
BANKSYNC_API_KEY_PATH = "/whittle/banksync-api-key"
# BankSync sits behind Cloudflare, which 403s the default "Python-urllib"
# User-Agent (error 1010). Send our own on every request (matches the
# sync-trigger lambda, which uses its own "whittle-sync-trigger").
BANKSYNC_USER_AGENT = "whittle-lambda-api"
# HTTP timeout, in seconds, for a single enrichments request to BankSync.
BANKSYNC_TIMEOUT_SECONDS = 30

# API Gateway route path for the enrichments (categorisation-rule) endpoints.
ENRICHMENTS_PATH = "/enrichments"

# Tier-1 rule vocabulary we let the app author. Kept to what we've VERIFIED
# against BankSync (description contains / category equals, 2026-07-02); the
# create handler rejects anything outside these so an unverified operator never
# reaches BankSync. Widen only after a /enrich/preview dry-run confirms support.
RULE_FIELDS = frozenset({"description", "category"})
RULE_OPERATORS = frozenset({"contains", "equals"})
# Applied when a create request omits them: the plain "description contains X"
# rule that the current in-app UI produces.
DEFAULT_RULE_FIELD = "description"
DEFAULT_RULE_OPERATOR = "contains"

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
