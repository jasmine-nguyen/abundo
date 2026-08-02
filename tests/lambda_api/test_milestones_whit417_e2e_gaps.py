"""WHIT-417 — [F1]-[F3] the OVER-rejection guard for the poller path, end to end.

WHIT-417 makes the daily balance poll STRICTER: _resolve_plan now runs the stored targetDate
through milestone_rows.row_date and drops the row if it can't parse. Every test that ships with
the card checks the intended direction — a corrupt row no longer celebrates. The risk a change
like that carries is the mirror image, and nothing checks it: if the read rule is stricter than
the WRITE rule anywhere, a plan the user saved through the app silently stops celebrating, and
they never find out (the balance only crosses each target once).

tests/lambda_api/test_milestones_corrupt_row_e2e_gaps.py [A7] pins that guard for the CLIENT
read (PUT -> GET). Nothing pins it for the path this card just changed.

  [F1] every row PUT /milestones accepts still resolves in the poller AND still celebrates —
       real handler, real MilestoneRepository, real _resolve_plan, one store between them.
  [F2] EVERY real calendar date the save endpoint accepts is accepted by row_date. A loop over
       every day of an 11-year span plus date.min/date.max, so the two rules can't part company
       on leap days, century years, or a boundary year.
  [F3] the reverse direction, stated rather than assumed: the dates row_date is lenient about
       ("20300101", "2030-W01-1") are exactly the ones the save endpoint REJECTS — which is why
       the corrupt row this card is about can only arrive by hand-edit.

The poller module is imported inside the `handler` fixture's sys.path window, where `milestones`
resolves to shared/milestones.py (the deployed layer's copy) — the same module the balance
poller loads. It is saved/restored around each test so the sibling suites' module tables are
untouched.
"""

import datetime
import json
import sys
from decimal import Decimal

import pytest


class FakeConfigTable:
    """The single-config-item slice of DynamoDB MilestoneRepository uses (mirrors
    test_milestones_corrupt_row_e2e_gaps.py), injected as repo._table so the real
    set_milestones / _read_milestones / _to_client all run unmodified."""

    def __init__(self):
        self.store = {}

    def get_item(self, Key):
        item = self.store.get((Key["pk"], Key["sk"]))
        return {"Item": dict(item)} if item is not None else {}

    def put_item(self, Item, ConditionExpression=None):
        self.store[(Item["pk"], Item["sk"])] = dict(Item)


@pytest.fixture
def milestone_repo(handler, monkeypatch):
    repo = handler.MilestoneRepository()
    repo._table = FakeConfigTable()
    monkeypatch.setattr(handler, "MilestoneRepository", lambda: repo)
    return repo


@pytest.fixture
def poller(handler):
    """shared/milestones.py — the module lambda_balance_poller/handler.py imports. Restored
    afterwards so the shared-layer suite's own import isolation is unaffected."""
    saved = {name: sys.modules.get(name) for name in ("milestones", "milestone_rows")}
    import milestones
    try:
        yield milestones
    finally:
        for name, mod in saved.items():
            if mod is None:
                sys.modules.pop(name, None)
            else:
                sys.modules[name] = mod


def _put_event(rows):
    return {"rawPath": "/milestones", "requestContext": {"http": {"method": "PUT"}},
            "body": json.dumps({"milestones": rows}), "isBase64Encoded": False}


class FakeDeviceRepo:
    def list_tokens(self):
        return ["tok"]


class FakeLoanFactsRepo:
    def get_loanfacts(self):
        return None


class FakeNotifyRepo:
    def __init__(self):
        self.fired = set()
        self.removed = set()

    def fired_milestones(self, scope=None):
        return set(self.fired)

    def mark_milestone_fired(self, key, scope=None):
        self.fired.add(key)

    def remove_milestone_markers(self, keys, scope=None):
        self.removed |= set(keys)
        self.fired -= set(keys)


# --- [F1] a saved plan must survive the poller's new date check --------------

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


# --- [F2] the write rule and the read rule can't part company ---------------

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
def test_the_read_rule_is_the_lenient_one_so_a_bad_row_is_hand_edit_only(handler, lenient):
    # [F3] The gap between the two rules, stated. date.fromisoformat accepts these on python
    # 3.11+ (the lambdas run 3.12), the save endpoint's ^\d{4}-\d{2}-\d{2}$ regex does not — so
    # the read rule is strictly the looser of the two in every direction we can reach, which is
    # what makes "this row can only exist by hand-editing the database" true. If the save
    # endpoint ever loosened to match, THIS is the test that says so.
    import milestone_rows

    assert handler._valid_iso_date(lenient) is False
    row = {"id": "m", "label": "L", "targetBalance": Decimal("1"), "targetDate": lenient}
    assert milestone_rows.row_date(row, "targetDate") == lenient
