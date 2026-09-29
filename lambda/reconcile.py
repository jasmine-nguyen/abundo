"""Pending -> posted settlement planning, pure (no database) (WHIT-624).

`plan_reconcile` takes the new charges, the stored posted rows and the pending pools and
returns a plan of steps. `insert_or_reconcile` (repository.py) carries the plan out against
the table; the budget-alert preview (budget_alerts.py) carries it out in memory with
`apply_plan`. One planner, so the two can't drift.
"""

from dataclasses import dataclass, field
from datetime import date
from decimal import Decimal
import logging
import re
from typing import Any, Callable, Optional
from banksync import counts_to_budget
from merchant import clean_merchant, is_anz_pending, pending_merchant_column
from models import Transaction
from constants import (
    AUTH_DATE_SKEW_DAYS,
    FEED_WINDOW_DAYS,
    PENDING_STATUS,
    SKEW_FEE_HEADROOM,
    TIP_HEADROOM,
)
from repository_transaction import _build_pk, _build_sk, sanitise_transaction

logger = logging.getLogger(__name__)
# The Text-format Lambda runtime leaves the root logger at WARNING, so INFO logs are
# dropped unless we opt in — matching lambda/handler.py.
logger.setLevel(logging.INFO)

_BANK_OWNED_FIELDS = (
    "date", "authorized_date", "description", "merchant_name", "amount",
    "account_id", "account_name", "status", "type",
    "counts_to_budget", "pending_transaction_id",
)

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


