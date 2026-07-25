import boto3
from datetime import date, datetime, timezone
from decimal import Decimal
import json
import logging
import re
import uuid
from botocore.exceptions import ClientError
from boto3.dynamodb.conditions import Attr, Key
from typing import Any, NoReturn, Optional
from merchant import clean_merchant
from models import Transaction
from constants import (
    AUTH_DATE_SKEW_DAYS,
    DEAD_LETTER_TTL_SECONDS,
    FEED_WINDOW_DAYS,
    PENDING_STATUS,
    TIP_HEADROOM,
)
from repository_errors import DatabaseError

REGION_NAME = "ap-southeast-2"
RESOURCE_NAME = "dynamodb"
TABLE_NAME = "abundo-dynamodb-table"

logger = logging.getLogger(__name__)
# The Text-format Lambda runtime leaves the root logger at WARNING, so INFO logs are
# dropped unless we opt in — matching lambda/handler.py.
logger.setLevel(logging.INFO)


def handle_database_error(e: ClientError, action: str) -> NoReturn:
    """Logs an AWS client error and re-raises it as a DatabaseError (WHIT-127)."""
    error_code = e.response["Error"]["Code"]
    error_message = e.response["Error"]["Message"]
    print(f"DynamoDB Error [{error_code}]: {error_message}")
    raise DatabaseError(f"Database {action} failed: {error_message}") from e


def sanitise_transaction(txn: Transaction) -> dict[str, Any]:
    """Strips out unassigned None properties to keep DynamoDB documents sparse."""
    return {k: v for k, v in txn.items() if v is not None}


def _build_pk(account_id: str) -> str:
    return f"ACCOUNT#{account_id}"


def _build_sk(transaction_id: Optional[str]) -> str:
    return f"TXN#{transaction_id}"


_WORD = re.compile(r"[a-z0-9]+")


def _words(s: Optional[str]) -> list[str]:
    """Lowercase alphanumeric words of a string. BankSync descriptor noise
    ('POS AUTHORISATION', 'DD *', country/store codes) splits out on the
    non-alphanumeric boundaries, leaving comparable merchant words."""
    return _WORD.findall((s or "").lower())


def _merchant_in_description(merchant: str, description: str) -> bool:
    """Whether every word of `merchant` appears as a CONSECUTIVE run inside
    `description`'s words. Word-level (not raw substring) so a short or adjacent
    token can't over-match: 'coles' is NOT a word in "nicole's cafe", 'bp' is NOT a
    word in 'bpay' — while a multi-word merchant ('DOORDASH XUANBANHC') still matches
    a pending's raw "POS AUTHORISATION  DD *DOORDASH XUANBANHC ..." description.
    Empty merchant -> False (never over-match on an underivable token)."""
    m = _words(merchant)
    if not m:
        return False
    d = _words(description)
    return any(d[i:i + len(m)] == m for i in range(len(d) - len(m) + 1))


# An ANZ PENDING descriptor: the "POS AUTHORISATION" column, then padding before the
# merchant column. The padding group matches whatever the bank actually sent rather than
# pinning today's nine spaces — the slice below is taken RELATIVE to where this match
# ends, so a padding change shifts the cut with it instead of misaligning it, up to the
# column width (past that a run of padding is indistinguishable from a blank column, and
# the guard below stops reading rather than guess).
# The `{2,}` is load-bearing SAFETY, not parsing convenience: one space is not column
# padding, and treating it as such would route a real ANZ row to the looser gate below.
_ANZ_PENDING_PREFIX = re.compile(r"^POS AUTHORISATION(?P<pad>\s{2,})", re.IGNORECASE)
# Width of ANZ's fixed-width merchant column on a PENDING description, measured against
# live data (every pending in the table reconstructs as: 25-wide merchant, 13-wide
# suburb, then "AU"). NOT the same as the POSTED `merchantName` field, which is 26 wide,
# so ANY merchant whose name runs to 26 characters or more is cut at a different point on
# the two sides and can never match. That is the safe direction (a leftover duplicate the
# age-out sweep reaps), never a wrong merge.
_MERCHANT_COLUMN_WIDTH = 25


def _pending_merchant_column(description: Optional[str]) -> Optional[str]:
    """ANZ's fixed-width merchant column, sliced out of a PENDING description by
    POSITION — the whole point being that position survives what whitespace cannot.

    `clean_merchant` reads the same column by splitting on runs of 2+ spaces, which
    fails exactly when the merchant FILLS the column: it then runs into the suburb with
    no separator ("SQ *KKV INTERNATIONAL PTY" + "Sunshine" -> "PTYSunshine"), and the
    stored merchant name is corrupt. A positional slice is immune to that.

    None when the description is not an ANZ pending descriptor (an Up row, or a legacy
    row) or when the column is blank — both must fall through to the name-based gate,
    never merge on nothing."""
    text = description or ""
    prefix = _ANZ_PENDING_PREFIX.match(text)
    if prefix is None:
        return None
    # A blank merchant column is indistinguishable from padding, so the greedy match runs
    # straight through it and the slice would start at the SUBURB — handing back a suburb
    # as if it were a merchant, which is the direction that deletes a row. Padding as wide
    # as the column itself is that case, and there is no merchant to read.
    if len(prefix.group("pad")) >= _MERCHANT_COLUMN_WIDTH:
        return None
    column = text[prefix.end():prefix.end() + _MERCHANT_COLUMN_WIDTH]
    return column if column.strip() else None


