# Constants used only by the read API (lambda_api). Anything a shared module or another
# lambda also needs lives in shared/constants.py instead — never in both.

# API Gateway route path for the read API that the abundo app calls.
TRANSACTION_PATH = "/transactions"
# API Gateway route path for the all-accounts transactions feed (Load More over full
# history). Unlike the /transactions recent route (a fixed 7-day rolling window returning
# a bare array), this merges EVERY account newest-first with NO date floor and returns
# {transactions, nextCursor} so the app can page back through all history.
TRANSACTIONS_FEED_PATH = "/transactions/feed"
# API Gateway route path for the full-history uncategorized count (WHIT-500). Returns
# {count}: how many uncategorized charges the user has across ALL history, so the tab
# badge, tab-bar dot, and "All caught up" empty state reflect the whole picture, not just
# the loaded feed pages.
UNCATEGORIZED_COUNT_PATH = "/transactions/uncategorized/count"
# API Gateway route path for the paged uncategorized feed. Same {transactions, nextCursor}
# shape as /transactions/feed, but each page returns only uncategorized charges (same rule
# as the count), so the Uncategorized tab lists ACTUAL uncategorized rows from all history
# via Load More instead of client-filtering the general feed's loaded pages.
UNCATEGORIZED_FEED_PATH = "/transactions/uncategorized/feed"
# API Gateway route path for the "apply my rules to charges already stored" pass (POST).
# BankSync applies rules at sync time to INCOMING charges only, so a rule written today never
# reaches yesterday's unfiled charges (WHIT-502); this route closes that gap. It PREVIEWS by
# default — a write needs an explicit {"dryRun": false} — so a bulk write can't happen by
# accident.
UNCATEGORIZED_APPLY_RULES_PATH = "/transactions/uncategorized/apply-rules"
# API Gateway route paths for the ASYNC apply-rules job (WHIT-537). The synchronous route above
# caps at 300 writes / 15s to stay inside the 30s gateway window; for a large history that means
# the user re-taps "apply the rest". These run the sweep in a background worker with NO cap: POST
# .../jobs starts a job and returns its id immediately (202); GET .../jobs/{id} reports progress
# so the app can poll to completion. The GET is matched by prefix (the id is a path parameter), so
# only the POST path is a constant.
UNCATEGORIZED_APPLY_RULES_JOBS_PATH = "/transactions/uncategorized/apply-rules/jobs"
# API Gateway route path for the unfiled charges grouped by merchant (WHIT-515). "Apply my
# rules" can only file what an existing rule covers; what remains is merchants the user has
# never written a rule for. This walks ALL history and returns those charges grouped by
# merchant, biggest group first, so one decision per merchant clears the tail instead of one
# tap per charge.
UNCATEGORIZED_MERCHANTS_PATH = "/transactions/uncategorized/merchants"
# API Gateway route path for rules suggested from the user's hand-filing habits (WHIT-542). The
# mirror of UNCATEGORIZED_MERCHANTS_PATH pointed at the FILED-by-hand charges: it walks ALL history
# and returns the merchants the user has hand-filed to one category on enough separate days to be
# worth a rule, so "you've filed SEDDONS as Dining 5 times — make a rule?" appears in the file-by-shop
# flow. Read-only; accepting a suggestion is a separate mint request.
FILING_SUGGESTIONS_PATH = "/transactions/filing-suggestions"
# API Gateway route path for the Transactions-tab search over ALL history (WHIT-576). The app
# used to filter only its loaded feed pages, so an older match showed "No matches".
TRANSACTIONS_SEARCH_PATH = "/transactions/search"
# Ceiling on rows one apply-rules request will write. A secondary guard behind the wall-clock
# budget below: the response reports `remaining` and the app says "tap again", which is safe
# because re-running only ever files what is STILL unfiled.
APPLY_RULES_MAX_WRITES = 300
# Wall clock, in seconds, after which the write loop stops and reports `remaining`. API Gateway
# cuts the request off at ~30s while the Lambda keeps running to its own 60s timeout — so
# without this, a slow BankSync read plus a long write run could have the client show a failure
# for rows that were actually filed. Stopping well inside the gateway window keeps the response
# the client sees an honest account of what was written.
APPLY_RULES_TIME_BUDGET_SECONDS = 15
# Default page size for the transactions feed when a request sends no ?limit=. Smaller
# than MAX_PAGE_SIZE: the feed fans out one query PER account per page, so a modest page
# keeps a "Load More" tap cheap while still filling a screen.
FEED_PAGE_SIZE = 30
# Max items accepted by the batch PATCH /transactions endpoint (WHIT-70). The
# route is open and the handler applies updates in a sequential per-item loop, so
# this bounds the work one request can queue. Real sweeps are tiny (uncategorised
# charges in the 7-day feed window), so this only guards against an abusive body.
TRANSACTION_BATCH_MAX = 100

