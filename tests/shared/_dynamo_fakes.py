"""The one in-memory DynamoDB table stand-in for the server suites (WHIT-532, WHIT-625).

FakeTable interprets DynamoDB's expression grammar — the forms the repositories actually build —
instead of matching whitelisted strings, so the REAL repositories run over it unchanged:

- UpdateExpression: SET ``path = :v``, REMOVE ``path``, ADD ``path :v`` (number += / set |=),
  DELETE ``path :v`` (set -=; the attribute goes when empty). Paths are ``#a.#b.#c`` at any depth.
- ConditionExpression: ``attribute_exists(path)``, ``attribute_not_exists(path)``,
  ``path = :v``, ``path <> :v``, ``contains(path, :v)``, ``NOT``, ``AND``, ``OR``, parentheses.
- query: KeyConditionExpression / FilterExpression are the ``_Predicate``s the fake boto3
  ``Key``/``Attr`` build (see ``_boto_stubs``), newest-first ordering, Limit and cursors.

Anything outside that grammar raises AssertionError: a drifted expression must fail loudly, never
pass with its guard dead.

It also enforces three of DynamoDB's validation rules: an UpdateExpression over the 4KB ceiling,
a declared ExpressionAttributeName/Value that no expression uses, and an ADD/DELETE that mixes
set types (a number into a String Set) raise ValidationException.
Reads and writes are deep copies.

Test hooks: ``fail`` (make a call raise), ``before_write`` / ``before_next_write`` (simulate a
concurrent writer), ``stale_index`` (an index that lags the table), ``seed``, and the recorders.

Imported by basename — ``pythonpath = tests/shared`` (pytest.ini). Keep it dependency-light:
``_client_error`` resolves botocore lazily through ``sys.modules`` (the boto stubs install it), so
importing this module pulls in no shared/-layer module and no real boto3/botocore.
"""

import copy
import re
import sys

# DynamoDB's documented UpdateExpression ceiling. Enforced so an expression the real service would
# reject cannot pass in tests — without it, WHIT-405's chunk cap could go and every test stay green.
_MAX_UPDATE_EXPRESSION_BYTES = 4096

# The index keys a query page's LastEvaluatedKey carries, besides the table's own pk/sk.
_INDEX_KEYS = {
    "date-index": ("account_id", "date"),
    "transaction-id-index": ("transaction_id",),
}

_OPERATIONS = ("get_item", "put_item", "update_item", "delete_item", "query", "batch_writer")

_MISSING = object()


def _client_error(code: str, message: str = "boom"):
    """Build a botocore-shaped ClientError the repository's handlers can inspect."""
    err = sys.modules["botocore.exceptions"].ClientError()
    err.response = {"Error": {"Code": code, "Message": message}}
    return err


def _store_key(key):
    return key["pk"], key["sk"]


def _path(expression, names):
    parts = expression.strip().split(".")
    resolved = []
    for part in parts:
        if not re.fullmatch(r"#?[A-Za-z_]\w*", part):
            raise AssertionError(f"FakeTable does not know the document path {expression!r}")
        resolved.append(names[part] if part.startswith("#") else part)
    return resolved


def _get(item, path):
    node = item
    for name in path:
        if not isinstance(node, dict) or name not in node:
            return _MISSING
        node = node[name]
    return node


def _parent(item, path, missing_ok=False):
    """The map holding the path's last segment, copied on the way down so the stored row is never
    mutated in place — an update is built on the copies and committed whole, or not at all.

    A missing or non-map parent is invalid, as in DynamoDB; REMOVE (``missing_ok``) gets None."""
    node = item
    for name in path[:-1]:
        child = node.get(name)
        if not isinstance(child, dict):
            if missing_ok:
                return None
            raise _client_error(
                "ValidationException",
                "The document path provided in the update expression is invalid for update",
            )
        node[name] = dict(child)
        node = node[name]
    return node


def _check_all_used(names, values, *expressions):
    """DynamoDB rejects a declared name or value that no expression references. Word-boundary,
    not substring: "#cat1" occurs inside "#cat10"."""
    text = " ".join(expression for expression in expressions if expression)
    for alias in list(names or {}) + list(values or {}):
        if not re.search(rf"{re.escape(alias)}(?!\w)", text):
            raise _client_error(
                "ValidationException",
                f"Value provided in ExpressionAttributeNames/Values unused in expressions: {alias}",
            )


