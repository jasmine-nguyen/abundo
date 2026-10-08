"""Shared helpers for the feed, uncategorized, search, apply-rules and rule-route suites.

``real_repos`` builds the REAL TransactionRepository and RuleRepository over one FakeTable
(WHIT-625), so the database rules — the "only if unchanged" write, the rule stamp, rule ids and
dedup — run as production wrote them, not as a hand-written fake copied them. ``_row`` builds a
stored transaction row; ``FakeCategoryRepo`` is a read-only taxonomy stub; ``inject_rule_routes``
points a handler's rule, category and transaction repositories at a ``Repos`` store.

Resolved by pytest.ini's `pythonpath = tests/shared`. Nothing from the shared layer is imported at
module scope: ``real_repos`` imports ``repository`` lazily, so inside a ``handler``-style fixture it
builds the repositories from the same freshly loaded copy the handler uses.
"""

from _api_event import api_event
from _dynamo_fakes import FakeTable

# The internal account ids, in ACCOUNT_ID_MAP order.
ANZ = "anz-rewards-black-visa"
SPENDING = "up-spending"
HOMELOAN = "up-homeloan"
WESTPAC = "westpac-altitude-qantas-black"


def _row(account_id, date, txn_id, **extra):
    """A stored transaction row as the date-index query returns it (with pk/sk)."""
    return {
        "pk": f"ACCOUNT#{account_id}", "sk": f"TXN#{txn_id}",
        "transaction_id": txn_id, "account_id": account_id, "date": date, **extra,
    }


def real_repos(rows_by_account=None, rules=()):
    """``(table, TransactionRepository, RuleRepository)`` over one seeded FakeTable.

    ``rows_by_account`` maps an account id to its ``_row`` rows. Each of ``rules`` is the kwargs of
    one real ``RuleRepository.create_rule`` call, so ids and dedup come from production."""
    from repository import RuleRepository, TransactionRepository

    table = FakeTable()
    for rows in (rows_by_account or {}).values():
        table.seed(*rows)
    transaction_repo = TransactionRepository()
    transaction_repo._table = table
    rule_repo = RuleRepository()
    rule_repo._table = table
    for rule in rules:
        rule_repo.create_rule(**rule)
    return table, transaction_repo, rule_repo


class Repos:
    """``real_repos`` plus the views the rule suites assert on."""

    def __init__(self, rows_by_account=None, rules=()):
        self.table, self.transaction_repo, self.rule_repo = real_repos(rows_by_account, rules)
        self.seeded_rule_ids = {rule["id"] for rule in self.stored_rules()}

    def stored_rules(self):
        """Every rule row, read straight from the store — so it adds nothing to the query log and
        still works while a test makes the table's queries fail."""
        return sorted((row for row in self.table.store.values() if row["pk"] == "RULE"),
                      key=lambda row: row["sk"])

    def rule_id(self, value):
        """The id the store minted for the rule with this value."""
        return next(rule["id"] for rule in self.stored_rules() if rule["value"] == value)

    def minted_rules(self):
        """Rule rows added to the store since setup."""
        return [rule for rule in self.stored_rules() if rule["id"] not in self.seeded_rule_ids]


def _key(account_id, transaction_id):
    return f"ACCOUNT#{account_id}", f"TXN#{transaction_id}"


def stored(table, transaction_id, account_id=SPENDING):
    """The row as the table holds it now (not a copy)."""
    return table.store[_key(account_id, transaction_id)]


def set_category(table, transaction_id, category, account_id=SPENDING):
    """Write a category behind the handler's back — the user's tap, mid-run."""
    stored(table, transaction_id, account_id)["category"] = category


def charge_writes(table):
    """(pk, sk) of every update_item on a charge row, in call order — rule-row writes left out."""
    return [(key["pk"], key["sk"]) for key in table.update_keys if key["pk"].startswith("ACCOUNT#")]