# --- BankSync (balance refresh) --------------------------------------------
# BankSync sits behind Cloudflare, which 403s the default "Python-urllib"
# User-Agent (error 1010). Send our own on every request (matches the
# transaction-trigger lambda, which uses its own "abundo-transaction-trigger").
BANKSYNC_USER_AGENT = "abundo-app-api"

# API Gateway route path for the rule endpoints backed by our own store (WHIT-529).
RULES_PATH = "/rules"

# --- AI spending insights (WHIT-104) ---------------------------------------
# The Anthropic Messages API, called server-side from lambda_api/insights_ai.py
# (urllib + SSM key + custom User-Agent, mirroring the BankSync client). The app
# never holds the key. GET reads the per-cycle cache; POST generates.
INSIGHTS_AI_PATH = "/insights/ai"
ANTHROPIC_API_KEY_PATH = "/abundo/anthropic-api-key"
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
ANTHROPIC_USER_AGENT = "abundo-app-api"
ANTHROPIC_TIMEOUT_SECONDS = 30
# How many PRIOR pay cycles of category spend to include for trend context.
INSIGHTS_PRIOR_CYCLES = 1

# --- Ask Abundo spending chat (card 609) -----------------------------------
# POST starts a chat job (202 + jobId) and async-invokes the chat worker; GET .../jobs/{id}
# is polled by the app. The GET is matched by prefix (the id is a path parameter).
AI_CHAT_PATH = "/ai/chat"
AI_CHAT_JOBS_PATH = "/ai/chat/jobs"
# One chat model call writes tool calls AND the final reply, so it needs more room than
# the one-shot insights call (ANTHROPIC_MAX_TOKENS).
ANTHROPIC_CHAT_MAX_TOKENS = 1500
# The cap on one model call; the real limit is the worker's time left (see ai_chat.run_chat).
ANTHROPIC_CHAT_TIMEOUT_SECONDS = 60
# Worker time kept back from the model calls to check the reply and write the job row.
CHAT_DEADLINE_MARGIN_SECONDS = 10
# With less call time than this left, the worker fails rather than start another model call.
CHAT_MIN_CALL_SECONDS = 10
# Tool rounds per user message; the last round forces the answer, so a loop fails fast.
CHAT_MAX_TOOL_ROUNDS = 6
# Only the most recent messages are sent to the model as context.
CHAT_MAX_MESSAGES = 20
CHAT_MESSAGE_MAX_LEN = 2000
# How far back the chat (and the drill-in date range it links to) may look: the EARLIER of
# this many completed pay cycles and this many completed calendar months.
CHAT_MAX_LOOKBACK_CYCLES = 12
CHAT_MAX_LOOKBACK_MONTHS = 12
# The drill-in date range a chat answer links to reaches this many periods further back than the
# chat itself: the lookback floor moves forward on the 1st of the month and on payday, and without
# the slack a full-year answer's link would 400 once either boundary passed after it was written.
CHAT_LINK_GRACE_PERIODS = 1
# Rows returned by a "list" query: the default, and the most the model may ask for.
CHAT_LIST_DEFAULT = 20
CHAT_LIST_MAX = 200