def _value(token, values):
    if not token.startswith(":") or token not in values:
        raise AssertionError(f"FakeTable does not know the value {token!r}")
    return copy.deepcopy(values[token])


_UPDATE_ACTIONS = re.compile(r"\b(SET|REMOVE|ADD|DELETE)\b")


def _apply_update(item, expression, names, values):
    pieces = _UPDATE_ACTIONS.split(expression.strip())
    if pieces[0].strip():
        raise AssertionError(f"FakeTable does not know UpdateExpression {expression!r}")
    for action, body in zip(pieces[1::2], pieces[2::2]):
        for clause in body.split(","):
            clause = clause.strip()
            if not clause:
                raise AssertionError(f"FakeTable does not know UpdateExpression {expression!r}")
            _apply_clause(item, action, clause, names, values, expression)


def _apply_clause(item, action, clause, names, values, expression):
    if action == "SET":
        target, sep, operand = clause.partition("=")
        if not sep or not operand.strip().startswith(":"):
            raise AssertionError(f"FakeTable does not know SET clause {clause!r} in {expression!r}")
        path = _path(target, names)
        _parent(item, path)[path[-1]] = _value(operand.strip(), values)
        return
    if action == "REMOVE":
        path = _path(clause, names)
        parent = _parent(item, path, missing_ok=True)
        if parent is not None:
            parent.pop(path[-1], None)
        return

    target, _, operand = clause.partition(" ")
    path = _path(target, names)
    operand = _value(operand.strip(), values)
    parent = _parent(item, path)
    current = parent.get(path[-1], _MISSING)
    if isinstance(operand, set):
        _check_set_type(operand, current)
    if action == "ADD":
        if current is _MISSING:
            parent[path[-1]] = operand
        elif isinstance(current, set):
            parent[path[-1]] = current | operand
        else:
            parent[path[-1]] = current + operand
        return
    # DELETE removes members from a set; an emptied set is dropped, as DynamoDB never stores one.
    if current is _MISSING:
        return
    remaining = current - operand
    if remaining:
        parent[path[-1]] = remaining
    else:
        del parent[path[-1]]


def _set_type(members):
    return {"string" if isinstance(member, str) else "number" for member in members}


def _check_set_type(operand, current):
    """A DynamoDB set holds one type (String Set or Number Set); ADD/DELETE must match it."""
    types = _set_type(operand)
    if isinstance(current, set):
        types |= _set_type(current)
    if len(types) > 1:
        raise _client_error("ValidationException", "Type mismatch for attribute to update")


_CONDITION_TOKEN = re.compile(r"\s*(<>|=|\(|\)|,|[#:]?[A-Za-z_][\w.#]*)")


class _Condition:
    """A tiny recursive-descent evaluator for the ConditionExpression forms listed above."""

    def __init__(self, expression, names, values, item):
        self._expression = expression
        self._names = names
        self._values = values
        self._item = item
        self._tokens = self._tokenise(expression)
        self._position = 0

    def _unknown(self):
        return AssertionError(f"FakeTable does not know ConditionExpression {self._expression!r}")

    def _tokenise(self, expression):
        tokens = []
        position = 0
        expression = expression.rstrip()
        while position < len(expression):
            match = _CONDITION_TOKEN.match(expression, position)
            if match is None:
                raise self._unknown()
            tokens.append(match.group(1))
            position = match.end()
        return tokens

    def _peek(self):
        if self._position < len(self._tokens):
            return self._tokens[self._position]
        return None

    def _take(self, expected=None):
        token = self._peek()
        if token is None or (expected is not None and token != expected):
            raise self._unknown()
        self._position += 1
        return token

    def holds(self):
        result = self._or()
        if self._peek() is not None:
            raise self._unknown()
        return result

    def _or(self):
        result = self._and()
        while self._peek() == "OR":
            self._take()
            right = self._and()
            result = result or right
        return result

    def _and(self):
        result = self._not()
        while self._peek() == "AND":
            self._take()
            right = self._not()
            result = result and right
        return result

    def _not(self):
        if self._peek() == "NOT":
            self._take()
            return not self._not()
        return self._primary()

    def _primary(self):
        token = self._take()
        if token == "(":
            result = self._or()
            self._take(")")
            return result
        if token in ("attribute_exists", "attribute_not_exists"):
            self._take("(")
            present = self._operand(self._take()) is not _MISSING
            self._take(")")
            return present if token == "attribute_exists" else not present
        if token == "contains":
            self._take("(")
            container = self._operand(self._take())
            self._take(",")
            member = self._operand(self._take())
            self._take(")")
            return container is not _MISSING and member in container
        left = self._operand(token)
        comparator = self._take()
        right = self._operand(self._take())
        if comparator == "=":
            return left is not _MISSING and left == right
        if comparator == "<>":
            return left != right
        raise self._unknown()

    def _operand(self, token):
        if token.startswith(":"):
            if token not in self._values:
                raise self._unknown()
            return self._values[token]
        if token in ("AND", "OR", "NOT") or not re.fullmatch(r"#?[A-Za-z_]\w*(\.#?[A-Za-z_]\w*)*", token):
            raise self._unknown()
        if self._peek() == "(":
            raise self._unknown()  # a function this evaluator doesn't know, e.g. begins_with
        return _get(self._item, _path(token, self._names))


