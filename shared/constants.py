from decimal import Decimal

# Maps BankSync account ids to abundo's internal account ids.
ACCOUNT_ID_MAP = {
    "9h2FO6S58zunrwF3U3MhBoaEQNDDfqVlEC5bLSWNdN0": "anz-rewards-black-visa",
    "3zVQJ8Btz_IRmqp78VrQnQ": "up-spending",
    "T6d8ppsYssBDFCwl1qEb0w": "up-homeloan",
    "A3AC9195-9E8D-48B8-86D0-46D130D7F64A": "westpac-altitude-qantas-black",
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
# from Spending" varies).
REPAYMENT_INCOMING_TYPE = "TRANSFER_INCOMING"

# Minimum home-loan repayment amount (dollars) that fires a push (WHIT-15). The real
# Up feed carries tiny "OHA test" repayments ($1/$2/$5); this floor skips them. A
# plain int; `Decimal(amount) >= 10` compares cleanly.
MIN_REPAYMENT_NOTIFY = 10

# Raw BankSync categories that are transfers/loan movements between the user's OWN
# accounts (own-account transfers, investments, card payments, home-loan repayments) —
# not discretionary spend, so they don't count toward a spending budget (WHIT-50).
# INCOME is deliberately NOT here: income is left counting so earn-targets can use it.
# Confirmed against real Up data (2026-07-03).
NON_BUDGET_CATEGORIES = {"TRANSFER_IN", "TRANSFER_OUT", "LOAN_PAYMENTS"}

# SSM SecureString path holding the BankSync REST API key (read by abundo-transaction-trigger).
BANKSYNC_API_KEY_PATH = "/abundo/banksync-api-key"

# Base URL for the BankSync REST API.
BANKSYNC_BASE_URL = "https://api.banksync.io"

# Lookback window, in days, used when requesting a feed's transactions.
FEED_WINDOW_DAYS = 7

# Settlement window, in days, after which a still-pending transaction is reaped as a
# ghost that will never settle (WHIT-79). Measured from the bank `date` (the only age
# signal on a stored row — there is no ingest timestamp). Set safely PAST FEED_WINDOW_DAYS
# (7): BankSync stops re-sending a transaction after that window, so a pending older than
# 10 days can no longer receive a settlement push — it is genuinely frozen.
PENDING_AGE_OUT_DAYS = 10

# WHIT-511: how far apart a filed pending and its settled twin may be dated and still have the
# user's filing carried across. Deliberately TIGHTER than FEED_WINDOW_DAYS (7): the carry moves
# a user's category, so it must be strict — a symmetric ±3 days is generous for the usual
# swipe→settle lag while keeping a coincidental same-amount charge from being swept in. The
# accepted cost is a twin that settled 4–7 days after the swipe is not matched.
CARRY_DATE_SKEW_DAYS = 3

# How long the "deleted by you" marker for a user-deleted transaction lives (WHIT-654). Must stay
# well past FEED_WINDOW_DAYS so a BankSync re-send can't bring the deleted charge back.
DELETED_TRANSACTION_TTL_SECONDS = 30 * 24 * 3600

# Maximum number of items requested per DynamoDB query page.
MAX_PAGE_SIZE = 100

# Page ceiling for one account's date-range read. 1000 × MAX_PAGE_SIZE is far beyond any
# real window, so hitting it means the cursor isn't advancing.
DATE_RANGE_MAX_PAGES = 1000

# The bucket whose category targets are earn-targets (floors, over-is-good) rather
# than spend ceilings (WHIT-69). A budget on an Income-bucket category rolls up the
# POSITIVE earnings for the cycle instead of spend.
INCOME_BUCKET = "Income"

# The bucket whose categories cannot carry a budget target at all (WHIT-202). A Savings
# category is a non-spend goal, not a pay-cycle ceiling/floor, so the client refuses to
# render a target on it (budgetViews/budgetDetail skip Savings) — a stored one would be an
# invisible, un-editable phantom. set_budget rejects a direct write and update_category
# rejects re-bucketing a still-budgeted category into Savings.
SAVINGS_BUCKET = "Savings"

# Status value marking a transaction as not yet posted.
PENDING_STATUS = "pending"

# Status value marking a settled transaction.
POSTED_STATUS = "posted"

# Retention window for a budget-alert debounce marker (WHIT-22). Written as a
# DynamoDB TTL (epoch-seconds `expires_at`) so a marker self-cleans after its cycle
# instead of accumulating. 60 days — comfortably longer than the max 30-day cycle
# (a new cycle re-arms via a fresh pk, so the marker only needs to outlive its own).
NOTIFY_TTL_SECONDS = 60 * 24 * 60 * 60

# A finished background job is only useful while the app polls it, so it self-deletes a day
# later via DynamoDB TTL (WHIT-537).
JOB_TTL_SECONDS = 24 * 60 * 60

# A stashed push-receipt id self-expires after ~24h — Expo retains receipts about that long,
# so an id the sweep never resolves is reaped by TTL (WHIT-139).
RECEIPT_TTL_SECONDS = 24 * 60 * 60

# Missed-repayment alarm backstop (WHIT-316). The direct Up webhook is the sole home-loan
# repayment notifier now, so the daily balance poll double-checks it: if the mortgage
# balance dropped like a repayment landed but no push fired recently, it logs an alarmed
# line. REPAYMENT_DROP_THRESHOLD — a one-poll drop this large means a repayment landed
# (well below a monthly repayment, above fee/rounding noise). REPAYMENT_MISS_LOOKBACK_DAYS
# — how recent the last push must be to count as healthy; sits between the max bank-feed
# lag (a few days) and the ~monthly repayment gap. Used only by
# lambda_balance_poller/handler.py.
REPAYMENT_DROP_THRESHOLD = Decimal("3000")
REPAYMENT_MISS_LOOKBACK_DAYS = 7

# Maximum fraction by which a settled (posted) charge may exceed its pending
# authorisation and still be reconciled as the SAME purchase — i.e. a tip added at
# settlement (restaurants/delivery/rideshare). ONE-DIRECTIONAL: a tip only makes
# spend larger, so a smaller (or opposite-sign, e.g. a refund) settled amount is
# never a tip-match. Used by the reconciler's tip-adjusted tier (WHIT-116).
# +25% = a generous but bounded tip.
TIP_HEADROOM = Decimal("0.25")

# Days by which ANZ's PENDING record post-dates its own settled twin's swipe date
# (WHIT-331). The two records are rendered off different clocks: the pending carries the
# Melbourne-local day, the settled one the UTC day. Melbourne is UTC+10/+11, so a purchase
# swiped before 10:00 local falls on the PREVIOUS day in UTC and the two dates disagree by
# exactly one — always in that direction, never the reverse. The reconciler's exact and tip
# tiers both key on an equal authorized_date, so without a skew-tolerant tier the twins
# never match and the purchase is counted twice. Used only by lambda/reconcile.py.
AUTH_DATE_SKEW_DAYS = 1

# Maximum fraction by which a settled charge may exceed a pending dated AUTH_DATE_SKEW_DAYS
# later and still be the SAME purchase (WHIT-653): a Westpac overseas charge settles a day
# earlier with the foreign fee (~3%) folded in. ONE-DIRECTIONAL, like TIP_HEADROOM.
# Used only by lambda/reconcile.py.
SKEW_FEE_HEADROOM = Decimal("0.05")

# Seed pay cycle used by PayCycleRepository until the user sets their real payday:
# a fixed past date (a Wednesday, the app's original default last_pay_date) + a
# fortnightly length.
DEFAULT_PAYCYCLE = {"length": 14, "last_pay_date": "2024-01-03"}

# BankSync feeds triggered on every scheduled sync run, keyed by feed id -> label.
SYNC_FEED_IDS = {
    "ZDlL4aShYkOd8A3dw8Tb": "up-spending",
    "LwO4ZvpH5SMBhEkAO2br": "up-homeloan",
    "zJiG0SNKKWScMp9bFdD4": "westpac-altitude-qantas-black",
}

# HTTP timeout, in seconds, for a single sync-trigger request to BankSync.
SYNC_TIMEOUT_SECONDS = 30

# Accounts whose stored pendings the hourly sync trigger mirrors against BankSync's full
# transaction list, deleting pendings the bank no longer lists (WHIT-662). ANZ is closed and
# the home loan has no pendings, so both are out of scope.
PENDING_MIRROR_SOURCES = [
    {"bid": "fiskil_77", "aid": "A3AC9195-9E8D-48B8-86D0-46D130D7F64A"},  # westpac-altitude-qantas-black
    {"bid": "fiskil_3", "aid": "3zVQJ8Btz_IRmqp78VrQnQ"},                 # up-spending
]
assert all(s["aid"] in ACCOUNT_ID_MAP for s in PENDING_MIRROR_SOURCES), (
    "every PENDING_MIRROR_SOURCES `aid` must be a key in ACCOUNT_ID_MAP"
)

# Extra days the mirror's bank-list fetch reaches back beyond FEED_WINDOW_DAYS: BankSync filters
# on the booking date, which can trail the swipe date we store.
PENDING_MIRROR_FETCH_MARGIN_DAYS = 3

# Page ceiling for one account's bank-list fetch. Also bounds requests against BankSync's
# 10-a-minute limit.
PENDING_MIRROR_MAX_PAGES = 3

# More missing pendings than this in one account looks like a partial bank list, not real drops,
# so the mirror deletes nothing for that account.
PENDING_MIRROR_MAX_REMOVALS = 10

# HTTP timeout, in seconds, for one bank-list page request.
PENDING_MIRROR_TIMEOUT_SECONDS = 10

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
# outstanding-principal row. Also enumerated by the API's live balance refresh.
BALANCE_SOURCES = [
    {"bid": "fiskil_3", "aid": "3zVQJ8Btz_IRmqp78VrQnQ"},                       # up-spending
    {"bid": "fiskil_3", "aid": "T6d8ppsYssBDFCwl1qEb0w"},                       # up-homeloan
    {"bid": "fiskil_4", "aid": "9h2FO6S58zunrwF3U3MhBoaEQNDDfqVlEC5bLSWNdN0"},  # anz-rewards-black-visa
    {"bid": "fiskil_77", "aid": "A3AC9195-9E8D-48B8-86D0-46D130D7F64A"},        # westpac-altitude-qantas-black
]
# Drift guard (mirrors the HOMELOAN_ACCOUNT_ID assert): a source whose aid isn't mapped
# would store a balance under a raw id the app can never join to an account. Fail at import
# rather than silently polling a balance nothing displays.
assert all(s["aid"] in ACCOUNT_ID_MAP for s in BALANCE_SOURCES), (
    "every BALANCE_SOURCES `aid` must be a key in ACCOUNT_ID_MAP"
)

# --- Bank-feed stall alert (WHIT-606) ----------------------------------------
# The balance poller pushes an alert when a watched account's balance has moved but no new
# transaction has arrived for FEED_STALL_DAYS (22-25 Sept 2026: BankSync went quiet for 3
# days while the Westpac balance kept moving, and nobody noticed). The home loan is NOT
# watched: interest moves its balance with no transaction, so it would false-alarm.
FEED_STALL_ACCOUNT_IDS = ("up-spending", "westpac-altitude-qantas-black", "anz-rewards-black-visa")
FEED_STALL_DAYS = 3
# How far back (by bank date) the poller reads transaction ids to spot a new one. Past
# FEED_WINDOW_DAYS so every BankSync re-send lands inside it and is recognised as seen.
FEED_STALL_LOOKBACK_DAYS = 14
# An account missing from BALANCE_SOURCES never gets a fresh balance, so it would silently
# never be checked. Fail at import instead.
assert set(FEED_STALL_ACCOUNT_IDS) <= {ACCOUNT_ID_MAP[s["aid"]] for s in BALANCE_SOURCES}, (
    "every FEED_STALL_ACCOUNT_IDS entry must be a polled BALANCE_SOURCES account"
)
assert HOMELOAN_ACCOUNT_ID not in FEED_STALL_ACCOUNT_IDS, "the home loan must not be stall-watched"

# --- Budget rollover (envelope carryover) -----------------------------------
# A completed pay cycle's leftover is SEALED into the stored carryover balance only
# once the cycle ended at least this many days ago. Transactions keep moving (pendings
# settle, refunds land) for a while after their date, so sealing sooner would bake in
# a spend figure that later changes. Kept equal to PENDING_AGE_OUT_DAYS; a test asserts
# lockstep. Shared so both the /budgets read (lambda_api) and the budget-alert webhook
# path can seal/compute the live buffer identically.
ROLLOVER_SETTLE_LAG_DAYS = 10

# Upper bound on how many completed cycles one read folds. Bounds a first-open-after-a-
# long-gap read; older leftovers are dropped and the anchor jumps forward.
ROLLOVER_MAX_LOOKBACK_CYCLES = 12

# How many pay cycles a bill spread may be paid back over (WHIT-504). 1 = the whole bill next
# cycle; 24 ≈ a year of fortnights. Shared (WHIT-559) so a rule auto-spreading a bill can convert a
# cadence to a cycles count on BOTH the webhook and the sweep, and by the API's PUT
# /budgets/{category}/spread validation.
SPREAD_MIN_CYCLES = 1
SPREAD_MAX_CYCLES = 24

# Retention window for FAILED# dead-letter items (WHIT-54). Written as a DynamoDB
# TTL (epoch-seconds `expires_at`), so a stuck row auto-expires instead of
# accumulating forever — long enough to notice + reprocess (see the recovery
# lambda, WHIT-55), short enough not to pile up. 30 days.
DEAD_LETTER_TTL_SECONDS = 30 * 24 * 60 * 60

# --- Rules -------------------------------------------------------------------
# The (field, operator) pairs a rule may use — the one home for the rule vocabulary (WHIT-608).
# The rule engine evaluates them and the API validates requests against them, so the two can't
# drift. The client copy (src/ruleVocabulary.ts) is guarded by Jest.
#   description/merchant: `contains` (substring) + `equals` (exact, folded).
#   category: `equals` — a raw-enum mapping (FOOD_AND_DRINK -> groceries) for rules made outside
#             the app; unfiled rows carry raw enums, so it is worth honouring when present.
#   account: `equals` against the internal account_id.
#   amount: `less_than`/`less_than_or_equal`/`greater_than`/`greater_than_or_equal` a plain positive
#           dollar value, compared to the charge's MAGNITUDE (abs) — spend is stored negative, so
#           "under $30" means abs(amount) < 30.
#   direction: `is` "debit" (spend, amount < 0) / "credit" (income, amount > 0).
RULE_FIELD_OPERATORS = {
    "description": frozenset({"contains", "equals"}),
    "merchant": frozenset({"contains", "equals"}),
    "category": frozenset({"equals"}),
    "account": frozenset({"equals"}),
    "amount": frozenset({"less_than", "less_than_or_equal", "greater_than", "greater_than_or_equal"}),
    "direction": frozenset({"is"}),
}
# Derived: every field, and the union of every operator.
RULE_FIELDS = frozenset(RULE_FIELD_OPERATORS)
RULE_OPERATORS = frozenset().union(*RULE_FIELD_OPERATORS.values())
# How a multi-condition rule combines its conditions: "all" = AND, "any" = OR.
RULE_LOGIC = frozenset({"all", "any"})
# The one direction condition's allowed values.
RULE_DIRECTIONS = frozenset({"debit", "credit"})
