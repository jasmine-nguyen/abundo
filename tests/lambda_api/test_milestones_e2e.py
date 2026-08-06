"""WHIT-465 e2e — the milestone READ/SAVE + poller paths end to end over the REAL repository.

Merges four former per-WHIT e2e gap suites (corrupt_row [A6-A8], live_keys [L6], whit417 [F1-F3],
whit424 [W1-W3]) into one topical survivor (WHIT-465 Slice 5). Each test drives the REAL
MilestoneRepository (real _to_client / _resolve_plan) behind an in-memory table, through
lambda_handler and/or the poller's notify_milestone_crossing over ONE shared store — the seam no
shared-layer unit test can reach.

  [A6] GET /milestones body is strict-parsable JSON (no NaN/Infinity token), corrupt row absent.
  [A7] over-rejection guard (client read): every row PUT accepts survives GET.
  [A8] GET with every row corrupt -> 200 [], never null, never 500.
  [L6] a hidden row's marker survives every poll while stored, swept on the first poll after the
       user's next save drops the row.
  [F1] every row PUT accepts still resolves in the poller AND still celebrates.
  [F2] every real calendar date the save endpoint accepts is readable by row_date.
  [F3] the read rule and the write rule agree on rejecting the lenient ISO forms.
  [W1] an unreadable-but-identifiable row keeps its marker across polls; repair + re-cross sends
       no second celebration.
  [W2] retargeting through a second PUT sweeps the old marker and re-arms the new amount.
  [W3] the save endpoint rejects a shape-matching-but-uncalendar date (one shared validator).

The `poller` fixture imports shared/milestones.py in the handler's sys.path window (the module the
balance poller loads) and restores the module table afterwards, so the shared-layer suite is
untouched.
"""

import datetime
import json
import sys
from decimal import Decimal

import pytest


# --- harness ----------------------------------------------------------------

class FakeConfigTable:
    """The single-config-item slice DynamoDB MilestoneRepository uses (get_item/put_item on
    pk=MILESTONES, sk=<scope>), injected as repo._table so the real set_milestones /
    _read_milestones / _to_client / _resolve_plan all run unmodified."""

    def __init__(self):
        self.store = {}

    def get_item(self, Key):
        item = self.store.get((Key["pk"], Key["sk"]))
        return {"Item": dict(item)} if item is not None else {}

    def put_item(self, Item, ConditionExpression=None):
        self.store[(Item["pk"], Item["sk"])] = dict(Item)


@pytest.fixture
def milestone_repo(handler, monkeypatch):
    # Swaps handler.MilestoneRepository to this real repo (backed by an in-memory table) so every
    # test driving lambda_handler / the poller reads and writes the one store.
    repo = handler.MilestoneRepository()
    repo._table = FakeConfigTable()
    monkeypatch.setattr(handler, "MilestoneRepository", lambda: repo)
    return repo


@pytest.fixture
def poller(handler):
    """shared/milestones.py — the module lambda_balance_poller/handler.py imports. Restored
    afterwards so the shared-layer suite's own import isolation is unaffected. Saves the superset
    of module names any merged test touches (milestones, milestone_rows, iso_date)."""
    saved = {name: sys.modules.get(name) for name in ("milestones", "milestone_rows", "iso_date")}
    import milestones
    try:
        yield milestones
    finally:
        for name, mod in saved.items():
            if mod is None:
                sys.modules.pop(name, None)
            else:
                sys.modules[name] = mod


class FakeDeviceRepo:
    def list_tokens(self):
        return ["tok"]


class FakeLoanFactsRepo:
    def get_loanfacts(self):
        return None


class FakeNotifyRepo:
    """Reused across polls in a test, so it accumulates fired markers and removals like the real
    DynamoDB-backed marker set does between daily polls. The empty-guard assert in remove pins that
    the sweep never calls remove_milestone_markers with an empty set."""

    def __init__(self, fired=None):
        self.fired = set(fired or set())
        self.removed = set()

    def fired_milestones(self, scope=None):
        return set(self.fired)

    def mark_milestone_fired(self, key, scope=None):
        self.fired.add(key)

    def remove_milestone_markers(self, keys, scope=None):
        assert keys, "must guard empty before calling remove_milestone_markers"
        self.removed |= set(keys)
        self.fired -= set(keys)


def _get_event():
    return {"rawPath": "/milestones",
            "requestContext": {"http": {"method": "GET"}}, "body": ""}


def _put_event(rows):
    return {"rawPath": "/milestones", "requestContext": {"http": {"method": "PUT"}},
            "body": json.dumps({"milestones": rows}), "isBase64Encoded": False}


