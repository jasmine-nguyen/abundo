"""WHIT-417 — [E1]-[E6] adversarial gaps left by the "hide it on screen -> don't celebrate it"
change, INDEPENDENT of the implementer's tests.

Already locked elsewhere, NOT repeated here: the bad-date row is hidden and silent on both
paths ([B1]), its stale marker is swept alone ([B1a]), the repaired-date re-fire ([B1b]), an
all-bad-date plan celebrating and sweeping nothing ([B1c]), the blank/null/unparsable date
parity rows and the alarm-token bad-date case (tests/shared/test_milestone_rows.py).

What none of them cover:

  [E1] the date SHAPES the parity table doesn't carry. "" / None / "not-a-date" are the easy
       three. A stored date can also be an ISO *datetime*, whitespace-padded, timezone- or
       Z-suffixed, a bool, a Decimal or bytes — every one of which must be rejected by BOTH
       paths, or the divergence WHIT-417 closed re-opens on a different shape. The MISSING
       targetDate KEY (vs a present null) is its own branch: row_field, not fromisoformat.
  [E2] the shapes row_date is LENIENT about. date.fromisoformat accepts basic ISO ("20300101")
       and week dates ("2030-W01-1") on python 3.11+, which the save endpoint's regex rejects.
       Both read paths must agree on those too — tightening row_date is a both-paths decision,
       and this is what makes a one-sided tightening go red instead of silently re-splitting
       the screen from the push.
  [E3] POSITION. _resolve_plan skips row-by-row; a bad row FIRST must cost no more than a bad
       row LAST. Guards the obvious "optimisation" — an early break/return in that loop — which
       would silently drop every row after the broken one from the celebration.
  [E4] sweep AND push in the SAME poll. [B1a]/[B3] both use a no-crossing poll, so nothing
       proves the stale-marker sweep leaves the crossing that DID happen able to celebrate.
  [E5] the CloudWatch metric filter in terraform/monitoring.tf must actually match the log
       line WHIT-417 newly emits. The alarm is the card's stated win; a token the filter can't
       match makes it silent. Read the pattern out of the terraform file — don't retype it.
  [E6] an all-bad-date plan must do NO marker I/O at all, not merely delete nothing. [B1c]
       asserts `removed == set()`, which a plan that read the marker set and found nothing
       stale would also satisfy.
"""

import logging
import pathlib
import re
from decimal import Decimal

import pytest


_GOOD = {"id": "keep", "label": "Halfway", "targetBalance": Decimal("300000"),
         "targetDate": "2030-01-01"}


def _row(**overrides):
    return {**_GOOD, **overrides}


def _store_raw_row(milestone_repo, milestones, scope="SHARED"):
    milestone_repo._table.store[("MILESTONES", scope)] = {
        "pk": "MILESTONES", "sk": scope, "milestones": milestones,
    }


class FakeMilestoneRepo:
    def __init__(self, stored):
        self._stored = stored

    def get_milestones_raw(self, scope=None):
        return self._stored


class FakeDeviceRepo:
    def list_tokens(self):
        return ["tok"]


class FakeLoanFactsRepo:
    def get_loanfacts(self):
        return None          # the number-free body; the figures aren't what's under test


class FakeNotifyRepo:
    """Counts reads as well as writes, so [E6] can prove a short-circuit rather than a no-op."""

    def __init__(self, fired=None):
        self.fired = set(fired or set())
        self.removed = set()
        self.reads = 0

    def fired_milestones(self, scope=None):
        self.reads += 1
        return set(self.fired)

    def mark_milestone_fired(self, key, scope=None):
        self.fired.add(key)

    def remove_milestone_markers(self, keys, scope=None):
        assert keys, "must guard empty before calling remove_milestone_markers"
        self.removed |= set(keys)
        self.fired -= set(keys)


@pytest.fixture
def recorder(shared, monkeypatch):
    calls = []
    monkeypatch.setattr(shared.milestones, "send_push",
                        lambda title, body, tokens, **kw: calls.append((title, body, tokens)))
    return calls


def _notify(shared, *, old, new, stored, notify=None):
    notify = notify or FakeNotifyRepo()
    sent = shared.milestones.notify_milestone_crossing(
        Decimal(old), Decimal(new),
        loanfacts_repo=FakeLoanFactsRepo(),
        device_repo=FakeDeviceRepo(),
        notify_repo=notify,
        milestone_repo=FakeMilestoneRepo(stored),
    )
    return sent, notify


# --- [E1] the date shapes the parity table doesn't carry --------------------