class FakeTable:
    """In-memory DynamoDB table, injected via ``repo._table``. Store: ``(pk, sk) -> item``."""

    def __init__(self):
        self.store: dict = {}
        self.query_calls = 0          # count, for the older checks
        self.queries: list = []       # each query's kwargs
        self.get_item_calls = 0
        self.get_item_keys: list = []  # the Key of each get_item call, in call order
        self.consistent_reads: list = []
        self.update_calls: list = []  # (UpdateExpression, names, values) per update_item call
        self.update_keys: list = []   # the Key of each update_item call, in the same order
        self.put_calls: list = []     # each put_item Item
        self._failures: list = []
        self._before_write: list = []
        self._next_writes: list = []
        self._stale: dict = {}

    # --- setup and hooks -------------------------------------------------------------------

    def seed(self, *items):
        for item in items:
            self.store[_store_key(item)] = copy.deepcopy(item)

    def fail(self, operation, error=None, when=None):
        """Make every matching call raise ``error`` (default: a throttle ClientError).

        ``when(key)`` narrows it: it gets the call's Key dict (the Item for put_item; the query's
        kwargs for query)."""
        if operation not in _OPERATIONS:
            raise AssertionError(f"FakeTable has no operation {operation!r}")
        self._failures.append((operation, error, when))

    def before_write(self, callback):
        """Run ``callback(key, table)`` before each update_item / delete_item, e.g. to simulate a
        concurrent writer. ``key`` is the call's Key dict."""
        self._before_write.append(callback)

    def before_next_write(self, callback):
        """Like before_write, but runs once. Queued callbacks take successive writes, in order."""
        self._next_writes.append(callback)

    def race_next_update(self):
        """The next update finds its row's version already bumped by someone else (one-shot)."""
        self.before_next_write(lambda key, table: table._bump_version(key))

    def always_race(self):
        """Every update finds its row's version bumped, so an optimistic-lock retry never converges."""
        self._before_write.append(lambda key, table: table._bump_version(key))

    def _bump_version(self, key):
        item = self.store.get(_store_key(key))
        if item is not None:
            item["version"] = item["version"] + 1

    def clear_failures(self):
        self._failures.clear()

    def stale_index(self, key, **fields):
        """Show ``fields`` instead of the row's real values, but only to queries through an index."""
        self._stale.setdefault(_store_key(key), {}).update(fields)

    def _check_failure(self, operation, subject):
        for failing, error, when in self._failures:
            if failing != operation or (when is not None and not when(subject)):
                continue
            if error is not None:
                raise error
            raise _client_error("ProvisionedThroughputExceededException", "rate exceeded")

    def _run_before_write(self, key):
        for callback in list(self._before_write):
            callback(dict(key), self)
        if self._next_writes:
            self._next_writes.pop(0)(dict(key), self)

    # --- DynamoDB surface ------------------------------------------------------------------

    def batch_writer(self):
        table = self

        class _Batch:
            def __enter__(self_):
                return self_

            def __exit__(self_, *exc):
                return False

            def put_item(self_, Item):
                table._check_failure("batch_writer", Item)
                table.store[_store_key(Item)] = copy.deepcopy(Item)

        return _Batch()

    def put_item(self, Item, ConditionExpression=None,
                 ExpressionAttributeNames=None, ExpressionAttributeValues=None):
        self.put_calls.append(copy.deepcopy(Item))
        self._check_failure("put_item", Item)
        _check_all_used(ExpressionAttributeNames, ExpressionAttributeValues, ConditionExpression)
        key = _store_key(Item)
        if ConditionExpression is not None and not self._holds(
            key, ConditionExpression, ExpressionAttributeNames, ExpressionAttributeValues
        ):
            raise _client_error("ConditionalCheckFailedException")
        self.store[key] = copy.deepcopy(Item)

    def get_item(self, Key, ConsistentRead=False):
        self.get_item_calls += 1
        self.get_item_keys.append(dict(Key))
        self.consistent_reads.append(ConsistentRead)
        self._check_failure("get_item", Key)
        item = self.store.get(_store_key(Key))
        if item is None:
            return {}
        return {"Item": copy.deepcopy(item)}

    def update_item(self, Key, UpdateExpression, ExpressionAttributeNames=None,
                    ExpressionAttributeValues=None, ConditionExpression=None):
        names = ExpressionAttributeNames or {}
        values = ExpressionAttributeValues or {}
        self.update_calls.append((UpdateExpression, dict(names), dict(values)))
        self.update_keys.append(dict(Key))
        self._run_before_write(Key)
        self._check_failure("update_item", Key)
        expression_bytes = len(UpdateExpression.encode())
        if expression_bytes > _MAX_UPDATE_EXPRESSION_BYTES:
            raise _client_error(
                "ValidationException",
                f"Invalid UpdateExpression: expression is too large; "
                f"{expression_bytes} bytes exceeds the {_MAX_UPDATE_EXPRESSION_BYTES} limit",
            )
        _check_all_used(names, values, UpdateExpression, ConditionExpression)
        key = _store_key(Key)
        if ConditionExpression is not None and not self._holds(key, ConditionExpression, names, values):
            raise _client_error("ConditionalCheckFailedException")
        # Build on a copy and commit only once every clause applied, so a refused write changes nothing.
        item = dict(self.store.get(key, {"pk": Key["pk"], "sk": Key["sk"]}))
        _apply_update(item, UpdateExpression, names, values)
        self.store[key] = item

    def delete_item(self, Key, ConditionExpression=None,
                    ExpressionAttributeNames=None, ExpressionAttributeValues=None):
        self._run_before_write(Key)
        self._check_failure("delete_item", Key)
        _check_all_used(ExpressionAttributeNames, ExpressionAttributeValues, ConditionExpression)
        key = _store_key(Key)
        if ConditionExpression is not None and not self._holds(
            key, ConditionExpression, ExpressionAttributeNames, ExpressionAttributeValues
        ):
            raise _client_error("ConditionalCheckFailedException")
        self.store.pop(key, None)

    def query(self, **kwargs):
        unknown = set(kwargs) - {"KeyConditionExpression", "FilterExpression", "ScanIndexForward",
                                 "Limit", "IndexName", "ExclusiveStartKey", "ConsistentRead"}
        if unknown:
            raise AssertionError(f"FakeTable.query does not know {sorted(unknown)}")
        self.query_calls += 1
        self.queries.append(dict(kwargs))
        self._check_failure("query", kwargs)
        index_name = kwargs.get("IndexName")
        if index_name is not None and index_name not in _INDEX_KEYS:
            raise AssertionError(f"FakeTable does not know index {index_name!r}")

        items = [copy.deepcopy(item) for item in self.store.values()]
        if index_name is not None:
            for item in items:
                item.update(copy.deepcopy(self._stale.get(_store_key(item), {})))
        for predicate in (kwargs.get("KeyConditionExpression"), kwargs.get("FilterExpression")):
            if predicate is not None:
                items = [item for item in items if predicate.evaluate(item)]

        # date-index reads sort by date; ScanIndexForward=False → newest first.
        items.sort(
            key=lambda item: (item.get("date", ""), item.get("sk", "")),
            reverse=kwargs.get("ScanIndexForward") is False,
        )

        start = kwargs.get("ExclusiveStartKey")
        if start is not None:
            after = _store_key(start)
            for position, item in enumerate(items):
                if _store_key(item) == after:
                    items = items[position + 1:]
                    break

        limit = kwargs.get("Limit")
        if limit is None or len(items) <= limit:
            return {"Items": items}
        page = items[:limit]
        last = page[-1]
        cursor_fields = _INDEX_KEYS.get(index_name, ()) + ("pk", "sk")
        return {"Items": page, "LastEvaluatedKey": {name: last[name] for name in cursor_fields}}

    def _holds(self, key, expression, names, values):
        item = self.store.get(key, {})
        return _Condition(expression, names or {}, values or {}, item).holds()
