ACCOUNT_ID_MAP = {
    "9h2FO6S58zunrwF3U3MhBoaEQNDDfqVlEC5bLSWNdN0": "anz-rewards-black-visa",
    "3zVQJ8Btz_IRmqp78VrQnQ": "up-spending",
    "T6d8ppsYssBDFCwl1qEb0w": "up-homeloan",
}
PENDING_STATUS = "pending"
POSTED_STATUS = "posted"
# Mirrors shared/constants.py (the webhook loads the shared copy) — the budget-alert
# debounce marker TTL (WHIT-22). Kept equal here for the WHIT-136 sync guard.
NOTIFY_TTL_SECONDS = 60 * 24 * 60 * 60
MAX_PAGE_SIZE = 100
# Imported at module load by the layer's repository_transaction (which this API
# lambda uses for reads) even though only the webhook dead-letters. Must stay equal
# to shared/constants.py (WHIT-54). 30 days.
DEAD_LETTER_TTL_SECONDS = 30 * 24 * 60 * 60
TRANSACTION_PATH = "/transactions"
# API Gateway route path for the date-range transactions query (WHIT-34). A distinct
# path from the /transactions feed: unlike the feed (a fixed rolling window that returns
# a bare array and drops the cursor), this takes client from/to + account_id and returns
# {transactions, nextCursor} so a wide window can be paged. Only lambda_api/handler.py
# consumes it (no shared repository_* imports it), so the WHIT-136 sync guard doesn't
# require the shared mirror — kept equal in shared/constants.py for hygiene only.
TRANSACTIONS_RANGE_PATH = "/transactions/range"
# Max items accepted by the batch PATCH /transactions endpoint (WHIT-70). The
# route is open and the handler applies updates in a sequential per-item loop, so
# this bounds the work one request can queue. Real sweeps are tiny (uncategorised
# charges in the 7-day feed window), so this only guards against an abusive body.
TRANSACTION_BATCH_MAX = 100
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
# transaction-trigger lambda, which uses its own "whittle-transaction-trigger").
BANKSYNC_USER_AGENT = "whittle-app-api"
# HTTP timeout, in seconds, for a single enrichments request to BankSync.
BANKSYNC_TIMEOUT_SECONDS = 30

# API Gateway route path for the enrichments (categorisation-rule) endpoints.
ENRICHMENTS_PATH = "/enrichments"

# --- AI spending insights (WHIT-104) ---------------------------------------
# The Anthropic Messages API, called server-side from lambda_api/insights_ai.py
# (urllib + SSM key + custom User-Agent, mirroring the BankSync client). The app
# never holds the key. GET reads the per-cycle cache; POST generates.
INSIGHTS_AI_PATH = "/insights/ai"
ANTHROPIC_API_KEY_PATH = "/whittle/anthropic-api-key"
ANTHROPIC_BASE_URL = "https://api.anthropic.com"
ANTHROPIC_MESSAGES_PATH = "/v1/messages"
ANTHROPIC_VERSION = "2023-06-01"
# Sonnet 5: on a real side-by-side against Haiku (same numbers, same prompt) it gave
# sharper, more consistent tips — spotted cross-category patterns Haiku missed and
# stayed inside the "don't invent figures" guardrail that Haiku occasionally broke.
# Opus 4.8 above it added cost with no visible quality gain, so Sonnet is the pick.
ANTHROPIC_MODEL = "claude-sonnet-5"
ANTHROPIC_MAX_TOKENS = 700
# Sonnet 5 runs internal "thinking" (extra reasoning before answering) by DEFAULT when
# the request omits it — and with our 700-token cap it can spend that budget thinking
# and truncate the JSON reply mid-answer. This task needs no reasoning, so disable it:
# the call stays a fast, single-shot answer within the token cap (mirrors Haiku, which
# never thought). Sent as the request's "thinking" field in insights_ai.py.
ANTHROPIC_THINKING = {"type": "disabled"}
# api.anthropic.com sits behind Cloudflare, which 403s the default urllib
# User-Agent — the UA is load-bearing (same lesson as the BankSync client).
ANTHROPIC_USER_AGENT = "whittle-app-api"
ANTHROPIC_TIMEOUT_SECONDS = 30
# How many PRIOR pay cycles of category spend to include for trend context.
INSIGHTS_PRIOR_CYCLES = 1

# WHIT-68: the furthest-back cycle /breakdown will answer for (0 = current, up to N
# cycles prior). A safety bound on how far into the past a single request may reach —
# each request scans exactly ONE length-day window regardless of `cycle`, so the read
# cost is flat; the cap just rejects an absurd/out-of-range ?cycle= with a 400 rather
# than serving it. Kept in the lambda_api layer only (the shared spend helper stays
# constant-free and pure); deliberately NOT reusing INSIGHTS_PRIOR_CYCLES so widening the
# AI trend can't silently change the breakdown lookback.
BREAKDOWN_MAX_LOOKBACK = 12

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

# Buckets whose spend appears in the category-breakdown screen (WHIT-23). Income
# and Savings carry positive amounts, so summing -amount clamps them to $0 rows;
# a *spend* view excludes them. A subset of CATEGORY_BUCKETS.
SPEND_BUCKETS = {"Living", "Lifestyle"}

# The bucket whose category targets are earn-targets (floors, over-is-good) rather
# than spend ceilings (WHIT-69). A budget on an Income-bucket category rolls up the
# POSITIVE earnings for the cycle instead of spend. Lambda_api-only (no shared module
# imports it), so the WHIT-136 sync guard doesn't require a shared mirror.
INCOME_BUCKET = "Income"