def _store_raw(repo, rows, scope="SHARED"):
    """Inject stored rows directly, bypassing set_milestones' validation — a legacy or
    directly-written row (mirrors tests/shared/test_repository_milestone.py)."""
    repo._table.store[("MILESTONES", scope)] = {
        "pk": "MILESTONES", "sk": scope, "milestones": rows,
    }


GOOD = {"id": "good", "label": "Quarter down", "targetBalance": Decimal("400000"),
        "targetDate": "2030-01-01"}


def _row(**overrides):
    return {**GOOD, **overrides}


# === [A6]/[A8] GET /milestones body is strict JSON, corrupt rows dropped =====================

@pytest.mark.parametrize("bad_target", [Decimal("NaN"), Decimal("Infinity"), Decimal("-Infinity")])
def test_get_milestones_body_is_strict_json_without_the_corrupt_row(
        handler, milestone_repo, bad_target):
    # [A6] The literal HTTP body, not the repo return value. json.dumps defaults to
    # allow_nan=True and emits bare NaN/Infinity tokens, which no JSON parser outside
    # Python accepts — so ONE corrupt row made the whole plan unreadable to the app, not
    # just that row. json.loads is deliberately given parse_constant, because Python's own
    # json.loads happily reads those tokens back and would hide the bug.
    _store_raw(milestone_repo, [GOOD, _row(id="bad", targetBalance=bad_target)])

    resp = handler.lambda_handler(_get_event(), None)
    assert resp["statusCode"] == 200
    def _reject(token):
        raise AssertionError(f"non-JSON token {token!r} in the milestones body")
    parsed = json.loads(resp["body"], parse_constant=_reject)
    assert parsed == [{"id": "good", "label": "Quarter down",
                       "targetBalance": 400000.0, "targetDate": "2030-01-01"}]


def test_get_milestones_with_every_row_corrupt_is_an_empty_list_not_null(
        handler, milestone_repo):
    # [A8] All rows unusable -> 200 [] (the app falls back to its built-in default plan),
    # never a literal null and never a 500.
    _store_raw(milestone_repo, [_row(id="a", label=""), _row(id="b", targetDate="nope"), 42])

    resp = handler.lambda_handler(_get_event(), None)
    assert resp["statusCode"] == 200
    assert json.loads(resp["body"]) == []


# === [A7] the over-rejection guard (client read): a saved row must never vanish ==============

_ROUND_TRIP = [
    {"label": "x" * 100, "targetBalance": 1_000_000_000, "targetDate": "2027-02-28"},
    {"label": "Ünïcödé 🎉 目標", "targetBalance": 595413.43, "targetDate": "2028-02-29"},
    {"label": "Paid off", "targetBalance": 0, "targetDate": "2030-12-31"},
]


def test_every_row_the_save_endpoint_accepts_survives_the_read(handler, milestone_repo):
    # [A7] The risk WHIT-394 introduces is the mirror of the bug it fixes: a read rule
    # STRICTER than the write rule silently deletes rows from a user's saved plan on the
    # way back. Boundary rows on purpose — the balance cap, a 0 balance, a 100-char label,
    # a non-ASCII label, and a leap day (which date.fromisoformat only accepts in a leap
    # year). PUT then GET through lambda_handler, one repository, no fakes in between.
    put = handler.lambda_handler(_put_event(_ROUND_TRIP), None)
    assert put["statusCode"] == 200, put["body"]
    assert len(json.loads(put["body"])) == 3, "set_milestones' own return dropped a row"

    got = json.loads(handler.lambda_handler(_get_event(), None)["body"])
    assert [m["label"] for m in got] == [r["label"] for r in _ROUND_TRIP]
    assert [m["targetBalance"] for m in got] == [1_000_000_000.0, 595413.43, 0.0]
    assert [m["targetDate"] for m in got] == [r["targetDate"] for r in _ROUND_TRIP]


# === [L6] a hidden row's marker survives until the next save drops the row ===================

_HIDDEN_ROW_PLAN = [
    {"label": "Quarter down", "targetBalance": 400000, "targetDate": "2030-01-01"},
    {"label": "Halfway", "targetBalance": 250000, "targetDate": "2031-01-01"},
]


