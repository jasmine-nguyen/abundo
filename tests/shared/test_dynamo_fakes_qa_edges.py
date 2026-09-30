"""QA edge tests for the one general FakeTable (WHIT-625 slice 1).

test_dynamo_fakes.py pins the happy path of each form in one long test. These pin each grammar
form on its own — both the true and the false branch — plus the boundaries (the exact 4KB edge,
atomic refusal, deep copies, cursors) and the folder-built _REIMPORT list.
"""

import pathlib
import sys
from decimal import Decimal

import pytest
from botocore.exceptions import ClientError

from _boto_stubs import _Field
from _dynamo_fakes import _MAX_UPDATE_EXPRESSION_BYTES, FakeTable, error_code

_KEY = {"pk": "A", "sk": "A"}
_SHARED_DIR = pathlib.Path(__file__).resolve().parents[2] / "shared"


def _table(**fields):
    table = FakeTable()
    table.seed({"pk": "A", "sk": "A", **fields})
    return table


def _conditional_set(table, condition, names=None, values=None):
    """SET #mark = :mark under ``condition``; True if written, False if refused."""
    names = {"#mark": "mark", **(names or {})}
    values = {":mark": "written", **(values or {})}
    try:
        table.update_item(Key=_KEY, UpdateExpression="SET #mark = :mark",
                          ConditionExpression=condition,
                          ExpressionAttributeNames=names, ExpressionAttributeValues=values)
    except ClientError as err:
        assert err.response["Error"]["Code"] == "ConditionalCheckFailedException"
        assert "mark" not in table.store[("A", "A")]  # a refused write changes nothing
        return False
    assert table.store[("A", "A")]["mark"] == "written"
    return True


# --- [A1] each condition form, both branches ----------------------------------------------

@pytest.mark.parametrize("condition, names, values, expected", [
    # [A1a] attribute_exists / attribute_not_exists on a flat and a nested path
    ("attribute_exists(#c)", {"#c": "category"}, {}, True),
    ("attribute_exists(#c)", {"#c": "missing"}, {}, False),
    ("attribute_not_exists(#c)", {"#c": "category"}, {}, False),
    ("attribute_not_exists(#c)", {"#c": "missing"}, {}, True),
    ("attribute_exists(#i.#id)", {"#i": "items", "#id": "food"}, {}, True),
    ("attribute_exists(#i.#id)", {"#i": "items", "#id": "gym"}, {}, False),
    ("attribute_not_exists(#i.#id.#p)", {"#i": "items", "#id": "food", "#p": "parent"}, {}, False),
    ("attribute_not_exists(#i.#id.#p)", {"#i": "items", "#id": "gym", "#p": "parent"}, {}, True),
    # [A1b] = and <>: equal, unequal, and against an absent attribute
    ("#c = :v", {"#c": "category"}, {":v": "food"}, True),
    ("#c = :v", {"#c": "category"}, {":v": "rent"}, False),
    ("#c = :v", {"#c": "missing"}, {":v": "food"}, False),
    ("#c <> :v", {"#c": "category"}, {":v": "rent"}, True),
    ("#c <> :v", {"#c": "category"}, {":v": "food"}, False),
    ("#v = :v", {"#v": "version"}, {":v": 3}, True),  # Decimal(3) == 3
    ("#i.#id.#p = :v", {"#i": "items", "#id": "food", "#p": "parent"}, {":v": None}, True),
    # [A1c] contains over a string set
    ("contains(#f, :v)", {"#f": "fired"}, {":v": "a"}, True),
    ("contains(#f, :v)", {"#f": "fired"}, {":v": "z"}, False),
    ("contains(#f, :v)", {"#f": "missing"}, {":v": "a"}, False),
    # [A1d] NOT, AND, OR, and precedence (NOT > AND > OR), parentheses override
    ("NOT attribute_exists(#c)", {"#c": "category"}, {}, False),
    ("NOT NOT attribute_exists(#c)", {"#c": "category"}, {}, True),
    ("attribute_exists(#c) AND #c = :v", {"#c": "category"}, {":v": "rent"}, False),
    ("attribute_exists(#c) OR #c = :v", {"#c": "category"}, {":v": "rent"}, True),
    # true OR (false AND false) → true; (true OR false) AND false → false
    ("attribute_exists(pk) OR attribute_exists(#x) AND attribute_exists(#x)", {"#x": "missing"}, {}, True),
    ("(attribute_exists(pk) OR attribute_exists(#x)) AND attribute_exists(#x)", {"#x": "missing"}, {}, False),
    ("NOT attribute_exists(#x) AND attribute_exists(pk)", {"#x": "missing"}, {}, True),
    ("NOT (attribute_exists(#x) OR attribute_exists(pk))", {"#x": "missing"}, {}, False),
])
def test_each_condition_form_holds_or_refuses_like_dynamodb(condition, names, values, expected):
    # [A1] FAIL-ON-REVERT: flip any comparator, NOT, or the AND/OR precedence in _Condition and
    # at least one row here writes when it should be refused (or vice versa).
    table = _table(category="food", version=Decimal(3), fired={"a", "b"},
                   items={"food": {"name": "Food", "parent": None}})
    assert _conditional_set(table, condition, names, values) is expected