# The bucket whose categories cannot carry a budget target at all (WHIT-202). A Savings
# category is a non-spend goal, not a pay-cycle ceiling/floor, so the client refuses to
# render a target on it (budgetViews/budgetDetail skip Savings) — a stored one would be an
# invisible, un-editable phantom. set_budget rejects a direct write and update_category
# rejects re-bucketing a still-budgeted category into Savings. Lambda_api-only (no shared
# module imports it), like INCOME_BUCKET, so the WHIT-136 sync guard needs no shared mirror.
SAVINGS_BUCKET = "Savings"

# Icon assigned when a create request omits one (a valid key in src/icons.tsx).
DEFAULT_CATEGORY_ICON = "tag"

# --- Budgets (per-category pay-cycle targets) ------------------------------
# API Gateway route path for the budget-target endpoints (GET all, PUT one).
BUDGET_PATH = "/budgets"

# --- Goals (savings/paydown balance targets, WHIT-231) ---------------------
# API Gateway route path for the goal CRUD endpoints (GET list, PUT one, DELETE one).
# Read ONLY by lambda_api/handler.py (no shared repository_* module imports it), so the
# WHIT-136 constants-sync guard needs no shared/constants.py mirror.
GOALS_PATH = "/goals"

# --- Category breakdown (spend by category for the current cycle, WHIT-23) --
# API Gateway route path for the breakdown endpoint (GET only).
BREAKDOWN_PATH = "/breakdown"

# Sentinel category id for the "Uncategorized" bucket in the breakdown response:
# spend that counts to budget but whose category isn't in the taxonomy (a raw
# BankSync enum, a deleted category's dangling id, or null). _slugify strips '_',
# so no real category id can ever collide with this key.
UNCATEGORIZED_KEY = "__uncategorized__"

# --- Loan facts (user-entered home-loan inputs) ----------------------------
# API Gateway route path for the loan-facts endpoints (GET current, PUT to set).
# The user enters facts no bank feed provides (original amount, property value,
# LVR, rate, scheduled + extra repayment); GET returns null fields until saved.
LOANFACTS_PATH = "/loanfacts"

# Upper bound for the dollar-amount fields (original / homeValue / baseRepay /
# extra). Same ceiling as budget targets — a sanity guard, not a real limit.
LOANFACTS_FIELD_MAX = 1_000_000_000

# --- Home loan (live mortgage balance, WHIT-8) -----------------------------
# API Gateway route path for the home-loan balance endpoint (GET only). The
# balance-poller lambda writes the row; this read API serves it to the app.
HOMELOAN_PATH = "/homeloan"

# Internal account id whose balance the /homeloan route serves. Mirrors
# HOMELOAN_ACCOUNT_ID in shared/constants.py (lambda_api shadows the layer's
# constants at /var/task); keep the two equal.
HOMELOAN_ACCOUNT_ID = "up-homeloan"

# --- Account balances (live per-account balance, WHIT-212) -----------------
# API Gateway route path for the per-account balances endpoint (GET only). The
# balance-poller writes one signed-balance row per account; this read API serves them
# to the Accounts tab. Only lambda_api/handler.py consumes it (no shared repository_*
# imports it), so the WHIT-136 sync guard doesn't require a shared mirror.
ACCOUNT_BALANCES_PATH = "/accounts/balances"

# --- Last repayment (WHIT-115) ---------------------------------------------
# API Gateway route path for the latest home-loan repayment (GET only). Reads
# the full up-homeloan history (not the 7-day feed) since repayments are ~monthly.
REPAYMENT_PATH = "/repayment"

# A home-loan repayment CREDIT leg lands on the up-homeloan account as an incoming
# transfer (positive amount). Anchoring on the account + this type is unambiguous;
# the description varies ("Transfer from Spending") and LOAN_PAYMENTS also matches
# unrelated card payments on up-spending, so neither is used to identify it.
REPAYMENT_INCOMING_TYPE = "TRANSFER_INCOMING"

# Minimum home-loan repayment amount (dollars) that fires a push (WHIT-15). Mirrors
# shared/constants.py (the webhook loads the shared copy); kept equal here for the
# WHIT-136 sync guard, as a plain int so no Decimal import is needed.
MIN_REPAYMENT_NOTIFY = 10

# Interest posts as a separate BANK_FEES debit on the up-homeloan account. When one
# falls in the same calendar month as the repayment, principal = repayment - |interest|.
INTEREST_CATEGORY = "BANK_FEES"

# --- Pay cycle (persisted length + payday last_pay_date) --------------------------
# API Gateway route path for the pay-cycle endpoints (GET current, PUT to set).
PAYCYCLE_PATH = "/paycycle"

# --- Device push-token registration (POST /devices) ------------------------
# API Gateway route path for registering an Expo push token. Gated behind the
# shared-secret authorizer (like /enrichments): it controls who receives the
# user's notifications, so it is NOT left open like the read routes.
DEVICES_PATH = "/devices"
# Upper bound on an accepted Expo push token's length — a sanity guard, not a real
# limit (a real ExpoPushToken[...] value is ~40 chars).
EXPO_TOKEN_MAX_LEN = 256

# Cycle lengths (days) the client offers: Weekly / Fortnightly / Monthly. A PUT
# with any other length is rejected 400 — the window math assumes one of these.
PAYCYCLE_LENGTHS = frozenset({7, 14, 30})

# Seed until the user sets their real payday: a fixed past date (a Wednesday, the
# app's original default last_pay_date) + a fortnightly length. Any past date works —
# the window math walks forward from it in `length`-day steps (P14/Slice 2).
# Mirrored in shared/constants.py (imported by repository.py); keep the two equal.
DEFAULT_PAYCYCLE = {"length": 14, "last_pay_date": "2024-01-03"}