def _same_cleaned_merchant(posted_merchant: str, pending_merchant: str) -> bool:
    """Whether two ALREADY-cleaned merchant names refer to the same merchant. Inputs
    must have been through `clean_merchant` — banksync.normalise writes both sides that
    way — because this does NOT clean them: "COLES 0602" and "COLES" do NOT match. Only
    padding and casing are absorbed. An empty name on either side never matches.

    NOTE this is chain-wide, not storefront-wide: clean_merchant strips trailing store
    numbers and processor prefixes, so COLES 0602 and COLES 1157 are both "COLES", and
    "AMAZON RETA* AMAZON AU" and "AMAZON AU" are both "AMAZON"."""
    posted_words = _words(posted_merchant)
    return bool(posted_words) and posted_words == _words(pending_merchant)


def _merchant_matches_pending(merchant: str, pending_merchant: str, description: str) -> bool:
    """Whether a posted merchant names the same shop as a pending row (WHIT-336).

    Shared by every heuristic tier that matches on a merchant — tip, skewed-date and
    blank-auth. They MUST share it. The tiers run tightest-first so a tighter tier always
    claims its twin before a looser one can reach it, and that ordering silently inverts
    if one tier can recognise a merchant the tiers above it cannot: the loosest tier then
    wins by default and deletes the wrong pending.

    An ANZ pending carries its merchant in a fixed-width column, so for those rows we
    read that column by position and require the two CLEANED names to be EQUAL. Equality,
    not containment: "CHEMIST WAREHOUSE" is contained in "CHEMIST WAREHOUSE DARLING", and
    those are two different stores — merging them would delete a real transaction. The
    same trap catches "McDonalds" inside "MCDONALDS SYD DOMEST" and "WOOLWORTHS" inside
    "WOOLWORTHS/330 MILLERS RD"; all three pairs are live in the table.

    Equality also replaces the prefix-tolerant matcher this used to need. That tolerance
    existed only for ANZ's column fusion, which a positional slice now removes at the
    source, and it was itself over-matching on name prefixes.

    Non-ANZ descriptions (Up rows, legacy rows) have no such column and keep the shape of
    the gate they had — two-or-more words matched against the raw description, a lone word
    additionally requiring the pending's own cleaned name to be that same word. The
    multi-word branch does lose WHIT-331's prefix tolerance along with everything else,
    which costs nothing: column fusion only happens on ANZ rows, and the loss is a miss.
    Do NOT tighten this fallback to name equality — on the live table (queried 2026-07-25)
    75 rows carry an empty merchant_name, none of them ANZ-shaped, and 108 pairs that
    reconcile today would silently stop.

    Known accepted miss: two descriptors for one merchant ("PET INSURANCE" /
    "PET INSURANCE PAYMENT", both live on 2026-07-25) do not match. Recurring direct
    debits rarely raise a card pending, and the failure direction is a leftover duplicate
    that the age-out sweep reaps — never a wrong merge.

    Deliberately NOT the fuzzy scorer the client uses for "apply to all"
    (src/context.tsx matchesRulePattern): that is tuned for recall, and on short names
    it scores COLES/MOLES at 0.80 — over its own threshold. Mis-sweeping a category is
    undoable; deleting a pending is not. Do not unify the two."""
    if _ANZ_PENDING_PREFIX.match(description or ""):
        column = _pending_merchant_column(description)
        # An ANZ row with no readable column has nothing to compare, so it must REFUSE.
        # Falling through to the gates below would hand the row to a containment search
        # over the whole description — suburb included — and a merchant named after a
        # place would match it. "Unreadable" is not "not ANZ".
        return column is not None and _same_cleaned_merchant(merchant, clean_merchant(column))
    if len(_words(merchant)) >= 2:
        return _merchant_in_description(merchant, description)
    return (_same_cleaned_merchant(merchant, pending_merchant)
            and _merchant_in_description(merchant, description))


def _is_skewed_next_day(pending_date: Optional[str], posted_date: Optional[str]) -> bool:
    """Whether `pending_date` sits exactly AUTH_DATE_SKEW_DAYS after `posted_date` — the
    signature of one purchase reported off two clocks (WHIT-331): ANZ dates the pending
    record in Melbourne-local time and the settled one in UTC, so a purchase swiped
    before 10:00 local reads a day earlier once settled.

    One-directional on purpose. Melbourne is UTC+10/+11, so the local day is always the
    same as, or one AHEAD of, the UTC day — never behind. Accepting a pending dated
    earlier than its posting would admit a whole extra class of false match for a skew
    the clocks cannot produce. Both are bare "YYYY-MM-DD"; missing or unparseable is
    never a skew."""
    if not pending_date or not posted_date:
        return False
    try:
        pending_day = date.fromisoformat(pending_date[:10])
        posted_day = date.fromisoformat(posted_date[:10])
    except ValueError:
        return False
    return (pending_day - posted_day).days == AUTH_DATE_SKEW_DAYS