def _merchant_gate(merchant: str, pending_merchant: str, description: str) -> Optional[str]:
    """Which branch matches a posted merchant to a pending row (WHIT-336) — "column",
    "description", "name", or None when nothing matches. The SINGLE source for both the
    match decision (`merchant_matches_pending` is a thin bool view of this) and the
    skewed-date merge log's gate= label; deriving both from this one return value is why
    they cannot drift (WHIT-338).

    Shared by every heuristic tier that matches on a merchant — tip, skewed-date,
    skewed-fee and blank-auth. They MUST share it. The tiers run tightest-first so a tighter tier always
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
    if is_anz_pending(description):
        column = pending_merchant_column(description)
        # An ANZ row with no readable column has nothing to compare, so it must REFUSE.
        # Falling through to the gates below would hand the row to a containment search
        # over the whole description — suburb included — and a merchant named after a
        # place would match it. "Unreadable" is not "not ANZ".
        if column is not None and _same_cleaned_merchant(merchant, clean_merchant(column)):
            return "column"
        return None
    if len(_words(merchant)) >= 2:
        return "description" if _merchant_in_description(merchant, description) else None
    if (_same_cleaned_merchant(merchant, pending_merchant)
            and _merchant_in_description(merchant, description)):
        return "name"
    return None


def merchant_matches_pending(merchant: str, pending_merchant: str, description: str) -> bool:
    """Whether a posted merchant names the same shop as a pending row — the bool view of
    `_merchant_gate` (which branch matched). Shared by the tip, skewed-date, skewed-fee
    and blank-auth tiers; see `_merchant_gate` for the full rationale."""
    return _merchant_gate(merchant, pending_merchant, description) is not None


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


def _is_larger_within(auth_amount: Decimal, settled_amount: Decimal, headroom: Decimal) -> bool:
    """Whether `settled_amount` is `auth_amount` grown by at most `headroom` (a fraction).
    Both must be spend (negative) and ONE-DIRECTIONAL — settlement only makes the
    magnitude larger (a tip, a folded-in fee) — so a smaller settled amount, or an
    opposite-sign one (a refund/credit), never matches."""
    if auth_amount >= 0 or settled_amount >= 0:
        return False
    auth_mag = -auth_amount
    settled_mag = -settled_amount
    return auth_mag <= settled_mag <= auth_mag * (Decimal(1) + headroom)


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


def _pop_lowest_id(pool: list[dict], indices: list[int]) -> dict:
    """Consume ONE pending row: pop the lowest-transaction_id row among `indices`
    from `pool`. The money-safety core every tier shares — it pops at most one row,
    chosen deterministically (two identical same-day charges resolve the same way
    every run, so behaviour is stable and testable), and only ever a row already in
    the pool. `indices` must be non-empty."""
    best = min(indices, key=lambda i: pool[i].get("transaction_id", ""))
    return pool.pop(best)


def _select_twin(pool: list[dict], predicate: Callable[[dict], bool]) -> Optional[dict]:
    """Return AND consume the one pending row `predicate` accepts, or None. The shared
    tail of every tier whose whole candidate set is a single predicate (exact, tip,
    skewed-fee, blank-auth). The skewed tier pre-filters for its own reject logging, so it calls
    _pop_lowest_id directly rather than going through here."""
    candidates = [i for i, item in enumerate(pool) if predicate(item)]
    if not candidates:
        return None
    return _pop_lowest_id(pool, candidates)


def _find_exact_twin(posted_txn: Transaction, pool: list[dict]) -> Optional[dict]:
    """Return AND consume the pending row that is an EXACT twin of `posted_txn`
    (link, then same authorized_date + exact amount), or None. `pool` is the account's
    pending rows, so the caller never gets an unverified key. Consumed rows are popped.
    """
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
    return _select_twin(
        pool,
        lambda item: item.get("authorized_date") == authorized_date
        and item.get("amount") == amount,
    )


def _find_tip_twin(posted_txn: Transaction, pool: list[dict]) -> Optional[dict]:
    """Return AND consume the pending row that settled into `posted_txn` with a tip
    added (WHIT-116), or None. Runs only after every exact twin in the batch is
    already claimed (see match_all), so it only sees strictly-larger-amount
    leftovers. Consumed rows are popped from the pool.
    """
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
    return _select_twin(
        pool,
        lambda item: item.get("authorized_date") == authorized_date
        and item.get("amount") is not None
        and _is_larger_within(item["amount"], amount, TIP_HEADROOM)
        and merchant_matches_pending(merchant, item.get("merchant_name") or "",
                                     item.get("description") or ""),
    )


def _find_skewed_auth_twin(posted_txn: Transaction, pool: list[dict]) -> Optional[dict]:
    """Return AND consume the pending twin whose authorized_date sits exactly one day
    AFTER `posted_txn`'s because the two records were dated off different clocks
    (WHIT-331), or None. Runs after the exact and tip tiers, so it only ever sees
    pendings no equal-date tier wanted. Consumed rows are popped from the pool.

    The exact and tip tiers both key on an EQUAL authorized_date, so an ANZ pair
    split across the Melbourne/UTC day boundary matches neither and both rows
    survive — the purchase is then counted twice for as long as the pending lives.

    This tier DELETES a pending, so the gates stay strict: an exact amount (a skewed
    charge that also grew, e.g. a foreign fee folded in, is left to
    `_find_skewed_fee_twin`, which runs after this one — WHIT-653), a merchant match (see merchant_matches_pending), and a skew of exactly one day in
    the one direction the clocks can produce.

    Two genuine same-amount purchases on consecutive days are indistinguishable from
    a skewed pair, which is why match_all claims every EXACT twin in the
    batch first: the same-day pending is always taken by the exact tier before this
    one can reach it. What is left is a same-amount pair at the same merchant on
    consecutive days — for a single-word merchant that means anywhere in a CHAIN,
    since clean_merchant strips store numbers, so this is a routine week (two Coles
    runs) rather than a rarity.

    Picking the wrong one of those keeps the TOTAL right — the other charge inserts
    plainly when its own settlement lands — but it is not free: the settled row takes
    the consumed pending's day (via inherit_swipe_date) and its category, notes and
    tags. So one charge can show on a day the user did not swipe, wearing the other
    charge's label. Accepted because the alternative is leaving every early-morning
    chain purchase duplicated for the whole age-out window, which is worse and
    certain rather than occasional. Pinned by
    test_one_word_settlement_takes_the_wrong_pending_when_only_the_later_one_is_open."""
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
    dated_alike = [
        i for i, item in enumerate(pool)
        if item.get("amount") == amount
        and _is_skewed_next_day(item.get("authorized_date"), authorized_date)
    ]
    candidates = [
        i for i in dated_alike
        if merchant_matches_pending(merchant, pool[i].get("merchant_name") or "",
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
            column = pending_merchant_column(pool[i].get("description") or "")
            logger.info(
                "skewed-date twin rejected on merchant: account=%s "
                "merchant=%r pending_merchant=%r pending_column=%r pending=%s",
                posted_txn["account_id"], merchant,
                pool[i].get("merchant_name"),
                clean_merchant(column) if column is not None else None,
                pool[i].get("transaction_id"),
            )
        return None
    twin = _pop_lowest_id(pool, candidates)
    # The only way this tier is measurable: a successful reconcile DELETES the
    # pending, so without a log line the skew leaves no trace either way. `gate`
    # names the branch that actually matched, read from the SAME gate that matched
    # the twin (not re-derived), so a column-geometry drift shows up as "column"
    # merges falling to zero rather than as a stale label.
    gate = _merchant_gate(merchant, twin.get("merchant_name") or "",
                          twin.get("description") or "")
    logger.info(
        "skewed-date twin merged: account=%s merchant=%r amount=%s gate=%s "
        "posted=%s (auth %s) pending=%s (auth %s)",
        posted_txn["account_id"], merchant, amount, gate,
        posted_txn.get("transaction_id"), authorized_date,
        twin.get("transaction_id"), twin.get("authorized_date"),
    )
    return twin


def _find_skewed_fee_twin(posted_txn: Transaction, pool: list[dict]) -> Optional[dict]:
    """Return AND consume the pending twin that settled one day EARLIER and slightly
    LARGER (WHIT-653), or None. A Westpac overseas charge settles dated a day before
    its pending with the foreign fee folded in (-170.01 pending -> -175.11 posted), so
    the equal-date tiers and the exact-amount skewed tier all miss it.

    Runs after the exact, tip and skewed tiers, so an exact-amount skewed twin is
    always claimed first and this only sees what they left. Gates: the pending dated
    exactly AUTH_DATE_SKEW_DAYS after the posted, the posted amount up to
    SKEW_FEE_HEADROOM larger (spend only, never smaller), and the tip tier's merchant
    gate including its >=2-word rule.

    A wrong pick costs the same as in the skewed tier: the total stays right, but the
    settled row takes the consumed pending's day, category, notes and tags."""
    authorized_date = posted_txn.get("authorized_date")
    if not authorized_date:
        return None
    amount = posted_txn.get("amount")
    if amount is None:
        return None
    merchant = posted_txn.get("merchant_name") or ""
    if len(_words(merchant)) < 2:
        return None
    twin = _select_twin(
        pool,
        lambda item: _is_skewed_next_day(item.get("authorized_date"), authorized_date)
        and item.get("amount") is not None
        and _is_larger_within(item["amount"], amount, SKEW_FEE_HEADROOM)
        and merchant_matches_pending(merchant, item.get("merchant_name") or "",
                                     item.get("description") or ""),
    )
    if twin is None:
        return None
    # A merge DELETES the pending, so this line is the only trace it happened.
    gate = _merchant_gate(merchant, twin.get("merchant_name") or "",
                          twin.get("description") or "")
    logger.info(
        "skewed-fee twin merged: account=%s merchant=%r amount=%s pending_amount=%s "
        "gate=%s posted=%s (auth %s) pending=%s (auth %s)",
        posted_txn["account_id"], merchant, amount, twin.get("amount"), gate,
        posted_txn.get("transaction_id"), authorized_date,
        twin.get("transaction_id"), twin.get("authorized_date"),
    )
    return twin