_UNCOVERED_BAD_DATES = [
    ("iso datetime", "2030-01-01T00:00:00"),      # date.fromisoformat rejects a time component
    ("leading whitespace", " 2030-01-01"),
    ("trailing whitespace", "2030-01-01 "),
    ("utc suffix", "2030-01-01Z"),
    ("offset suffix", "2030-01-01+10:00"),
    ("bool", True),
    ("decimal", Decimal("2030")),
    ("bytes", b"2030-01-01"),
    ("int", 20300101),
]


@pytest.mark.parametrize("why, bad_date", _UNCOVERED_BAD_DATES,
                         ids=[s[0] for s in _UNCOVERED_BAD_DATES])
def test_every_other_bad_date_shape_is_dropped_by_both_read_paths(
        shared, milestone_repo, why, bad_date):
    # [E1] The card's rule is "what pushes is what the screen shows". That has to hold for the
    # whole rejected set, not the three shapes the parity table happens to list — a date that
    # is a datetime, padded, zoned, or simply not text is just as unshowable.
    # Fail-on-revert: drop row_date from _resolve_plan -> the poller keeps every one of these.
    stored = [_row(id="good"), _row(id="bad", label="Bad", targetDate=bad_date)]
    _store_raw_row(milestone_repo, stored)

    assert [m["id"] for m in milestone_repo.get_milestones()] == ["good"], f"screen kept {why}"
    assert [p.label for p in shared.milestones.resolve_plan(FakeMilestoneRepo(stored))] == [
        "Halfway"], f"poller kept {why}"


def test_a_row_with_no_target_date_key_at_all_is_dropped_by_both_read_paths(
        shared, milestone_repo):
    # [E1] A MISSING key is a different branch from a null value: row_field raises before
    # fromisoformat is ever reached (milestone_rows.py:78), and the log line must name the
    # missing field rather than call it unparsable. The parity table carries "missing target"
    # but never "missing date".
    no_date = {"id": "bad", "label": "No date", "targetBalance": Decimal("250000")}
    stored = [_row(id="good"), no_date]
    _store_raw_row(milestone_repo, stored)

    assert [m["id"] for m in milestone_repo.get_milestones()] == ["good"]
    assert [p.label for p in shared.milestones.resolve_plan(FakeMilestoneRepo(stored))] == [
        "Halfway"]


# --- [E2] the leniency is shared too ----------------------------------------

@pytest.mark.parametrize("lenient_date", ["20300101", "2030-W01-1"])
def test_a_date_only_fromisoformat_accepts_is_kept_by_both_read_paths(
        shared, milestone_repo, lenient_date):
    # [E2] The read bar is exactly date.fromisoformat, which on python 3.11+ (the lambdas run
    # 3.12 — terraform/lambda.tf) accepts basic and week-date ISO forms. The SAVE endpoint's
    # ^\d{4}-\d{2}-\d{2}$ regex rejects both, so these only reach the store by hand-edit — but
    # while they are there the screen shows them, so the poller must celebrate them. Pinning
    # the pair keeps any future tightening a both-paths change: tighten one and this goes red.
    stored = [_row(id="lenient", label="Lenient", targetDate=lenient_date)]
    _store_raw_row(milestone_repo, stored)

    assert [m["targetDate"] for m in milestone_repo.get_milestones()] == [lenient_date]
    assert [p.label for p in shared.milestones.resolve_plan(FakeMilestoneRepo(stored))] == [
        "Lenient"]


# --- [E3] a bad row FIRST costs no more than a bad row LAST -----------------

@pytest.mark.parametrize("position", ["first", "last", "middle"])
def test_a_bad_date_row_costs_only_itself_wherever_it_sits(shared, recorder, position):
    # [E3] The loop must SKIP, not stop. An early break/return would make the damage depend on
    # where the corrupt row happens to sit in the saved list — the rows after it would silently
    # stop celebrating, and (via the WHIT-385 sweep) lose their once-ever markers too.
    # Fail-on-revert: replace the `except` body in _resolve_plan with `return [], True` -> the
    # "first" and "middle" cases lose their push.
    bad = _row(id="bad", label="Bad", targetBalance=Decimal("250000"), targetDate="not-a-date")
    a = _row(id="a", label="A", targetBalance=Decimal("400000"))
    b = _row(id="b", label="B", targetBalance=Decimal("300000"))
    stored = {"first": [bad, a, b], "middle": [a, bad, b], "last": [a, b, bad]}[position]

    assert [p.label for p in shared.milestones.resolve_plan(FakeMilestoneRepo(stored))] == [
        "A", "B"]

    # ...and the survivors still celebrate: a poll past every target pushes the furthest one.
    sent, notify = _notify(shared, old="500000", new="240000", stored=stored)
    assert sent == 1
    assert recorder[-1][0] == "\U0001f389 Milestone reached — B!"     # lowest surviving target
    assert notify.fired == {"id:a:bal:400000.00", "id:b:bal:300000.00"}