def _is_tip_adjusted(auth_amount: Decimal, settled_amount: Decimal) -> bool:
    """Whether `settled_amount` is `auth_amount` plus at most a tip (TIP_HEADROOM).
    Both must be spend (negative) and ONE-DIRECTIONAL — a tip only makes the
    magnitude larger — so a smaller settled amount, or an opposite-sign one (a
    refund/credit), is never a tip-match."""
    if auth_amount >= 0 or settled_amount >= 0:
        return False
    auth_mag = -auth_amount
    settled_mag = -settled_amount
    return auth_mag <= settled_mag <= auth_mag * (Decimal(1) + TIP_HEADROOM)


def _settles_after(pending_date: Optional[str], posted_date: Optional[str]) -> bool:
    """Whether `pending_date` could be the swipe day of a charge that settled on
    `posted_date`: same day or up to FEED_WINDOW_DAYS earlier. Used only by the
    blank-authorized_date twin tier, where there is no exact date key to match on, so
    a bounded window keeps a coincidental same-amount pending from being swept in. Both
    are bare "YYYY-MM-DD"; an unparseable/missing value is treated as out-of-window."""
    if not pending_date or not posted_date:
        return False
    try:
        pd = date.fromisoformat(pending_date[:10])
        qd = date.fromisoformat(posted_date[:10])
    except ValueError:
        return False
    return 0 <= (qd - pd).days <= FEED_WINDOW_DAYS