def _find_blank_auth_twin(posted_txn: Transaction, pool: list[dict]) -> Optional[dict]:
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
    return _select_twin(
        pool,
        lambda item: item.get("amount") == amount
        and _settles_after(item.get("date"), posted_date)
        and merchant_matches_pending(merchant, item.get("merchant_name") or "",
                                     item.get("description") or ""),
    )


def match_all(
    posted_txns: list[Transaction], pending_pools: dict[str, list[dict]]
) -> list[tuple[Transaction, Optional[dict]]]:
    """Match every posted row in a batch to its pending twin, tightest tier first
    across the whole batch (WHIT-117). Returns (posted_txn, match_or_None) in the
    original order of `posted_txns`. Pops consumed twins from `pending_pools`.

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
    # date split one day by the Melbourne/UTC clocks, then that same split with a
    # small fee folded in, then the loosest (no swipe date at all, matched within a
    # FEED_WINDOW_DAYS window).
    for find_twin in (_find_exact_twin, _find_tip_twin, _find_skewed_auth_twin,
                      _find_skewed_fee_twin, _find_blank_auth_twin):
        still: list[int] = []
        for i in unmatched:
            pool = pending_pools.get(posted_txns[i]["account_id"], [])
            matches[i] = find_twin(posted_txns[i], pool)
            if matches[i] is None:
                still.append(i)
        unmatched = still
    return list(zip(posted_txns, matches))


def inherit_swipe_date(merged: Transaction, posted_txn: Transaction, source_row: dict) -> None:
    """Give a settled charge the swipe date of its source row — its pending twin
    (dated at swipe) on first settlement, or, on a re-sync, the already-corrected
    stored posted. Mutates `merged` in place. Two cases, both about a settled row
    whose own date can't be trusted as the swipe day:

    1. authorized_date BLANK — some ANZ settlements omit it entirely, so without the
       twin's date the charge would show (or regress to) its settlement day.
    2. authorized_date exactly one day BEFORE the source's (WHIT-331) — the pair was
       dated off two clocks and the source holds the Melbourne-local day, which is
       the day the user actually swiped. Melbourne wins. A skewed-fee merge (WHIT-653)
       has the same shape and is handled the same way.

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