def test_attribute_exists_pk_on_an_absent_row_is_refused_and_invents_nothing():
    # [A1e] the "only if the row is still there" guard: a refused write must not create the row.
    table = FakeTable()
    with pytest.raises(ClientError) as refused:
        table.update_item(Key=_KEY, UpdateExpression="SET #c = :c",
                          ConditionExpression="attribute_exists(pk)",
                          ExpressionAttributeNames={"#c": "category"},
                          ExpressionAttributeValues={":c": "food"})
    assert error_code(refused) == "ConditionalCheckFailedException"
    assert table.store == {}


def test_conditional_put_and_delete_are_evaluated_too():
    # [A3] put_item / delete_item conditions go through the same evaluator.
    table = _table(filed_by_rule="r1")
    with pytest.raises(ClientError) as put_refused:
        table.put_item(Item={"pk": "A", "sk": "A", "new": True},
                       ConditionExpression="attribute_not_exists(pk)")
    assert error_code(put_refused) == "ConditionalCheckFailedException"
    assert "new" not in table.store[("A", "A")]

    with pytest.raises(ClientError) as delete_refused:
        table.delete_item(Key=_KEY, ConditionExpression="#p = :rule",
                          ExpressionAttributeNames={"#p": "filed_by_rule"},
                          ExpressionAttributeValues={":rule": "r2"})
    assert error_code(delete_refused) == "ConditionalCheckFailedException"
    assert ("A", "A") in table.store

    table.delete_item(Key=_KEY, ConditionExpression="#p = :rule",
                      ExpressionAttributeNames={"#p": "filed_by_rule"},
                      ExpressionAttributeValues={":rule": "r1"})
    assert table.store == {}


# --- [A2] anything outside the grammar fails loudly ----------------------------------------

@pytest.mark.parametrize("condition, names, values", [
    ("begins_with(#c, :v)", {"#c": "category"}, {":v": "f"}),
    ("size(#c) = :v", {"#c": "category"}, {":v": 4}),
    ("#v < :v", {"#v": "version"}, {":v": 4}),
    ("#v >= :v", {"#v": "version"}, {":v": 4}),
    ("#v BETWEEN :lo AND :hi", {"#v": "version"}, {":lo": 1, ":hi": 9}),
    ("#c IN (:a, :b)", {"#c": "category"}, {":a": "food", ":b": "rent"}),
    ("attribute_exists(#c) and #c = :v", {"#c": "category"}, {":v": "food"}),  # lowercase keyword
    ("attribute_type(#c, :t)", {"#c": "category"}, {":t": "S"}),
    ("attribute_exists(#c", {"#c": "category"}, {}),  # unbalanced
    ("#c = :typo", {"#c": "category"}, {":v": "food"}),  # an undeclared value
])
def test_an_unknown_condition_form_raises_instead_of_passing(condition, names, values):
    # [A2] FAIL-ON-REVERT: make _Condition treat an unknown token as true/false and the drifted
    # guard would silently pass here.
    table = _table(category="food", version=Decimal(3))
    before = dict(table.store[("A", "A")])
    with pytest.raises((AssertionError, ClientError)) as raised:
        table.update_item(Key=_KEY, UpdateExpression="SET #c = :c",
                          ConditionExpression=condition,
                          ExpressionAttributeNames={"#c": "category", **names},
                          ExpressionAttributeValues={":c": "written", **values})
    if raised.type is ClientError:  # the undeclared-value case is DynamoDB's own ValidationException
        assert error_code(raised) == "ValidationException"
    assert table.store[("A", "A")] == before