def test_a_hidden_rows_marker_survives_until_the_next_save_drops_the_row(
        handler, milestone_repo, poller, monkeypatch):
    # [L6] The full life of the marker WHIT-417 newly protects.
    pushes = []
    monkeypatch.setattr(poller, "send_push",
                        lambda title, body, tokens, **kw: pushes.append(title))
    notify = FakeNotifyRepo()

    def poll(old, new):
        return poller.notify_milestone_crossing(
            Decimal(old), Decimal(new), loanfacts_repo=FakeLoanFactsRepo(),
            device_repo=FakeDeviceRepo(), notify_repo=notify, milestone_repo=milestone_repo)

    # 1. The user saves a plan and genuinely earns the first milestone.
    put = handler.lambda_handler(_put_event(_HIDDEN_ROW_PLAN), None)
    assert put["statusCode"] == 200, put["body"]
    quarter_id, half_id = [row["id"] for row in json.loads(put["body"])]
    quarter_marker = f"id:{quarter_id}:bal:400000.00"

    assert poll("410000", "395000") == 1
    assert pushes == ["\U0001f389 Milestone reached — Quarter down!"]
    assert notify.fired == {quarter_marker}

    # 2. That row's stored date is corrupted (a legacy or hand-written value — the save endpoint
    # can't produce one). The row is now unreadable on BOTH paths.
    stored = milestone_repo._table.store[("MILESTONES", "SHARED")]["milestones"]
    stored[0]["targetDate"] = "not-a-date"

    on_screen = json.loads(handler.lambda_handler(_get_event(), None)["body"])
    assert [row["id"] for row in on_screen] == [half_id], "the plan screen must hide the row"

    # 3. Every poll while it is still stored leaves its record alone — this is the WHIT-417
    # change. The second row keeps the plan non-empty, so the sweep genuinely runs.
    assert poll("395000", "390000") == 0
    assert poll("390000", "385000") == 0
    assert notify.removed == set(), "a stored row's marker must survive being unreadable"
    assert notify.fired == {quarter_marker}

    # 4. The user edits their plan. The app can only send back what it was shown, and PUT
    # replaces the plan whole — so the hidden row is silently dropped from the store.
    resave = handler.lambda_handler(_put_event(on_screen), None)
    assert resave["statusCode"] == 200, resave["body"]
    assert [row["id"] for row in milestone_repo._table.store[
        ("MILESTONES", "SHARED")]["milestones"]] == [half_id]

    # 5. NOW the marker is genuinely orphaned, and the next poll sweeps it. The protection in
    # step 3 is a stay of execution, not immortality — which is what keeps the once-ever record
    # from growing without bound.
    assert poll("385000", "380000") == 0
    assert notify.removed == {quarter_marker}
    assert notify.fired == set()
    assert pushes == ["\U0001f389 Milestone reached — Quarter down!"], "no second celebration"


# === [F1]-[F3] the over-rejection guard for the POLLER path ==================================

_SAVED_PLAN = [
    {"label": "x" * 100, "targetBalance": 1_000_000_000, "targetDate": "2027-02-28"},
    {"label": "Ünïcödé 🎉 目標", "targetBalance": 595413.43, "targetDate": "2028-02-29"},
    {"label": "Paid off", "targetBalance": 0, "targetDate": "2030-12-31"},
]


def test_every_row_the_save_endpoint_accepts_still_resolves_for_the_poller(
        handler, milestone_repo, poller):
    # [F1] The mirror of the bug WHIT-417 fixes. Boundary rows on purpose: the balance cap, a
    # cents target, a 0 balance, a 100-char label, a non-ASCII label, and a leap day (which
    # date.fromisoformat only accepts in a leap year — 2028 is one, so this row is legal and
    # MUST survive). PUT through the real handler, then read back through the real
    # _resolve_plan, exactly as the daily poll does.
    # Fail-on-revert: make row_date stricter than the save endpoint (e.g. reject Feb 29) and
    # the leap-day row vanishes from the plan here.
    put = handler.lambda_handler(_put_event(_SAVED_PLAN), None)
    assert put["statusCode"] == 200, put["body"]
    saved = json.loads(put["body"])

    plan = poller.resolve_plan(milestone_repo)
    assert [p.label for p in plan] == [r["label"] for r in _SAVED_PLAN]
    assert [p.target_balance for p in plan] == [
        Decimal("1000000000"), Decimal("595413.43"), Decimal("0")]
    # the dedup markers are the id-keyed ones, so each row's celebration stays once-ever
    assert [p.key for p in plan] == [
        f"id:{saved[0]['id']}:bal:1000000000.00",
        f"id:{saved[1]['id']}:bal:595413.43",
        f"id:{saved[2]['id']}:bal:0.00",
    ]