def with_carried_category(
    posted_txn: Transaction, source_row: dict, *,
    is_unfiled: Optional[Callable[[Optional[str]], bool]] = None,
) -> Transaction:
    """A copy of the posted txn with the user-owned fields — `category`, `notes`,
    `tags` and `budget_excluded` — carried from `source_row` (the matched pending
    / existing posted) when that row has them. Falsy/absent -> keep the posted
    txn's own value, so a cleared note/tag/override never overwrites a real one.
    (Named for `category`, its original and still-primary carried field; notes/
    tags ride along so a note on a pending charge survives settlement — WHIT-275;
    budget_excluded rides along so a "mark as transfer" override survives it —
    WHIT-296.)

    is_unfiled (WHIT-545): on a settlement-style carry the caller passes the taxonomy
    check. A source category it reports UNFILED (a raw bank enum) never overrides the
    posted's own — so a stored raw category can't clobber a rule-fill — and
    counts_to_budget is recomputed from whichever category actually lands. Absent
    keeps the old behaviour byte-identical."""
    carried = posted_txn.copy()
    carried_category = False
    for field_name in ("category", "notes", "tags", "budget_excluded"):
        value = source_row.get(field_name)
        if not value:
            continue
        if field_name == "category":
            if is_unfiled is not None and is_unfiled(value):
                continue  # WHIT-545: a raw unfiled stored category never clobbers a rule-fill
            carried_category = True
        carried[field_name] = value
    # Carry the rule stamp in lockstep with the category (WHIT-536): whoever owns the
    # category owns the stamp. When the source category was carried, take its stamp too —
    # or clear it when the source was hand-filed and has none, so the posted's own stamp
    # doesn't wrongly persist. If the posted kept its own category, its own stamp stands.
    if carried_category:
        source_stamp = source_row.get("filed_by_rule")
        if source_stamp:
            carried["filed_by_rule"] = source_stamp
        else:
            carried.pop("filed_by_rule", None)
    # WHIT-545: on a settlement-style carry, recompute the budget flag so it always
    # matches the category that landed (as file_charge does on first filing).
    if is_unfiled is not None:
        carried["counts_to_budget"] = counts_to_budget(
            carried.get("account_id"), carried.get("category")
        )
    return carried


def settle(
    posted_txn: Transaction, twin: dict,
    is_unfiled: Optional[Callable[[Optional[str]], bool]] = None,
) -> Transaction:
    """The posted row a first settlement writes: the user's fields carried off its
    pending twin, dated on the twin's swipe day where the bank's own date can't be
    trusted."""
    merged = with_carried_category(posted_txn, twin, is_unfiled=is_unfiled)
    inherit_swipe_date(merged, posted_txn, twin)
    return merged


