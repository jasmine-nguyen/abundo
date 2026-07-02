# Maps BankSync account ids to whittle's internal account ids.
ACCOUNT_ID_MAP = {
    "9h2FO6S58zunrwF3U3MhBoaEQNDDfqVlEC5bLSWNdN0": "anz-rewards-black-visa",
    "3zVQJ8Btz_IRmqp78VrQnQ": "up-spending",
    "T6d8ppsYssBDFCwl1qEb0w": "up-homeloan",
}

# SSM SecureString path holding the BankSync REST API key (read by whittle-sync-trigger).
BANKSYNC_API_KEY_PATH = "/whittle/banksync-api-key"

# Base URL for the BankSync REST API.
BANKSYNC_BASE_URL = "https://api.banksync.io"

# Lookback window, in days, used when requesting a feed's transactions.
FEED_WINDOW_DAYS = 5

# Maximum number of items requested per DynamoDB query page.
MAX_PAGE_SIZE = 100

# Status value marking a transaction as not yet posted.
PENDING_STATUS = "pending"

# BankSync feeds triggered on every scheduled sync run, keyed by feed id -> label.
SYNC_FEED_IDS = {
    "xXkBR72EKo4Qxkz8667l": "spending-anz",
    "LwO4ZvpH5SMBhEkAO2br": "up-homeloan",
}

# HTTP timeout, in seconds, for a single sync-trigger request to BankSync.
SYNC_TIMEOUT_SECONDS = 30

# API Gateway route path for the read API that the whittle app calls.
TRANSACTION_PATH = "/transactions"

# --- Categories (user-defined taxonomy) ------------------------------------
# API Gateway route path for the category CRUD endpoints.
CATEGORY_PATH = "/categories"

# Allowed spending buckets (mirrors the client Bucket union in src/context.tsx).
CATEGORY_BUCKETS = {"Living", "Lifestyle", "Income", "Savings"}

# Icon assigned when a create request omits one (a valid key in src/icons.tsx).
DEFAULT_CATEGORY_ICON = "tag"

# Colours assigned to newly created categories (ported from PALETTE in context.tsx).
CATEGORY_PALETTE = [
    "#E8A87C", "#7FD49B", "#F08C8C", "#8AB4F8", "#F2A0C9",
    "#C7A8F0", "#F2C94C", "#6FD0C9", "#8FD46B", "#B0A8F0",
]

# Seed taxonomy written on first read, keyed by slug id. Ids are the curated
# slugs from src/context.tsx SEED_CATS, preserved verbatim because they are the
# vocabulary BankSync enrichment rules and client budgets/rules reference.
# `recent` is intentionally omitted (client-derived).
SEED_CATEGORIES = {
    "coffee": {"id": "coffee", "name": "Cafes & Coffee", "icon": "coffee", "color": "#E8A87C", "bucket": "Lifestyle"},
    "groceries": {"id": "groceries", "name": "Groceries", "icon": "cart", "color": "#7FD49B", "bucket": "Living"},
    "eatingout": {"id": "eatingout", "name": "Eating Out", "icon": "food", "color": "#F08C8C", "bucket": "Lifestyle"},
    "transport": {"id": "transport", "name": "Transport", "icon": "car", "color": "#8AB4F8", "bucket": "Living"},
    "health": {"id": "health", "name": "Health", "icon": "health", "color": "#F2A0C9", "bucket": "Living"},
    "pets": {"id": "pets", "name": "Pets", "icon": "pets", "color": "#C7A8F0", "bucket": "Lifestyle"},
    "utilities": {"id": "utilities", "name": "Utilities", "icon": "bolt", "color": "#F2C94C", "bucket": "Living"},
    "shopping": {"id": "shopping", "name": "Shopping", "icon": "bag", "color": "#6FD0C9", "bucket": "Lifestyle"},
    "fitness": {"id": "fitness", "name": "Health & Fitness", "icon": "dumbbell", "color": "#8FD46B", "bucket": "Lifestyle"},
    "subs": {"id": "subs", "name": "Subscriptions", "icon": "film", "color": "#F0B27A", "bucket": "Lifestyle"},
    "travel": {"id": "travel", "name": "Travel", "icon": "plane", "color": "#6FB6D0", "bucket": "Lifestyle"},
    "gifts": {"id": "gifts", "name": "Gifts", "icon": "gift", "color": "#E59BD0", "bucket": "Lifestyle"},
    "phonenet": {"id": "phonenet", "name": "Phone & Internet", "icon": "phone", "color": "#B0A8F0", "bucket": "Living"},
}