# WHIT-68: the furthest-back cycle /breakdown will answer for (0 = current, up to N
# cycles prior). A safety bound on how far into the past a single request may reach —
# each request scans exactly ONE length-day window regardless of `cycle`, so the read
# cost is flat; the cap just rejects an absurd/out-of-range ?cycle= with a 400 rather
# than serving it. Kept API-only (the shared spend helper stays constant-free and pure);
# deliberately NOT reusing INSIGHTS_PRIOR_CYCLES so widening the
# AI trend can't silently change the breakdown lookback.
BREAKDOWN_MAX_LOOKBACK = 12

# The (field, operator) pairs a rule may use — MIRRORS shared/rule_engine._FIELD_OPERATORS and MUST
# stay in lockstep with it (WHIT-541). The engine is constants-free, so the two lists are unlinked:
# a pair the validator accepts but the engine can't evaluate silently matches nothing. Widen BOTH
# together.
RULE_FIELD_OPERATORS = {
    "description": frozenset({"contains", "equals"}),
    "merchant": frozenset({"contains", "equals"}),
    "category": frozenset({"equals"}),
    "account": frozenset({"equals"}),
    "amount": frozenset({"less_than", "less_than_or_equal", "greater_than", "greater_than_or_equal"}),
    "direction": frozenset({"is"}),
}
# Derived: every field, and the union of every operator — the legacy single-condition create check
# still validates field/operator independently, then the (field, operator) pair is verified against
# RULE_FIELD_OPERATORS.
RULE_FIELDS = frozenset(RULE_FIELD_OPERATORS)
RULE_OPERATORS = frozenset().union(*RULE_FIELD_OPERATORS.values())
# How a multi-condition rule combines its conditions: "all" = AND, "any" = OR.
RULE_LOGIC = frozenset({"all", "any"})
# The one direction condition's allowed values.
RULE_DIRECTIONS = frozenset({"debit", "credit"})
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

# Icon assigned when a create request omits one (a valid key in src/icons.tsx).
DEFAULT_CATEGORY_ICON = "tag"

# --- Budgets (per-category pay-cycle targets) ------------------------------
# API Gateway route path for the budget-target endpoints (GET all, PUT one).
BUDGET_PATH = "/budgets"

# --- Goals (savings/paydown balance targets, WHIT-231) ---------------------
# API Gateway route path for the goal CRUD endpoints (GET list, PUT one, DELETE one).
GOALS_PATH = "/goals"

# --- Category breakdown (spend by category for the current cycle, WHIT-23) --
# API Gateway route path for the breakdown endpoint (GET only).
BREAKDOWN_PATH = "/breakdown"

# Sentinel category id for the "Uncategorized" bucket in the breakdown response:
# spend that counts to budget but whose category isn't in the taxonomy (a raw
# BankSync enum, a deleted category's dangling id, or null). _slugify strips '_',
# so no real category id can ever collide with this key.
UNCATEGORIZED_KEY = "__uncategorized__"

# Sentinel category id for the total EARNED (all Income-bucket categories) in the
# breakdown response — powers the Insights Earned-vs-Spent chart (WHIT-312). Added only
# when there is income, alongside the per-category spend and __uncategorized__. Like
# UNCATEGORIZED_KEY, the '__' prefix can't collide with any real (slugified) category id.
EARNED_KEY = "__earned__"

# Sentinel key for the PER-SOURCE income breakdown in the breakdown response (WHIT-366):
# {income_category_id: {"posted", "pending"}} for each Income-bucket category that earned
# this cycle — powers the "drill into Earned" screen, which lists each income source (Salary,
# side income, …) under the __earned__ total. Added only when there is income. Like
# UNCATEGORIZED_KEY/EARNED_KEY, the '__' prefix can't collide with a real (slugified) category
# id, and old clients ignore the extra key.
INCOME_KEY = "__income__"

