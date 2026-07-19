"""Adversarial GAP tests for the payoff-milestone push (shared/milestones.py, WHIT-301).

The implementer's test_milestones.py locks the drift-pin, the pure crossing/equity
math, and the single/lump-sum/already-fired/no-device/expo-not-ok/bare-body detector
paths. These add the edges it doesn't:

    - a balance that OSCILLATES across a boundary (down/marked -> corrected up ->
      down again) must NOT re-fire once marked  [fail-on-revert on the dedup]
    - the >= boundary at a Decimal WITH CENTS vs an int target (295000.00 lands,
      295000.01 does not)                        [fail-on-revert on `>=`]
    - a lump sum where the FURTHEST crossed is already fired but a NEARER one is
      fresh: sends the nearer fresh one, marks every fresh  [fail-on-revert]
    - loan facts present but original < new_balance -> negative "$-N down" copy
      (characterization: documents a latent copy bug, no guard exists)
    - usable_equity rounds a half-dollar UP (math.floor(x + 0.5)), matching the
      client twin's Math.round (fail-on-revert on the WHIT-307 rounding fix)

Mirrors test_milestones.py's fake-repo + send_push-recorder pattern.
"""

from decimal import Decimal

import pytest


class FakeLoanFactsRepo:
    def __init__(self, facts=None):
        self._facts = facts

    def get_loanfacts(self):
        return self._facts


class FakeDeviceRepo:
    def __init__(self, tokens):
        self._tokens = tokens

    def list_tokens(self):
        return list(self._tokens)


class FakeNotifyRepo:
    def __init__(self, fired=None):
        self.fired = set(fired or set())

    def fired_milestones(self):
        return set(self.fired)

    def mark_milestone_fired(self, sprint):
        assert isinstance(sprint, str), "sprint marker must be a string (String Set)"
        self.fired.add(sprint)


@pytest.fixture
def recorder(shared, monkeypatch):
    calls = []

    def fake(title, body, tokens, **kw):
        calls.append((title, body, tokens))
        return {"sent": len(tokens), "ok": len(tokens), "pruned": []}

    monkeypatch.setattr(shared.milestones, "send_push", fake)
    return calls


FACTS = {"original": 600000.0, "homeValue": 770000.0, "lvr": 0.8,
         "ratePct": 5.95, "baseRepay": 3570.0, "extra": 12000.0, "payoffGoalDate": None}


def _notify(shared, *, old, new, repo, facts=FACTS, tokens=("tok",)):
    return shared.milestones.notify_milestone_crossing(
        Decimal(old) if old is not None else None,
        Decimal(new),
        loanfacts_repo=FakeLoanFactsRepo(facts),
        device_repo=FakeDeviceRepo(tokens),
        notify_repo=repo,
    )


# --- oscillation across a boundary: mark once, never re-fire ------------------
# WHIT-301 — [A20] fail-on-revert: the once-ever dedup survives a down/up/down wobble.

def test_oscillation_across_boundary_never_refires(shared, recorder):
    repo = FakeNotifyRepo()  # persists across the three polls
    # poll 1: 545k -> 544k crosses Kickoff, fires + marks "0"
    assert _notify(shared, old="545000", new="544000", repo=repo) == 1
    # poll 2: a market correction pushes the balance back UP over the line -> nothing
    assert _notify(shared, old="544000", new="546000", repo=repo) == 0
    # poll 3: it dips back through the SAME boundary -> crosses again, but "0" is marked
    assert _notify(shared, old="546000", new="544000", repo=repo) == 0
    assert len(recorder) == 1          # exactly one celebration across the whole wobble
    assert repo.fired == {"0"}


# --- Decimal-with-cents vs int target at the >= boundary ----------------------
# WHIT-301 — [A21] fail-on-revert on the `>=` (exact-cents landing counts). [A21b] a cent above is a
# boundary characterization of the strict side (guards against a sloppier mutation like rounding new).

def test_cents_exactly_on_target_counts_as_crossed(shared):
    crossed = shared.milestones.crossed_milestones(Decimal("296000"), Decimal("295000.00"))
    assert [m.sprint for m in crossed] == [2]  # Halfway, landed exactly


def test_one_cent_above_target_is_not_yet_crossed(shared):
    assert shared.milestones.crossed_milestones(Decimal("296000"), Decimal("295000.01")) == []


# --- lump sum: furthest already fired, a nearer one still fresh ---------------
# WHIT-301 — [A22] fail-on-revert: sends the furthest FRESH (not the furthest crossed) + marks all fresh.

def test_lump_sum_sends_nearer_fresh_when_furthest_already_fired(shared, recorder):
    repo = FakeNotifyRepo(fired={"2"})  # Halfway (295k, the furthest) already celebrated
    # 600k -> 290k crosses Kickoff(0), Quarter(1), Halfway(2); only 0 & 1 are fresh.
    sent = _notify(shared, old="600000", new="290000", repo=repo)
    assert sent == 1
    assert len(recorder) == 1
    assert recorder[0][0] == "\U0001f389 Milestone reached — Quarter way!"  # furthest FRESH (420k)
    assert repo.fired == {"0", "1", "2"}  # both fresh ones now marked too


# --- loan facts present but original < new_balance: paid clamps at $0 ---------
# WHIT-301 — [A23] fail-on-revert on the max(0, ...) clamp: a misconfigured `original` (below the
# current balance) must never render a negative "$-N down" in the celebration.

def test_negative_paid_down_clamps_to_zero(shared, recorder):
    facts = {"original": 500000.0, "homeValue": 770000.0, "lvr": 0.8}
    repo = FakeNotifyRepo()
    sent = _notify(shared, old="545000", new="544000", repo=repo, facts=facts)
    assert sent == 1
    _, body, _ = recorder[0]
    # paid = max(0, 500000 - 544000) = 0 -> "$0 down", never a minus sign
    assert "$0 down on your mortgage" in body
    assert "$-" not in body  # no negative dollar figure anywhere
    assert "$72,000 in equity unlocked" in body  # equity clamp still sane: 616000-544000


# --- usable_equity half-dollar rounding: half-up, matches the TS twin (WHIT-307) ---
# WHIT-307 — fail-on-revert on math.floor(x + 0.5): a half-dollar rounds UP, matching the
# client twin's Math.round. Reverting to Python's built-in round() (banker's) turns 0.5 -> 0
# and 2.5 -> 2 and trips this.

def test_usable_equity_rounds_half_dollar_up_like_the_client_twin(shared):
    # 3.0*0.5 = 1.5 -> half-up -> 2 (Math.round(1.5) === 2; agrees with banker's here too)
    assert shared.milestones.usable_equity(3.0, 0.0, 0.5) == 2
    # 1.0*0.5 = 0.5 -> half-up -> 1 (Math.round(0.5) === 1); built-in round() would give 0.
    assert shared.milestones.usable_equity(1.0, 0.0, 0.5) == 1
    # 5.0*0.5 = 2.5 -> half-up -> 3 (Math.round(2.5) === 3); built-in round() would give 2.
    assert shared.milestones.usable_equity(5.0, 0.0, 0.5) == 3