class TransactionRepository:
    def __init__(self) -> None:
        self._dynamodb = None
        self._table = None

    def _get_table(self):
        """Lazy-loads and buffers the connection to the physical DynamoDB table resource."""
        if self._table is None:
            self._dynamodb: Any = boto3.resource(RESOURCE_NAME, region_name=REGION_NAME)
            self._table = self._dynamodb.Table(TABLE_NAME)
        return self._table

    def insert_transactions(self, transactions: list[Transaction]) -> None:
        """Inserts multiple transactions efficiently using DynamoDB Batch Write."""

        if not transactions:
            return
        items = []

        for transaction in transactions:
            # Ensure each transaction has the correct DynamoDB schema keys
            item = {
                "pk": _build_pk(transaction["account_id"]),
                "sk": _build_sk(transaction["transaction_id"]),
                **sanitise_transaction(transaction),
            }
            items.append(item)

        self._batch_put(items, "batch_write")

    def save_failed_transactions(self, failed_transactions: list[dict]) -> None:
        """Inserts failed transactions using DynamoDB Batch Write."""

        if not failed_transactions:
            return

        items = []
        for transaction in failed_transactions:
            now = datetime.now(timezone.utc)
            item = {
                "pk": "FAILED",
                # A uuid disambiguates two failures written in the same microsecond,
                # whose isoformat timestamps would otherwise collide and overwrite
                # each other (WHIT-84) — matches shared/repository_transaction.py.
                "sk": f"{now.isoformat()}#{uuid.uuid4()}",
                "raw": json.dumps(transaction),
                # failed_at: readable "how long stuck". expires_at: DynamoDB TTL
                # (epoch seconds) so old dead-letter rows auto-expire (WHIT-54).
                "failed_at": now.isoformat(),
                "expires_at": int(now.timestamp()) + DEAD_LETTER_TTL_SECONDS,
            }
            items.append(item)
        self._batch_put(items, "save_failed_transactions")

    def _batch_put(self, items: list[dict], action: str) -> None:
        if not items:
            return
        try:
            table = self._get_table()
            with table.batch_writer() as batch:
                for item in items:
                    batch.put_item(Item=item)
        except ClientError as e:
            handle_database_error(e, action)

    def get_transaction(self, pk: str, sk: str) -> Optional[dict[str, Any]]:
        """Retrieves a single record document. Returns None if it is missing."""
        try:
            response = self._get_table().get_item(Key={"pk": pk, "sk": sk})
            # Absent is a normal result — the reconcile paths read here to check for an
            # existing row on every pending/posted re-send, so a miss is the common
            # first-sight case, not something to log (WHIT-329).
            return response.get("Item") or None
        except ClientError as e:
            handle_database_error(e, "read")

    def get_pending_transactions_for_account(self, account_id: str) -> list[dict]:
        """Retrieves all pending transactions of an account using the account_id.

        Follows pagination (WHIT-82): DynamoDB caps a query at 1MB per page and the
        ``status == pending`` FilterExpression is applied AFTER that scan, per page.
        Reading only the first page would leave a pending row that sits beyond it
        invisible to reconciliation — a silent duplicate + lost category, no error.
        So we loop on LastEvaluatedKey and accumulate across every page.
        """
        try:
            table = self._get_table()
            key_condition = Key("pk").eq(_build_pk(account_id))
            items: list[dict] = []
            start_key = None
            while True:
                kwargs = {
                    "KeyConditionExpression": key_condition,
                    "FilterExpression": Attr("status").eq(PENDING_STATUS),
                }
                if start_key is not None:
                    kwargs["ExclusiveStartKey"] = start_key
                response = table.query(**kwargs)
                items.extend(response.get("Items", []))
                start_key = response.get("LastEvaluatedKey")
                if not start_key:
                    break
            return items
        except ClientError as e:
            handle_database_error(e, "read")

    def get_all_transactions_for_account(self, account_id: str) -> list[dict]:
        """Every stored transaction row — pending AND posted — for an account,
        paginated (WHIT-82 pattern). Used by the one-time dedupe cleanup (WHIT-80):
        follows LastEvaluatedKey so no row is truncated at DynamoDB's 1MB page."""
        try:
            table = self._get_table()
            key_condition = Key("pk").eq(_build_pk(account_id))
            items: list[dict] = []
            start_key = None
            while True:
                kwargs = {"KeyConditionExpression": key_condition}
                if start_key is not None:
                    kwargs["ExclusiveStartKey"] = start_key
                response = table.query(**kwargs)
                items.extend(response.get("Items", []))
                start_key = response.get("LastEvaluatedKey")
                if not start_key:
                    break
            return items
        except ClientError as e:
            handle_database_error(e, "read")

    def get_failed_transactions(self) -> list[dict]:
        """Retrieve all dead-lettered rows — the ``pk="FAILED"`` partition written by
        save_failed_transactions. Paginated (WHIT-82 pattern) so a large backlog isn't
        truncated at DynamoDB's 1MB page. Read-only; the reprocess sweep (WHIT-55)
        drives it."""
        try:
            table = self._get_table()
            key_condition = Key("pk").eq("FAILED")
            items: list[dict] = []
            start_key = None
            while True:
                kwargs = {"KeyConditionExpression": key_condition}
                if start_key is not None:
                    kwargs["ExclusiveStartKey"] = start_key
                response = table.query(**kwargs)
                items.extend(response.get("Items", []))
                start_key = response.get("LastEvaluatedKey")
                if not start_key:
                    break
            return items
        except ClientError as e:
            handle_database_error(e, "read")

    def delete_failed_transaction(self, sk: str) -> None:
        """Delete a dead-letter row after it has been successfully reprocessed
        (WHIT-55). No attribute_exists guard, so a re-run deleting an already-gone row
        is a harmless no-op (mirrors _delete_pending_if_present)."""
        try:
            self._get_table().delete_item(Key={"pk": "FAILED", "sk": sk})
        except ClientError as e:
            handle_database_error(e, "delete failed")

    def insert_or_reconcile(self, transactions: list[Transaction]) -> None:
        """Insert transactions, reconciling pending->posted so a user's category
        survives settlement.

        On settlement BankSync issues a NEW id for the posted transaction with no
        link back to the pending one (`pendingTransactionId` is null today), so a
        blind insert would leave two rows — a categorized pending + an uncategorized
        posted. Instead, for each POSTED transaction we find its pending twin, carry
        the pending row's `category` onto the posted row, and delete the stale
        pending. Match order per posting (see the _find_*_twin tiers): exact
        `pending_transaction_id` link (forward-compat), else same authorized_date +
        EXACT amount, else a tip-adjusted match (same day + merchant + amount within
        TIP_HEADROOM above the auth), else a skewed-date match (WHIT-331: pending dated
        exactly one day later + exact amount + merchant, for a pair ANZ split across the
        Melbourne/UTC day boundary), else a blank-authorized_date match, else a same-id
        re-sync of an already-stored posted row. No match -> a plain insert. A
        missing/racey match never raises: it degrades to insert.

        WHIT-117: across a MULTI-ROW batch the twin search runs a pass per tier (all
        exact matches resolved before any looser tier — see _reconcile_matches) so an
        exact twin is never starved by a tip- or skew-eligible sibling posting processed
        first.

        Pending rows are inserted as-is. All inserts are batched at the end; stale
        pendings are deleted after.
        """
        if not transactions:
            return

        pending_pools: dict[str, list[dict]] = {}   # account_id -> loaded pending rows
        to_insert: list[Transaction] = []
        stale_pending_keys: list[tuple[str, str]] = []

        # A posted row already stored under its OWN id is a re-send, not a settlement:
        # BankSync repeats a settled transaction for FEED_WINDOW_DAYS, and it claimed its
        # twin the first time. Letting it back into the twin search lets it consume a
        # LATER, genuinely different pending — its stored date is one day behind a charge
        # swiped the next day, which is exactly what the skewed-date tier looks for. So
        # resolve re-sends here and keep them out of the search entirely (WHIT-331).
        resync_rows: dict[str, dict] = {}
        to_match: list[Transaction] = []
        for posted_txn in (t for t in transactions if t.get("status") != PENDING_STATUS):
            stored = self.get_transaction(_build_pk(posted_txn["account_id"]),
                                          _build_sk(posted_txn["transaction_id"]))
            if stored is None:
                to_match.append(posted_txn)
            else:
                resync_rows[posted_txn["transaction_id"]] = stored

        # WHIT-117: resolve twins for the whole batch up front, tightest tier first across
        # rows. `posted_matches` is aligned to `to_match` in order; the loop below pulls one
        # entry per NON-re-send posted row, so the alignment holds.
        posted_matches = iter(self._reconcile_matches(to_match, pending_pools))

        for txn in transactions:
            if txn.get("status") == PENDING_STATUS:
                # A pending charge the bank re-sends under the same id (~7 days until it
                # settles) must keep the fields the user set while it was pending. Read the
                # stored row and carry category/notes/tags/budget_excluded before the
                # full-item put_item overwrites them, mirroring the posted re-sync below
                # (WHIT-329). No swipe-date inherit here: a pending re-send carries its own
                # authorized_date, so the settled-path date guard doesn't apply.
                # NOTE: a posted twin arriving in this SAME payload won't see this pending
                # (the pool is the DB scan), so both would insert -> a duplicate. Real
                # settlements arrive in separate webhooks; a backfill payload containing
                # both is an accepted edge, cleaned by the age-out follow-up.
                own_pk = _build_pk(txn["account_id"])
                own_sk = _build_sk(txn["transaction_id"])
                existing = self.get_transaction(own_pk, own_sk)
                if existing is not None:
                    to_insert.append(self._with_carried_category(txn, existing))
                else:
                    to_insert.append(txn)
                continue

            # A re-send: carry the user's fields off the stored row and keep its corrected
            # date. It never enters the twin search, so it can't consume a fresh pending.
            existing = resync_rows.get(txn["transaction_id"])
            if existing is not None:
                merged = self._with_carried_category(txn, existing)
                self._inherit_swipe_date(merged, txn, existing)  # don't regress a corrected date
                to_insert.append(merged)
                continue

            # A first-time settlement. `to_match` and this branch share the same predicate
            # (posted, not a re-send), so the iterator has exactly one entry per row. The
            # default is a defensive guard: a should-never-happen over-run degrades to a
            # plain insert (no reconcile) instead of a StopIteration that 500s the webhook.
            _, match = next(posted_matches, (None, None))
            if match is not None:
                merged = self._with_carried_category(txn, match)
                self._inherit_swipe_date(merged, txn, match)  # take the twin's swipe date
                to_insert.append(merged)
                match_key = (match["pk"], match["sk"])
                own_key = (_build_pk(txn["account_id"]), _build_sk(txn["transaction_id"]))
                if match_key != own_key:
                    stale_pending_keys.append(match_key)
            else:
                to_insert.append(txn)

        self.insert_transactions(to_insert)
        for pk, sk in stale_pending_keys:
            self._delete_pending_if_present(pk, sk)

    def _reconcile_matches(
        self, posted_txns: list[Transaction], pending_pools: dict[str, list[dict]]
    ) -> list[tuple[Transaction, Optional[dict]]]:
        """Match every posted row in a batch to its pending twin, tightest tier first
        across the whole batch (WHIT-117). Returns (posted_txn, match_or_None) in the
        original order of `posted_txns`.

        One pass per tier over the SHARED pools, in the order below, each pass running
        only on the postings the earlier ones left unmatched. Because every pass pops
        from the same pool, a tighter tier always claims its twin before a looser one
        can reach it — so a pending that is the exact twin of one posting is never
        starved by a tip- or skew-eligible sibling that merely happens to be earlier in
        the batch. Each pending is still popped at most once (money-safety), regardless
        of batch order.
        """
        matches: list[Optional[dict]] = [None] * len(posted_txns)
        unmatched = list(range(len(posted_txns)))
        # Tightest gate first: exact date+amount, then a tip on the same day, then a
        # date split one day by the Melbourne/UTC clocks, then the loosest (no swipe
        # date at all, matched within a FEED_WINDOW_DAYS window).
        for find_twin in (self._find_exact_twin, self._find_tip_twin,
                          self._find_skewed_auth_twin, self._find_blank_auth_twin):
            still: list[int] = []
            for i in unmatched:
                matches[i] = find_twin(posted_txns[i], pending_pools)
                if matches[i] is None:
                    still.append(i)
            unmatched = still
        return list(zip(posted_txns, matches))

    def _ensure_pool(
        self, account_id: str, pending_pools: dict[str, list[dict]]
    ) -> list[dict]:
        """The account's pending rows, scanned once and cached in `pending_pools` so a
        multi-row batch (and both reconcile passes) reuse one query per account."""
        pool = pending_pools.get(account_id)
        if pool is None:
            pool = list(self.get_pending_transactions_for_account(account_id))
            pending_pools[account_id] = pool
        return pool

    def _find_exact_twin(
        self, posted_txn: Transaction, pending_pools: dict[str, list[dict]]
    ) -> Optional[dict]:
        """Return AND consume the pending row that is an EXACT twin of `posted_txn`
        (link, then same authorized_date + exact amount), or None. Only ever returns a
        row taken from the account's pending scan, so the caller never gets an
        unverified key. Consumed rows are popped from the pool.
        """
        pool = self._ensure_pool(posted_txn["account_id"], pending_pools)

        # 1. Exact link (forward-compat; pending_transaction_id is null today). The
        #    pool IS the full account pending scan, so a link not in it means the
        #    pending is already gone -> fall through to the heuristic, never a
        #    fabricated key.
        link_id = posted_txn.get("pending_transaction_id")
        if link_id:
            for i, item in enumerate(pool):
                if item.get("transaction_id") == link_id:
                    return pool.pop(i)

        # 2. Heuristic: same authorized_date + EXACT amount (account already scoped by
        #    the pool). Skip when authorized_date is missing — matching on amount alone
        #    is too loose. authorized_date is USUALLY preserved across settlement, so it
        #    discriminates identical daily purchases. When it isn't — ANZ dates the
        #    pending in Melbourne-local time and the settled row in UTC, so a pre-10:00
        #    swipe splits across the day boundary — this tier misses and the skewed-date
        #    tier picks it up (WHIT-331).
        authorized_date = posted_txn.get("authorized_date")
        if not authorized_date:
            return None
        amount = posted_txn.get("amount")
        exact = [
            i for i, item in enumerate(pool)
            if item.get("authorized_date") == authorized_date and item.get("amount") == amount
        ]
        if exact:
            # Two identical same-day charges are indistinguishable; pick deterministically
            # (lowest transaction_id) so behaviour is stable and testable.
            best = min(exact, key=lambda i: pool[i].get("transaction_id", ""))
            return pool.pop(best)
        return None

    def _find_tip_twin(
        self, posted_txn: Transaction, pending_pools: dict[str, list[dict]]
    ) -> Optional[dict]:
        """Return AND consume the pending row that settled into `posted_txn` with a tip
        added (WHIT-116), or None. Runs only after every exact twin in the batch is
        already claimed (see _reconcile_matches), so it only sees strictly-larger-amount
        leftovers. Consumed rows are popped from the pool.
        """
        pool = self._ensure_pool(posted_txn["account_id"], pending_pools)

        # A tip added at settlement changes the amount, so the exact-amount tier misses.
        # Match same authorized_date + the posted merchant appearing (word-for-word) in
        # the pending's raw description — pending rows carry no clean merchant_name, only
        # the description — + a settled amount within TIP_HEADROOM above the auth. The
        # merchant gate plus the one-directional amount headroom keep a coincidental
        # same-day charge (or a refund) from being swept in.
        authorized_date = posted_txn.get("authorized_date")
        if not authorized_date:
            return None
        amount = posted_txn.get("amount")
        if amount is None:
            return None
        # A tip-adjusted match DELETES a pending, so require a merchant strong enough to
        # trust: at least TWO words. A lone common word (a bare location like "MELBOURNE",
        # or a generic token like "EXPRESS") is a whole word in many unrelated same-day
        # descriptions and would wrongly consume a different merchant's pending. Single-
        # word merchants simply don't tip-reconcile — they fall back to the exact-amount
        # tier (today's behaviour: a leftover duplicate, never a wrong merge).
        merchant = posted_txn.get("merchant_name") or ""
        if len(_words(merchant)) < 2:
            return None
        tip = [
            i for i, item in enumerate(pool)
            if item.get("authorized_date") == authorized_date
            and item.get("amount") is not None
            and _is_tip_adjusted(item["amount"], amount)
            and _merchant_matches_pending(merchant, item.get("merchant_name") or "",
                                          item.get("description") or "")
        ]
        if not tip:
            return None
        best = min(tip, key=lambda i: pool[i].get("transaction_id", ""))
        return pool.pop(best)

    def _find_skewed_auth_twin(
        self, posted_txn: Transaction, pending_pools: dict[str, list[dict]]
    ) -> Optional[dict]:
        """Return AND consume the pending twin whose authorized_date sits exactly one day
        AFTER `posted_txn`'s because the two records were dated off different clocks
        (WHIT-331), or None. Runs after the exact and tip tiers, so it only ever sees
        pendings no equal-date tier wanted. Consumed rows are popped from the pool.

        The exact and tip tiers both key on an EQUAL authorized_date, so an ANZ pair
        split across the Melbourne/UTC day boundary matches neither and both rows
        survive — the purchase is then counted twice for as long as the pending lives.

        This tier DELETES a pending, so the gates stay strict: an exact amount (no tip
        headroom — skewed AND tipped is a compound rarity not worth the extra surface),
        a merchant match (see _merchant_matches_pending), and a skew of exactly one day in
        the one direction the clocks can produce.

        Two genuine same-amount purchases on consecutive days are indistinguishable from
        a skewed pair, which is why _reconcile_matches claims every EXACT twin in the
        batch first: the same-day pending is always taken by the exact tier before this
        one can reach it. What is left is a same-amount pair at the same merchant on
        consecutive days — for a single-word merchant that means anywhere in a CHAIN,
        since clean_merchant strips store numbers, so this is a routine week (two Coles
        runs) rather than a rarity.

        Picking the wrong one of those keeps the TOTAL right — the other charge inserts
        plainly when its own settlement lands — but it is not free: the settled row takes
        the consumed pending's day (via _inherit_swipe_date) and its category, notes and
        tags. So one charge can show on a day the user did not swipe, wearing the other
        charge's label. Accepted because the alternative is leaving every early-morning
        chain purchase duplicated for the whole age-out window, which is worse and
        certain rather than occasional. Pinned by
        test_one_word_settlement_takes_the_wrong_pending_when_only_the_later_one_is_open."""
        pool = self._ensure_pool(posted_txn["account_id"], pending_pools)

        authorized_date = posted_txn.get("authorized_date")
        if not authorized_date:
            return None  # no swipe date of its own -> the blank-auth tier owns it
        amount = posted_txn.get("amount")
        if amount is None:
            return None
        merchant = posted_txn.get("merchant_name") or ""
        merchant_words = _words(merchant)
        if not merchant_words:
            return None  # no derivable merchant -> never enough to delete a row on
        single_word = len(merchant_words) == 1
        dated_alike = [
            i for i, item in enumerate(pool)
            if item.get("amount") == amount
            and _is_skewed_next_day(item.get("authorized_date"), authorized_date)
        ]
        candidates = [
            i for i in dated_alike
            if _merchant_matches_pending(merchant, pool[i].get("merchant_name") or "",
                                      pool[i].get("description") or "")
        ]
        if not candidates:
            # The amount and the one-day skew lined up but the names did not. The merge
            # log below only fires on success, so without this a broken gate is
            # indistinguishable from nothing to reconcile. Logged for EVERY rejection,
            # not just single-word ones: the gate now reads a fixed-width column, so a
            # change to the COLUMN WIDTH or to the "POS AUTHORISATION" literal (padding
            # drift the relative slice already absorbs) would stop multi-word merchants
            # reconciling too, and this line is the only place that would show it.
            # `pending_column` is what the gate actually compared on an ANZ row — the
            # stored name is printed alongside it precisely because they disagree in the
            # fused case this exists to diagnose.
            for i in dated_alike:
                column = _pending_merchant_column(pool[i].get("description") or "")
                logger.info(
                    "skewed-date twin rejected on merchant: account=%s "
                    "merchant=%r pending_merchant=%r pending_column=%r pending=%s",
                    posted_txn["account_id"], merchant,
                    pool[i].get("merchant_name"),
                    clean_merchant(column) if column is not None else None,
                    pool[i].get("transaction_id"),
                )
            return None
        best = min(candidates, key=lambda i: pool[i].get("transaction_id", ""))
        twin = pool.pop(best)
        # The only way this tier is measurable: a successful reconcile DELETES the
        # pending, so without a log line the skew leaves no trace either way. `gate`
        # names the branch that actually matched, so a column-geometry drift shows up as
        # "column" merges falling to zero rather than as silence.
        if _pending_merchant_column(twin.get("description") or "") is not None:
            gate = "column"
        else:
            gate = "name" if single_word else "description"
        logger.info(
            "skewed-date twin merged: account=%s merchant=%r amount=%s gate=%s "
            "posted=%s (auth %s) pending=%s (auth %s)",
            posted_txn["account_id"], merchant, amount, gate,
            posted_txn.get("transaction_id"), authorized_date,
            twin.get("transaction_id"), twin.get("authorized_date"),
        )
        return twin

    def _find_blank_auth_twin(
        self, posted_txn: Transaction, pending_pools: dict[str, list[dict]]
    ) -> Optional[dict]:
        """Return AND consume the pending twin of a posted row the bank sent WITHOUT an
        authorized_date, or None. Some ANZ settlements blank that field, and both the
        exact and tip tiers key on it — so without this tier the pending twin is orphaned
        (a lingering duplicate) and the settled row keeps its settlement date instead of
        the swipe date. Runs LAST (after every exact/tip twin is claimed), and ONLY for a
        posted row that itself has no authorized_date. Match: EXACT amount + the posted
        merchant appearing (word-for-word, >=2 words) in the pending's raw description +
        the pending dated within FEED_WINDOW_DAYS on-or-before the posted. The exact-amount
        + strong-merchant + date-window gates mirror the tip tier's caution — this DELETES a
        pending, so it must not merge a coincidental same-amount charge."""
        if posted_txn.get("authorized_date"):
            return None  # has its own swipe date -> the exact/tip tiers handle it
        amount = posted_txn.get("amount")
        if amount is None:
            return None
        merchant = posted_txn.get("merchant_name") or ""
        if len(_words(merchant)) < 2:
            return None
        posted_date = posted_txn.get("date")
        pool = self._ensure_pool(posted_txn["account_id"], pending_pools)
        candidates = [
            i for i, item in enumerate(pool)
            if item.get("amount") == amount
            and _settles_after(item.get("date"), posted_date)
            and _merchant_matches_pending(merchant, item.get("merchant_name") or "",
                                          item.get("description") or "")
        ]
        if not candidates:
            return None
        best = min(candidates, key=lambda i: pool[i].get("transaction_id", ""))
        return pool.pop(best)

    @staticmethod
    def _inherit_swipe_date(merged: Transaction, posted_txn: Transaction, source_row: dict) -> None:
        """Give a settled charge the swipe date of its source row — its pending twin
        (dated at swipe) on first settlement, or, on a re-sync, the already-corrected
        stored posted. Mutates `merged` in place. Two cases, both about a settled row
        whose own date can't be trusted as the swipe day:

        1. authorized_date BLANK — some ANZ settlements omit it entirely, so without the
           twin's date the charge would show (or regress to) its settlement day.
        2. authorized_date exactly one day BEFORE the source's (WHIT-331) — the pair was
           dated off two clocks and the source holds the Melbourne-local day, which is
           the day the user actually swiped. Melbourne wins.

        Deliberately gated on the skew SHAPE rather than "the dates differ": a stored
        date must never clobber a genuine upstream correction, only the known one-day
        clock split. An exact or tip merge has equal dates on both sides, so this stays
        a no-op there and those tiers remain byte-identical.

        Case 2 covers the re-sync as well as the first merge. BankSync keeps re-sending a
        settled transaction for FEED_WINDOW_DAYS, each time carrying the UTC date again;
        by then the pending twin is deleted, so the row falls to the re-sync path with the
        corrected stored row as its source. Without this the Melbourne date would be
        overwritten within hours, and the charge would flip days on every sync."""
        if not posted_txn.get("authorized_date"):
            if source_row.get("date"):
                merged["date"] = source_row["date"]
            if source_row.get("authorized_date"):
                merged["authorized_date"] = source_row["authorized_date"]
            return
        if _is_skewed_next_day(source_row.get("authorized_date"), posted_txn["authorized_date"]):
            # Both guarded the same way: a source row missing `date` (a legacy or partial
            # write) must not leave the row claiming a swipe day its `date` disagrees with,
            # since the budget window keys on `date`.
            if source_row.get("date"):
                merged["date"] = source_row["date"]
                merged["authorized_date"] = source_row["authorized_date"]

    @staticmethod
    def _with_carried_category(
        posted_txn: Transaction, source_row: dict, *, dedupe_sweep: bool = False
    ) -> Transaction:
        """A copy of the posted txn with the user-owned fields — `category`, `notes`,
        `tags` and `budget_excluded` — carried from `source_row` (the matched pending
        / existing posted) when that row has them. Falsy/absent -> keep the posted
        txn's own value, so a cleared note/tag/override never overwrites a real one.
        (Named for `category`, its original and still-primary carried field; notes/
        tags ride along so a note on a pending charge survives settlement — WHIT-275;
        budget_excluded rides along so a "mark as transfer" override survives it —
        WHIT-296.)

        dedupe_sweep: set by the one-time dedupe sweep (WHIT-80) so a stale pending
        twin can't clobber what the user set after settlement.
          - notes/tags (WHIT-279): a value the posted ALREADY holds is never overwritten;
            only an absent one is filled (a truthy posted value means the user edited the
            posted itself).
          - budget_excluded (WHIT-300): posted-authoritative — NEVER carried from the
            source. A re-include the user just made clears the override (reads back
            absent), so filling it from a stale pending twin still marked True would
            silently re-exclude the charge. The cost is the mirror case (a genuinely
            marked pending whose posted lacks the override isn't excluded by the sweep),
            which errs toward showing/counting the charge — the safer direction.
          - category is NEVER skipped (the bank always sets one, so there's no clean
            'user set it' signal, and carrying the pending's category is the sweep's
            purpose).
        Default False keeps the live reconcile carry byte-identical.

        Accepted residual (WHIT-279): the sweep still overwrites a value the user set
        DIRECTLY on the posted when it can't detect it — category always (no bank-vs-
        user signal), and a CLEARED note/tag (a falsy posted value reads as absent, so
        the pending's old one refills). Only reachable on the manual sweep when a stale
        pending twin survived reconciliation."""
        carried = posted_txn.copy()
        for field in ("category", "notes", "tags", "budget_excluded"):
            if dedupe_sweep:
                if field == "budget_excluded":
                    continue  # WHIT-300: posted-authoritative — never carry the override
                if field in ("notes", "tags") and posted_txn.get(field):
                    continue  # WHIT-279: posted already holds a user note/tag — don't clobber
            value = source_row.get(field)
            if value:
                carried[field] = value
        return carried

    def _delete_pending_if_present(self, pk: str, sk: str) -> None:
        """Delete a stale pending row. No attribute_exists guard, so deleting an
        already-gone row is a harmless no-op (avoids a race raising a 500)."""
        try:
            self._get_table().delete_item(Key={"pk": pk, "sk": sk})
        except ClientError as e:
            handle_database_error(e, "delete pending")

    def has_event(self, envelope_id: str) -> bool:
        """Whether this event was already fully processed (its marker exists).

        The marker is written by mark_event only AFTER a delivery succeeds, so a
        failed delivery leaves no marker and BankSync's retry re-processes it — a
        failed write can never drop the transaction (WHIT-83, save-then-mark).
        """
        try:
            result = self._get_table().get_item(
                Key={"pk": f"EVENT#{envelope_id}", "sk": "EVENT"}
            )
            return "Item" in result
        except ClientError as e:
            handle_database_error(e, "has_event")

    def mark_event(self, envelope_id: str) -> None:
        """Record that an event has been fully processed. Called only after the
        write succeeds; a plain, idempotent put — re-marking is harmless."""
        try:
            self._get_table().put_item(
                Item={"pk": f"EVENT#{envelope_id}", "sk": "EVENT"}
            )
        except ClientError as e:
            handle_database_error(e, "mark_event")