@pytest.mark.parametrize("expression, values", [
    ("SET #c = if_not_exists(#c, :c)", {":c": 1}),
    ("SET #c = #c + :c", {":c": 1}),
    ("SET #c = list_append(#c, :c)", {":c": [1]}),
    ("SET #c = :typo", {":c": 1}),
    ("#c = :c", {":c": 1}),  # no action keyword
    ("SET #c = :c,", {":c": 1}),  # dangling comma
])
def test_an_unknown_update_form_raises_instead_of_passing(expression, values):
    # [A2] FAIL-ON-REVERT: loosen _apply_clause's SET operand check and these write silently.
    table = _table(c=0)
    with pytest.raises((AssertionError, ClientError)):
        table.update_item(Key=_KEY, UpdateExpression=expression,
                          ExpressionAttributeNames={"#c": "c"}, ExpressionAttributeValues=values)
    assert table.store[("A", "A")]["c"] == 0


# --- [A3] a refused or invalid update is all-or-nothing ------------------------------------

def test_a_later_clause_failing_leaves_the_nested_map_and_earlier_clauses_unwritten():
    # [A3] FAIL-ON-REVERT: build the update on the stored row instead of a copy (drop the
    # copy-on-descend in _parent) and #items.#a leaks into the store before #nope.#b fails.
    table = _table(items={"a": {"n": 1}}, version=1)
    with pytest.raises(ClientError) as invalid:
        table.update_item(Key=_KEY, UpdateExpression="SET #items.#a.#n = :two, #nope.#b = :two",
                          ExpressionAttributeNames={"#items": "items", "#a": "a", "#n": "n",
                                                    "#nope": "nope", "#b": "b"},
                          ExpressionAttributeValues={":two": 2})
    assert error_code(invalid) == "ValidationException"
    assert table.store[("A", "A")]["items"] == {"a": {"n": 1}}


def test_a_failed_version_lock_writes_no_clause():
    table = _table(items={"a": 1}, version=5)
    with pytest.raises(ClientError):
        table.update_item(Key=_KEY, UpdateExpression="REMOVE #items.#a SET #v = :next",
                          ConditionExpression="attribute_exists(pk) AND #v = :expected",
                          ExpressionAttributeNames={"#items": "items", "#a": "a", "#v": "version"},
                          ExpressionAttributeValues={":next": 5, ":expected": 4})
    assert table.store[("A", "A")] == {"pk": "A", "sk": "A", "items": {"a": 1}, "version": 5}


# --- [A4] the 4KB ceiling, exactly at the edge ---------------------------------------------

def _set_expression_of(length):
    head = "SET #c = :c, #d = :d"
    return head + " " * (length - len(head))


def test_an_update_expression_of_exactly_4096_bytes_is_accepted_and_4097_is_rejected():
    # [A4] FAIL-ON-REVERT: change `>` to `>=` (or drop the check) and one side of the edge flips.
    table = _table()
    names = {"#c": "c", "#d": "d"}
    values = {":c": 1, ":d": 2}
    at_limit = _set_expression_of(_MAX_UPDATE_EXPRESSION_BYTES)
    assert len(at_limit.encode()) == 4096
    table.update_item(Key=_KEY, UpdateExpression=at_limit,
                      ExpressionAttributeNames=names, ExpressionAttributeValues=values)
    assert table.store[("A", "A")]["c"] == 1

    with pytest.raises(ClientError) as too_large:
        table.update_item(Key=_KEY, UpdateExpression=_set_expression_of(4097),
                          ExpressionAttributeNames=names, ExpressionAttributeValues={":c": 9, ":d": 9})
    assert error_code(too_large) == "ValidationException"
    assert table.store[("A", "A")]["c"] == 1


def test_the_4kb_ceiling_counts_bytes_not_characters():
    # [A4] an alias of 2,045 two-byte characters: under 4,096 characters, over 4,096 bytes.
    table = _table()
    alias = "#c" + "é" * 2045
    expression = f"SET {alias} = :c"
    assert len(expression) < 4096 < len(expression.encode())
    with pytest.raises(ClientError) as too_large:
        table.update_item(Key=_KEY, UpdateExpression=expression,
                          ExpressionAttributeNames={alias: "c"}, ExpressionAttributeValues={":c": 1})
    assert error_code(too_large) == "ValidationException"


# --- [A5] upsert, ADD and DELETE edges ------------------------------------------------------

def test_an_unconditional_update_on_a_missing_row_creates_it_with_its_key():
    # [A5] the old setdefault upsert semantics the plan keeps.
    table = FakeTable()
    table.update_item(Key={"pk": "N", "sk": "1"}, UpdateExpression="ADD #n :one SET #t = :t",
                      ExpressionAttributeNames={"#n": "count", "#t": "ttl"},
                      ExpressionAttributeValues={":one": 1, ":t": 9})
    assert table.store[("N", "1")] == {"pk": "N", "sk": "1", "count": 1, "ttl": 9}