def test_a_leap_day_row_the_user_saved_still_celebrates(
        handler, milestone_repo, poller, monkeypatch):
    # [F1] The same guard at the level Jasmine would notice: not "the row resolves" but "the
    # push still arrives". A poll crossing the leap-day row's target must send its celebration
    # and record its marker.
    sent_pushes = []
    monkeypatch.setattr(poller, "send_push",
                        lambda title, body, tokens, **kw: sent_pushes.append(title))

    put = handler.lambda_handler(_put_event(_SAVED_PLAN), None)
    assert put["statusCode"] == 200, put["body"]
    leap_id = json.loads(put["body"])[1]["id"]

    notify = FakeNotifyRepo()
    sent = poller.notify_milestone_crossing(
        Decimal("600000"), Decimal("595000"),
        loanfacts_repo=FakeLoanFactsRepo(), device_repo=FakeDeviceRepo(),
        notify_repo=notify, milestone_repo=milestone_repo)

    assert sent == 1
    assert sent_pushes == ["\U0001f389 Milestone reached — Ünïcödé 🎉 目標!"]
    assert notify.fired == {f"id:{leap_id}:bal:595413.43"}
    assert notify.removed == set(), "no live row's marker may be swept"


def test_every_date_the_save_endpoint_accepts_is_readable_by_the_poller(handler, poller):
    # [F2] The general form of [F1]'s leap day. Walks every real calendar date across an 11-year
    # span (so every leap year, every month length and every year boundary in range is covered)
    # plus the two extremes date supports, asserting the WRITE bar (handler._valid_iso_date, the
    # regex AND the calendar check) implies the READ bar (milestone_rows.row_date). Both rules
    # are called for real — nothing here re-implements either.
    import milestone_rows

    day = datetime.date(2024, 1, 1)
    dates = [(day + datetime.timedelta(days=n)).isoformat() for n in range(0, 4018)]
    dates += [datetime.date.min.isoformat(), datetime.date.max.isoformat()]

    for iso in dates:
        assert handler._valid_iso_date(iso) is True, iso
        row = {"id": "m", "label": "L", "targetBalance": Decimal("1"), "targetDate": iso}
        assert milestone_rows.row_date(row, "targetDate") == iso


@pytest.mark.parametrize("lenient", ["20300101", "2030-W01-1"])
def test_the_read_rule_now_matches_the_write_rule_rejecting_the_lenient_forms(handler, lenient):
    # [F3] WHIT-418 unified the two rules on the one shared validator, so the read rule is no
    # longer the looser one. date.fromisoformat alone accepts these basic/week ISO forms on python
    # 3.11+ (the lambdas run 3.12); the save endpoint's ^\d{4}-\d{2}-\d{2}$ regex rejects them, and
    # now so does row_date. Pinned in both directions: the WRITE bar rejects them AND the READ bar
    # raises. If either rule ever loosened, THIS is the test that says so.
    import milestone_rows

    assert handler._valid_iso_date(lenient) is False
    row = {"id": "m", "label": "L", "targetBalance": Decimal("1"), "targetDate": lenient}
    with pytest.raises(milestone_rows.MalformedMilestoneRow):
        milestone_rows.row_date(row, "targetDate")


# === [W1]-[W3] keep-the-marker of an unreadable-but-identifiable row, end to end =============

_RETARGET_PLAN = [
    {"label": "Deposit", "targetBalance": 480000, "targetDate": "2027-01-01"},
    {"label": "Halfway", "targetBalance": 300000, "targetDate": "2028-01-01"},
]


def _saved_ids(put_result):
    assert put_result["statusCode"] == 200, put_result["body"]
    return [r["id"] for r in json.loads(put_result["body"])]


def _poll(poller, repo, notify, pushes, *, old, new):
    def _send(title, body, tokens, **kw):
        pushes.append(title)
    return poller.notify_milestone_crossing(
        Decimal(old), Decimal(new),
        loanfacts_repo=FakeLoanFactsRepo(), device_repo=FakeDeviceRepo(),
        notify_repo=notify, milestone_repo=repo)


def _corrupt_target_in_store(repo, index, value="oops"):
    """Make one stored row's target unreadable at the STORE level — the shape a legacy/direct
    write leaves behind. row_target(Decimal("oops")) raises, so _plan_marker can't rebuild the
    exact key; the row's readable id is all WHIT-424 has left to hold its markers by."""
    stored = repo._table.store[("MILESTONES", "SHARED")]["milestones"]
    stored[index] = {**stored[index], "targetBalance": value}