def bank_field_updates(txn: Transaction, inherit_date_from: Optional[dict] = None) -> dict[str, Any]:
    """The bank-owned fields a re-sync overwrites on a stored row (WHIT-513) — user-owned
    fields (category, notes, tags, budget_excluded) are never in it. With
    `inherit_date_from`, date/authorized_date follow `inherit_swipe_date` against that row
    so a re-send can't undo an already-corrected swipe day."""
    sanitised = sanitise_transaction(txn)
    updates = {name: sanitised[name] for name in _BANK_OWNED_FIELDS if sanitised.get(name) is not None}
    if inherit_date_from is not None:
        inherit_swipe_date(updates, txn, inherit_date_from)
    return updates


@dataclass
class ReconcilePlan:
    """What saving a batch does, in batch order. Each step is one of:
      ("update", txn, inherit_date_from_or_None) — overwrite the bank fields of the row
          stored under txn's own id (a pending re-sync, or a posted re-send); insert txn
          if that row turns out to be missing
      ("settle", txn, twin) — first settlement matched to a pending twin: write
          `settle(txn, twin)`
      ("insert", txn) — first settlement with no twin
    `stale_pending_keys` are the (pk, sk) of consumed twins to delete after the writes."""
    steps: list[tuple] = field(default_factory=list)
    stale_pending_keys: list[tuple[str, str]] = field(default_factory=list)


def plan_reconcile(
    transactions: list[Transaction],
    stored_rows: dict[str, dict],
    pending_pools: dict[str, list[dict]],
) -> ReconcilePlan:
    """Plan a batch save. `stored_rows` holds the rows already stored under a posted
    charge's own transaction_id; `pending_pools` the stored pending rows per account.
    Neither input is mutated."""
    pools = {account_id: list(rows) for account_id, rows in pending_pools.items()}

    # A posted row already stored under its OWN id is a re-send, not a settlement:
    # BankSync repeats a settled transaction for FEED_WINDOW_DAYS, and it claimed its
    # twin the first time. Letting it back into the twin search lets it consume a
    # LATER, genuinely different pending — its stored date is one day behind a charge
    # swiped the next day, which is exactly what the skewed-date tier looks for. So
    # keep re-sends out of the search entirely (WHIT-331).
    to_match = [t for t in transactions
                if t.get("status") != PENDING_STATUS and t["transaction_id"] not in stored_rows]
    twins = iter(twin for _, twin in match_all(to_match, pools))

    plan = ReconcilePlan()
    for txn in transactions:
        if txn.get("status") == PENDING_STATUS:
            plan.steps.append(("update", txn, None))
            continue
        stored = stored_rows.get(txn["transaction_id"])
        if stored is not None:
            plan.steps.append(("update", txn, stored))
            continue
        twin = next(twins)
        if twin is None:
            plan.steps.append(("insert", txn))
            continue
        plan.steps.append(("settle", txn, twin))
        twin_key = (twin["pk"], twin["sk"])
        if twin_key != (_build_pk(txn["account_id"]), _build_sk(txn["transaction_id"])):
            plan.stale_pending_keys.append(twin_key)
    return plan


def apply_plan(
    rows_by_id: dict[str, dict], plan: ReconcilePlan,
    is_unfiled: Optional[Callable[[Optional[str]], bool]] = None,
) -> dict[str, dict]:
    """The rows (keyed by transaction_id) after `plan` is carried out over `rows_by_id`,
    in memory. Mirrors the real save: an update keeps the stored row and overwrites only
    its bank fields (or inserts when there is no stored row), and consumed twins are
    removed after every write, so a pending re-send in the same batch as its own
    settlement does not survive."""
    rows = dict(rows_by_id)
    consumed_twin_ids: set[str] = set()
    for step in plan.steps:
        kind, txn = step[0], step[1]
        transaction_id = txn["transaction_id"]
        if kind == "update":
            existing = rows.get(transaction_id)
            if existing is None:
                rows[transaction_id] = dict(txn)
            else:
                rows[transaction_id] = {**existing, **bank_field_updates(txn, step[2])}
        elif kind == "settle":
            twin = step[2]
            rows[transaction_id] = dict(settle(txn, twin, is_unfiled))
            if twin.get("transaction_id") != transaction_id:
                consumed_twin_ids.add(twin.get("transaction_id"))
        else:
            rows[transaction_id] = dict(txn)
    for twin_id in consumed_twin_ids:
        rows.pop(twin_id, None)
    return rows