def test_add_accumulates_numbers_and_unions_sets_across_calls():
    table = _table(count=Decimal(2))
    for _ in range(3):
        table.update_item(Key=_KEY, UpdateExpression="ADD #n :one, #f :m",
                          ExpressionAttributeNames={"#n": "count", "#f": "fired"},
                          ExpressionAttributeValues={":one": 1, ":m": {"x"}})
    assert table.store[("A", "A")]["count"] == 5
    assert table.store[("A", "A")]["fired"] == {"x"}


def test_delete_removes_only_the_named_members_and_is_a_no_op_on_an_absent_set():
    table = _table(fired={"a", "b", "c"})
    table.update_item(Key=_KEY, UpdateExpression="DELETE #f :m",
                      ExpressionAttributeNames={"#f": "fired"}, ExpressionAttributeValues={":m": {"a", "z"}})
    assert table.store[("A", "A")]["fired"] == {"b", "c"}

    table.update_item(Key=_KEY, UpdateExpression="DELETE #g :m",
                      ExpressionAttributeNames={"#g": "other"}, ExpressionAttributeValues={":m": {"a"}})
    assert "other" not in table.store[("A", "A")]


def test_remove_under_a_missing_parent_or_of_a_missing_attribute_is_a_no_op():
    table = _table(items={"a": 1})
    table.update_item(Key=_KEY, UpdateExpression="REMOVE #nope.#x, #items.#b, #gone",
                      ExpressionAttributeNames={"#nope": "nope", "#x": "x", "#items": "items",
                                                "#b": "b", "#gone": "gone"})
    assert table.store[("A", "A")] == {"pk": "A", "sk": "A", "items": {"a": 1}}


def test_a_set_through_a_non_map_parent_is_invalid():
    table = _table(items="not-a-map")
    with pytest.raises(ClientError) as invalid:
        table.update_item(Key=_KEY, UpdateExpression="SET #items.#a = :v",
                          ExpressionAttributeNames={"#items": "items", "#a": "a"},
                          ExpressionAttributeValues={":v": 1})
    assert error_code(invalid) == "ValidationException"


# --- [A6] reads and writes are deep copies -------------------------------------------------

def test_mutating_what_was_passed_in_or_read_back_never_reaches_the_store():
    # [A6] FAIL-ON-REVERT: swap any copy.deepcopy in FakeTable for dict(...) and a nested alias
    # leaks one of these mutations into the stored row.
    table = FakeTable()
    seeded = {"pk": "A", "sk": "A", "items": {"a": {"n": 1}}}
    table.seed(seeded)
    seeded["items"]["a"]["n"] = 99

    put = {"pk": "B", "sk": "B", "items": {"b": {"n": 1}}}
    table.put_item(Item=put)
    put["items"]["b"]["n"] = 99

    value = {"n": 1}
    table.update_item(Key=_KEY, UpdateExpression="SET #items.#c = :v",
                      ExpressionAttributeNames={"#items": "items", "#c": "c"},
                      ExpressionAttributeValues={":v": value})
    value["n"] = 99

    queried = table.query(KeyConditionExpression=_Field("pk").eq("A"))["Items"][0]
    queried["items"]["a"]["n"] = 99

    assert table.store[("A", "A")]["items"] == {"a": {"n": 1}, "c": {"n": 1}}
    assert table.store[("B", "B")]["items"] == {"b": {"n": 1}}


# --- [A9] fail() hooks ----------------------------------------------------------------------

def test_fail_narrows_by_subject_for_put_and_query_and_rejects_an_unknown_operation():
    table = FakeTable()
    table.fail("put_item", when=lambda item: item["sk"] == "bad")
    table.fail("query", when=lambda kwargs: kwargs.get("IndexName") == "date-index")

    table.put_item(Item={"pk": "A", "sk": "good", "account_id": "1", "date": "2026-09-01"})
    with pytest.raises(ClientError) as throttled:
        table.put_item(Item={"pk": "A", "sk": "bad"})
    assert error_code(throttled) == "ProvisionedThroughputExceededException"
    assert ("A", "bad") not in table.store

    assert len(table.query(KeyConditionExpression=_Field("pk").eq("A"))["Items"]) == 1
    with pytest.raises(ClientError):
        table.query(IndexName="date-index", KeyConditionExpression=_Field("account_id").eq("1"))

    with pytest.raises(AssertionError):
        table.fail("scan")