def date_queries(table):
    """The kwargs of each date-index read (the history scan), in call order."""
    return [query for query in table.queries if query.get("IndexName") == "date-index"]


def date_reads(table):
    """Each history read as ``(account_id, start_date, end_date, Limit, cursor)``, in call order —
    read back from the date-index queries the real repository sent."""
    reads = []
    for query in date_queries(table):
        asked = {(name, operator): values
                 for name, operator, *values in query["KeyConditionExpression"].conditions}
        start, end = asked.get(("date", "between")) or (asked.get(("date", "gte"), [None])[0], None)
        reads.append((asked[("account_id", "eq")][0], start, end, query["Limit"],
                      query.get("ExclusiveStartKey")))
    return reads


def fail_writes(table, *transaction_ids):
    """Every write to these charges raises a retryable database error."""
    targets = {f"TXN#{transaction_id}" for transaction_id in transaction_ids}
    table.fail("update_item", when=lambda key: key["sk"] in targets)


def vanish_on_write(table, *transaction_ids):
    """These charges are deleted just before their write lands (aged out / replaced mid-run)."""
    targets = {f"TXN#{transaction_id}" for transaction_id in transaction_ids}

    def delete(key, tbl):
        if key["sk"] in targets:
            tbl.store.pop((key["pk"], key["sk"]), None)

    table.before_write(delete)


def on_write(table, transaction_id, action):
    """Run ``action(table)`` just before the write to ``transaction_id`` — a mid-run edit."""
    table.before_write(
        lambda key, tbl: action(tbl) if key["sk"] == f"TXN#{transaction_id}" else None)


def _feed_event(params=None):
    return api_event("GET", "/transactions/feed", query=params)


def uncategorized_feed_event(params=None):
    return api_event("GET", "/transactions/uncategorized/feed", query=params)


class FakeCategoryRepo:
    """Read-only taxonomy stub: list_categories() over an iterable of category ids.

    Promoted in WHIT-520 — nine feed/uncategorized/apply-rules suites each carried a
    byte-identical private copy (named _FakeCategoryRepo / _CategoryRepo / _Taxonomy /
    _TaxonomyRepo). No default on category_ids: two of those copies had DIFFERENT defaults
    (`("groceries","petrol")` vs `()`), so one shared default would silently mean two things —
    callers state their taxonomy explicitly instead."""

    def __init__(self, category_ids, error=None):
        self._categories = [{"id": category_id} for category_id in category_ids]
        self._error = error
        self.list_calls = 0

    def list_categories(self):
        self.list_calls += 1
        if self._error:
            raise self._error
        return [dict(category) for category in self._categories]


def inject_rule_routes(handler, monkeypatch, store, categories, transactions=None):
    """Point the handler at the real repositories over the store's one FakeTable."""
    for rows in (transactions or {}).values():
        store.table.seed(*rows)
    monkeypatch.setattr(handler, "RuleRepository", lambda: store.rule_repo)
    monkeypatch.setattr(handler, "CategoryRepository", lambda: FakeCategoryRepo(categories))
    monkeypatch.setattr(handler, "TransactionRepository", lambda: store.transaction_repo)


def apply_rules_event(body=None, method="POST", **kwargs):
    return api_event(method, "/transactions/uncategorized/apply-rules", body=body, **kwargs)


def apply_rules_job_post_event(body=None):
    return api_event("POST", "/transactions/uncategorized/apply-rules/jobs", body=body)


def apply_rules_job_get_event(job_id):
    return api_event("GET", f"/transactions/uncategorized/apply-rules/jobs/{job_id}", path_params={"id": job_id})


def rule_put_event(rule_id, value, category_id, field="description", operator="contains"):
    body = {"value": value, "categoryId": category_id, "field": field, "operator": operator}
    return api_event("PUT", f"/rules/{rule_id}", body=body, path_params={"id": rule_id})


def rule_delete_event(rule_id):
    return api_event("DELETE", f"/rules/{rule_id}", path_params={"id": rule_id})