def test_a_corrupted_target_keeps_its_marker_across_polls_and_never_fires_twice(
        handler, milestone_repo, poller, monkeypatch):
    pushes = []
    monkeypatch.setattr(poller, "send_push", lambda t, b, tok, **kw: pushes.append(t))

    ids = _saved_ids(handler.lambda_handler(_put_event(_RETARGET_PLAN), None))
    halfway_marker = f"id:{ids[1]}:bal:300000.00"
    deposit_marker = f"id:{ids[0]}:bal:480000.00"

    notify = FakeNotifyRepo()
    # First poll crosses BOTH targets -> one push (furthest), both markers recorded.
    assert _poll(poller, milestone_repo, notify, pushes, old="500000", new="250000") == 1
    assert notify.fired == {deposit_marker, halfway_marker}

    # The Halfway row's stored target goes unreadable. Its id still reads.
    _corrupt_target_in_store(milestone_repo, 1)

    # Two more daily polls (nothing new crosses). The marker must SURVIVE both — the row is still
    # the user's, so the WHIT-385 sweep must not reap it as if Halfway were deleted.
    for _ in range(2):
        assert _poll(poller, milestone_repo, notify, pushes, old="240000", new="235000") == 0
    assert halfway_marker in notify.fired
    assert halfway_marker not in notify.removed

    # Repair the amount (a fresh PUT preserving ids) and re-cross Halfway. Because the marker was
    # never reaped, the crossing is NOT fresh -> NO second celebration. This is the double-
    # celebration the card closes. Fail-on-revert: rebuild liveness from `plan` (drop the id
    # prefix) -> the marker is swept during the corrupt polls and this re-cross congratulates again.
    handler.lambda_handler(_put_event(
        [{**_RETARGET_PLAN[0], "id": ids[0]}, {**_RETARGET_PLAN[1], "id": ids[1]}]), None)
    pushes.clear()
    assert _poll(poller, milestone_repo, notify, pushes, old="310000", new="250000") == 0
    assert pushes == []
    assert halfway_marker in notify.fired


def test_retargeting_through_the_endpoint_sweeps_the_old_marker_and_rearms(
        handler, milestone_repo, poller, monkeypatch):
    pushes = []
    monkeypatch.setattr(poller, "send_push", lambda t, b, tok, **kw: pushes.append(t))

    ids = _saved_ids(handler.lambda_handler(_put_event(_RETARGET_PLAN), None))
    old_marker = f"id:{ids[1]}:bal:300000.00"
    new_marker = f"id:{ids[1]}:bal:250000.00"

    notify = FakeNotifyRepo()
    _poll(poller, milestone_repo, notify, pushes, old="500000", new="250000")
    assert old_marker in notify.fired

    # Re-target Halfway 300000 -> 250000 through a real PUT (same id preserved). "Gone" now means
    # the OLD amount is gone: it keys to a new marker, so the old one must be reaped.
    handler.lambda_handler(_put_event(
        [{**_RETARGET_PLAN[0], "id": ids[0]},
         {"id": ids[1], "label": "Halfway", "targetBalance": 250000, "targetDate": "2028-01-01"}]), None)

    # A no-crossing poll high above every target: the sweep reaps the stale old marker.
    pushes.clear()
    assert _poll(poller, milestone_repo, notify, pushes, old="600000", new="550000") == 0
    assert old_marker in notify.removed
    assert new_marker not in notify.fired            # the new target hasn't been crossed yet

    # Cross the NEW target -> a fresh celebration (the re-arm), exactly once.
    pushes.clear()
    assert _poll(poller, milestone_repo, notify, pushes, old="260000", new="240000") == 1
    assert pushes == ["\U0001f389 Milestone reached — Halfway!"]
    assert new_marker in notify.fired


@pytest.mark.parametrize("bad_date", ["２０３０-01-01", "2030-01-01\n", "2030-00-10"])
def test_the_save_endpoint_rejects_a_shape_matching_but_uncalendar_date(handler, bad_date):
    # WHIT-418 folds the save endpoint's payoffGoalDate/targetDate guard onto valid_iso_date, so a
    # Unicode-digit date (passes ISO_DATE_RE's `\d`), a trailing-newline date (passes `$`) and a
    # month-00 date (passes the shape) are all 400s — the SAME rule the reads reject them by.
    row = {"label": "Bad", "targetBalance": 300000, "targetDate": bad_date}
    resp = handler.lambda_handler(_put_event([row]), None)
    assert resp["statusCode"] == 400, resp["body"]
    assert "targetDate" in resp["body"]