def test_a_failed_update_writes_nothing():
    table = _table(category="food")
    table.fail("update_item")
    with pytest.raises(ClientError):
        table.update_item(Key=_KEY, UpdateExpression="SET #c = :c",
                          ExpressionAttributeNames={"#c": "category"}, ExpressionAttributeValues={":c": "rent"})
    assert table.store[("A", "A")]["category"] == "food"


# --- [A10] stale_index is index-only --------------------------------------------------------

def test_stale_index_overlays_only_index_queries_never_base_table_queries_or_reads():
    # [A10] FAIL-ON-REVERT: apply the overlay to every query and the base-table read goes stale.
    table = _table(account_id="1", date="2026-09-01", category="food")
    table.stale_index(_KEY, category=None)

    by_index = table.query(IndexName="date-index", KeyConditionExpression=_Field("account_id").eq("1"))
    by_table = table.query(KeyConditionExpression=_Field("pk").eq("A"))

    assert by_index["Items"][0]["category"] is None
    assert by_table["Items"][0]["category"] == "food"
    assert table.store[("A", "A")]["category"] == "food"


# --- [A11] pagination -----------------------------------------------------------------------

def test_walking_every_page_returns_each_row_once_newest_first():
    # [A11] FAIL-ON-REVERT: drop the ExclusiveStartKey skip and page 2 repeats page 1.
    table = FakeTable()
    table.seed(*({"pk": "ACC#1", "sk": f"T{day}", "account_id": "1", "date": f"2026-09-{day:02d}"}
                 for day in range(1, 8)))
    seen, start = [], None
    for _ in range(10):  # a cursor that never advances must fail, not hang
        kwargs = {"IndexName": "date-index", "KeyConditionExpression": _Field("account_id").eq("1"),
                  "ScanIndexForward": False, "Limit": 3}
        if start is not None:
            kwargs["ExclusiveStartKey"] = start
        page = table.query(**kwargs)
        seen += [row["date"] for row in page["Items"]]
        start = page.get("LastEvaluatedKey")
        if start is None:
            break
    assert seen == [f"2026-09-{day:02d}" for day in range(7, 0, -1)]
    assert table.query_calls == 3
    assert [call.get("ExclusiveStartKey") is None for call in table.queries] == [True, False, False]


# --- [A14] DynamoDB's unused-alias rule applies to put/delete too --------------------------

def test_an_unused_alias_on_a_conditional_put_or_delete_is_rejected():
    table = _table()
    with pytest.raises(ClientError) as put_unused:
        table.put_item(Item={"pk": "B", "sk": "B"}, ConditionExpression="attribute_not_exists(pk)",
                       ExpressionAttributeNames={"#spare": "x"})
    with pytest.raises(ClientError) as delete_unused:
        table.delete_item(Key=_KEY, ConditionExpression="attribute_exists(pk)",
                          ExpressionAttributeValues={":spare": 1})
    assert error_code(put_unused) == "ValidationException"
    assert error_code(delete_unused) == "ValidationException"
    assert ("B", "B") not in table.store
    assert ("A", "A") in table.store


# --- [A15] config_item_table fixture --------------------------------------------------------

def test_config_item_table_seeds_one_config_item_or_none(config_item_table):
    table = config_item_table("GOALS", items={"g1": {"name": "Trip"}}, version=4)
    assert table.store == {("GOALS", "GOALS"): {
        "pk": "GOALS", "sk": "GOALS", "items": {"g1": {"name": "Trip"}}, "version": Decimal(4)}}
    assert config_item_table("GOALS", present=False).store == {}


# --- [A12] the folder-built _REIMPORT sheds every shared/ module ---------------------------

def test_the_shared_fixture_sheds_every_shared_module_but_the_ssm_stub(request):
    # [A12] Replaces the deleted [A19] guard (test_chart_ramp_parser_edges.py). Plant a stale
    # module under every shared/ name; the `shared` fixture must shed each one (ssm excepted —
    # that name is _boto_stubs' fake). FAIL-ON-REVERT: drop any name from conftest._REIMPORT.
    stems = sorted(path.stem for path in _SHARED_DIR.glob("*.py") if path.stem != "ssm")
    stale = {stem: type(sys)(f"stale_{stem}") for stem in stems}
    originals = {stem: sys.modules.get(stem) for stem in stems}

    def restore():
        for stem in stems:
            sys.modules.pop(stem, None)
            if originals[stem] is not None:
                sys.modules[stem] = originals[stem]

    request.addfinalizer(restore)  # registered first → runs after the fixture's own teardown
    sys.modules.update(stale)
    request.getfixturevalue("shared")

    leaked = [stem for stem in stems if sys.modules.get(stem) is stale[stem]]
    assert leaked == []
