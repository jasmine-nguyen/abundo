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


# Shortest final merchant word that may match as a PREFIX in a fused description (see
# _merchant_in_fused_description). A 2-letter token like "SA" prefixes far too many
# unrelated words ("sales", "salvation") to justify deleting a pending on it.
_FUSED_PREFIX_MIN_LEN = 3


def _merchant_in_fused_description(merchant: str, description: str) -> bool:
    """Like _merchant_in_description, but tolerant of ANZ's fixed-width column fusion
    (WHIT-331). A pending's raw description packs the merchant into a 25-character
    column; a merchant that exactly fills it runs straight into the suburb with no
    separator, so "SQ *KKV INTERNATIONAL PTY" + "Sunshine" arrives as the single word
    "PTYSunshine" and every word of the merchant can no longer match.

    Only the LAST merchant word may match as a prefix, and only when it is at least
    _FUSED_PREFIX_MIN_LEN characters — fusion can only ever affect the trailing word,
    and a short one would over-match. Every earlier word must still match exactly, so
    this stays strictly narrower than a substring search. A short final word falls back
    to whole-word matching (today's behaviour: a leftover duplicate, never a wrong
    merge)."""
    merchant_words = _words(merchant)
    if not merchant_words:
        return False
    head, last = merchant_words[:-1], merchant_words[-1]
    # `_words` keeps only [a-z0-9], so an accented or punctuated token arrives here as a
    # STUMP ("ROSÉ" -> "ros") that would pass the length guard and then prefix-match an
    # unrelated word ("Rossini"). Only tolerate a prefix when the trailing token survived
    # that stripping intact — i.e. it is a real word, not a fragment.
    raw_words = merchant.split()
    last_is_whole_word = bool(raw_words) and raw_words[-1].lower() == last
    # Nothing to fuse onto either: a lone word has no earlier word anchoring it, so a
    # prefix rule would degrade to "any description word starts with this" — strictly
    # looser than whole-word matching, in the direction that deletes a pending.
    if not head or not last_is_whole_word or len(last) < _FUSED_PREFIX_MIN_LEN:
        return _merchant_in_description(merchant, description)
    description_words = _words(description)
    return any(
        description_words[i:i + len(head)] == head
        and description_words[i + len(head)].startswith(last)
        for i in range(len(description_words) - len(merchant_words) + 1)
    )


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
            and _merchant_in_description(merchant, item.get("description") or "")
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

        This tier DELETES a pending, so every gate the tip tier uses stays in force —
        exact amount (no tip headroom: skewed AND tipped is a compound rarity not worth
        the extra surface), a >=2-word merchant, and that merchant appearing in the
        pending's raw description — plus the skew itself must be exactly one day in the
        one direction the clocks can produce. Two genuine same-amount purchases on
        consecutive days are indistinguishable from a skewed pair, which is why
        _reconcile_matches claims every EXACT twin in the batch first: the same-day
        pending is always taken by the exact tier before this one can reach it."""
        pool = self._ensure_pool(posted_txn["account_id"], pending_pools)

        authorized_date = posted_txn.get("authorized_date")
        if not authorized_date:
            return None  # no swipe date of its own -> the blank-auth tier owns it
        amount = posted_txn.get("amount")
        if amount is None:
            return None
        merchant = posted_txn.get("merchant_name") or ""
        if len(_words(merchant)) < 2:
            return None
        candidates = [
            i for i, item in enumerate(pool)
            if item.get("amount") == amount
            and _is_skewed_next_day(item.get("authorized_date"), authorized_date)
            and _merchant_in_fused_description(merchant, item.get("description") or "")
        ]
        if not candidates:
            return None
        best = min(candidates, key=lambda i: pool[i].get("transaction_id", ""))
        twin = pool.pop(best)
        # The only way this tier is measurable: a successful reconcile DELETES the
        # pending, so without a log line the skew leaves no trace either way.
        logger.info(
            "skewed-date twin merged: account=%s merchant=%r amount=%s "
            "posted=%s (auth %s) pending=%s (auth %s)",
            posted_txn["account_id"], merchant, amount,
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
            and _merchant_in_description(merchant, item.get("description") or "")
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