# Sentinel key for the server-owned parent roll-up in the breakdown response (WHIT-349):
# {"nodes": {parent_id: {"posted", "pending"}}} — each budgeted-or-not parent's netted
# subtree spend (aggregate-then-clamp, same fold as /budgets), so the Insights donut reads
# the parent total from here instead of summing per-id-floored leaves on the client (which
# disagreed with /budgets on a net-refunded sub). Added only when a parent has spend. Like
# UNCATEGORIZED_KEY/EARNED_KEY, the '__' prefix can't collide with a real category id, and
# old clients ignore the extra key.
ROLLUP_KEY = "__rollup__"

# --- Loan facts (user-entered home-loan inputs) ----------------------------
# API Gateway route path for the loan-facts endpoints (GET current, PUT to set).
# The user enters facts no bank feed provides (original amount, property value,
# LVR, rate, scheduled + extra repayment); GET returns null fields until saved.
LOANFACTS_PATH = "/loanfacts"

# Upper bound for the dollar-amount fields (original / homeValue / baseRepay /
# extra). Same ceiling as budget targets — a sanity guard, not a real limit.
LOANFACTS_FIELD_MAX = 1_000_000_000

# --- Milestones (user-owned mortgage-paydown plan, WHIT-375) ----------------
# API Gateway route path for the milestone endpoints (GET list, PUT whole list).
MILESTONES_PATH = "/milestones"

# --- Home loan (live mortgage balance, WHIT-8) -----------------------------
# API Gateway route path for the home-loan balance endpoint (GET only). The
# balance-poller lambda writes the row; this read API serves it to the app.
HOMELOAN_PATH = "/homeloan"

# --- Account balances (live per-account balance, WHIT-212) -----------------
# API Gateway route path for the per-account balances endpoint (GET only). The
# balance-poller writes one signed-balance row per account; this read API serves them
# to the Accounts tab.
ACCOUNT_BALANCES_PATH = "/accounts/balances"
# API Gateway route path for the on-demand live balance refresh (POST). A pull-to-refresh
# calls it to fetch fresh balances from BankSync now (throttled), rather than re-reading the
# once-a-day poller's stored values.
ACCOUNT_BALANCES_REFRESH_PATH = "/accounts/balances/refresh"
# Short per-account BankSync timeout for the interactive refresh: the accounts are fetched
# concurrently, so worst-case wall time is ~this, kept well under the 30s API-Gateway
# integration cap (the daily poller uses the longer HOMELOAN_BALANCE_TIMEOUT_SECONDS).
REFRESH_FETCH_TIMEOUT_SECONDS = 10
# Min seconds between live refreshes: a pull within this window returns the stored balances
# with no bank call (protects against cost + BankSync rate-limits on repeated pulls).
REFRESH_THROTTLE_SECONDS = 60

# --- Last repayment (WHIT-115) ---------------------------------------------
# API Gateway route path for the latest home-loan repayment (GET only). Reads
# the full up-homeloan history (not the 7-day feed) since repayments are ~monthly.
REPAYMENT_PATH = "/repayment"

# Interest posts as a separate BANK_FEES debit on the up-homeloan account. When one
# falls in the same calendar month as the repayment, principal = repayment - |interest|.
INTEREST_CATEGORY = "BANK_FEES"

# --- Pay cycle (persisted length + payday last_pay_date) --------------------------
# API Gateway route path for the pay-cycle endpoints (GET current, PUT to set).
PAYCYCLE_PATH = "/paycycle"

# --- Device push-token registration (POST /devices) ------------------------
# API Gateway route path for registering an Expo push token. Gated behind the
# shared-secret authorizer (like the other mutating routes): it controls who
# receives the user's notifications, so it is NOT left open like the read routes.
DEVICES_PATH = "/devices"
# Upper bound on an accepted Expo push token's length — a sanity guard, not a real
# limit (a real ExpoPushToken[...] value is ~40 chars).
EXPO_TOKEN_MAX_LEN = 256

# Cycle lengths (days) the client offers: Weekly / Fortnightly / Monthly. A PUT
# with any other length is rejected 400 — the window math assumes one of these.
PAYCYCLE_LENGTHS = frozenset({7, 14, 30})