# --- [E4] sweeping a stale marker must not cost the poll its celebration ----

def test_the_sweep_and_a_real_celebration_survive_the_same_poll(shared, recorder):
    # [E4] [B1a] and [B3] both sweep on a no-crossing poll. The sweep runs BEFORE the crossing
    # check and reuses the marker set it read, deliberately WITHOUT subtracting the keys it just
    # deleted (milestones.py:265-267). If a fresh key could ever land in `stale`, the deleted
    # marker would still be in `fired` and the genuine push would be swallowed. Prove the two
    # coexist in one poll: the bad row's marker goes, the good row's crossing still pushes.
    stored = [_row(id="good", label="Good", targetBalance=Decimal("300000")),
              _row(id="dated", label="Dated", targetBalance=Decimal("250000"),
                   targetDate="not-a-date")]
    notify = FakeNotifyRepo(fired={"id:dated:bal:250000.00"})

    sent, notify = _notify(shared, old="310000", new="240000", stored=stored, notify=notify)

    assert sent == 1
    assert recorder[-1][0] == "\U0001f389 Milestone reached — Good!"
    assert notify.removed == {"id:dated:bal:250000.00"}   # swept in the same poll
    assert "id:good:bal:300000.00" in notify.fired        # and the real crossing was recorded


# --- [E5] the alarm the card relies on can actually fire --------------------

def test_the_terraform_metric_filter_matches_the_line_a_bad_date_emits(shared, caplog):
    # [E5] "The row now raises MILESTONE_ROW_MALFORMED, so the existing CloudWatch alarm starts
    # firing for it" is the stated upside of WHIT-417 — and it is infrastructure, so nothing in
    # the python suite checks it. The pattern is READ OUT of terraform/monitoring.tf rather than
    # retyped, so renaming the token on either side goes red.
    # CloudWatch text filter terms match whitespace-delimited words, so the token has to sit in
    # the line as a bare word — a "MILESTONE_ROW_MALFORMED:" prefix would NOT match the filter.
    tf = (pathlib.Path(__file__).resolve().parents[2] / "terraform" / "monitoring.tf").read_text()
    pattern = re.search(
        r'resource "aws_cloudwatch_log_metric_filter" "milestone_row_malformed".*?'
        r'pattern\s*=\s*"([^"]+)"', tf, re.S).group(1)
    terms = re.findall(r"\?(\S+)", pattern)
    assert "MILESTONE_ROW_MALFORMED" in terms, f"terraform pattern changed: {pattern!r}"

    with caplog.at_level(logging.ERROR, logger="milestones"):
        assert shared.milestones.resolve_plan(
            FakeMilestoneRepo([_row(targetDate="not-a-date")])) == []
    line = caplog.records[0].getMessage()
    assert "MILESTONE_ROW_MALFORMED" in line.split(), (
        f"the emitted line has no bare {terms} word for the metric filter to match: {line!r}")


# --- [E6] an all-bad-date plan touches the marker store at all -------------

def test_an_all_bad_date_plan_does_no_marker_io_whatsoever(shared, recorder):
    # [E6] [B1c] asserts nothing was REMOVED, which is also true of a plan that read the marker
    # set and found nothing stale. The stronger property is that an authoritative EMPTY plan
    # never reads it either: the WHIT-386 `and plan` guard skips the sweep, and the empty
    # crossing list returns before the dedup read. That is what keeps a corrupt plan from
    # costing a DynamoDB read on every daily poll, and what makes "sweeps nothing" structural
    # rather than incidental.
    stored = [_row(id="a", label="A", targetDate="not-a-date"),
              _row(id="b", label="B", targetBalance=Decimal("250000"), targetDate=None)]
    notify = FakeNotifyRepo(fired={"id:a:bal:300000.00", "0"})

    sent, notify = _notify(shared, old="500000", new="200000", stored=stored, notify=notify)

    assert sent == 0
    assert recorder == []
    assert notify.reads == 0, "an empty plan must not even read the marker set"
    assert notify.removed == set()
    assert notify.fired == {"id:a:bal:300000.00", "0"}
