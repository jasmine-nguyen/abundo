"""WHIT-480 — end-to-end guards for the extracted _validate_label / _validate_id helpers.

The implementer's tests/lambda_api/test_validation_helpers.py pins the two helpers in
ISOLATION. These pin them THROUGH the two real callers (set_milestones, upsert_goal ->
_validate_goal_checkpoints), because the only way the refactor can go wrong is a wrong
`noun`/`max_len` wired at a call site, or the id-helper's mid-loop early-return colliding
with the WHIT-447 mint bookkeeping. Existing goal tests assert only status 400, and the
existing milestone label/id tests only substring-match — neither guards the approved
wording change or the noun wiring. Fakes mirror the per-suite pattern (each suite defines
its own; nothing importable lives in conftest).
"""

import json


# --- fakes (mirror test_milestones_api.py / test_goals.py) -------------------

class FakeMilestoneRepo:
    def __init__(self, milestones=None):
        self._milestones = milestones
        self.set_calls = []

    def get_milestones(self, scope="SHARED"):
        return list(self._milestones) if self._milestones is not None else None

    def set_milestones(self, milestones, scope="SHARED"):
        self.set_calls.append({"milestones": milestones, "scope": scope})
        return [{**m, "targetBalance": float(m["targetBalance"])} for m in milestones]


class RecordingNotifyRepo:
    def __init__(self, fired=None):
        self.fired = set(fired or set())
        self.migrate_calls = []

    def fired_milestones(self, scope=None):
        return set(self.fired)

    def migrate_milestone_markers(self, migrations, scope=None):
        self.migrate_calls.append({"migrations": list(migrations), "scope": scope})
        for old, new in migrations:
            if old in self.fired:
                self.fired.add(new)
                self.fired.discard(old)


class FakeGoalsRepo:
    def __init__(self):
        self.upsert_calls = []

    def upsert_goal(self, goal_id, goal, start_candidate=None):
        self.upsert_calls.append((goal_id, goal))
        return {"id": goal_id, **goal, **(start_candidate or {})}


class FakeBalanceRepo:
    def list_balances(self, account_ids):
        return []


# --- event builders ----------------------------------------------------------

def _ms_event(rows):
    return {
        "rawPath": "/milestones",
        "requestContext": {"http": {"method": "PUT"}},
        "body": json.dumps({"milestones": rows}),
        "isBase64Encoded": False,
    }


def _put_milestones(handler, rows, repo=None, notify=None):
    repo = repo or FakeMilestoneRepo()
    notify = notify or RecordingNotifyRepo()
    resp = handler.set_milestones(_ms_event(rows), repo, notify)
    return resp, repo, notify


def _err(resp):
    return json.loads(resp["body"])["error"]


VALID_MS = {"label": "Kickoff", "targetBalance": 544000, "targetDate": "2026-06-18"}


def _goal_event(body, goal_id="g1"):
    return {
        "rawPath": f"/goals/{goal_id}",
        "requestContext": {"http": {"method": "PUT"}},
        "pathParameters": {"id": goal_id},
        "body": json.dumps(body),
        "isBase64Encoded": False,
    }


def _grow_body(**over):
    body = {"name": "Holiday", "icon": "palm", "direction": "grow",
            "target_amount": 5000, "target_date": "2026-12-01", "account_id": "up-spending"}
    body.update(over)
    return body


def _cp(label, amount, **over):
    cp = {"label": label, "amount": amount}
    cp.update(over)
    return cp


def _put_goal(handler, body):
    repo = FakeGoalsRepo()
    resp = handler.upsert_goal(_goal_event(body), repo, FakeBalanceRepo())
    return resp, repo


# =====================================================================
# Milestone save — approved wording change is what reaches the client
# =====================================================================

def test_milestone_label_too_long_uses_the_prefixed_wording(handler):
    # WHIT-480 — [E1] approved: "label too long" -> "milestone label too long"
    resp, repo, _ = _put_milestones(handler, [{**VALID_MS, "label": "x" * 101}])
    assert resp["statusCode"] == 400
    assert _err(resp) == "milestone label too long"
    assert repo.set_calls == []


def test_milestone_blank_id_uses_the_prefixed_wording(handler):
    # WHIT-480 — [E2] approved: "id must be a non-empty string" -> "milestone id must be..."
    resp, repo, _ = _put_milestones(handler, [{**VALID_MS, "id": "   "}])
    assert resp["statusCode"] == 400
    assert _err(resp) == "milestone id must be a non-empty string"
    assert repo.set_calls == []


def test_milestone_empty_label_message_unchanged(handler):
    # WHIT-480 — [E3] noun wired at the empty-label branch; message must NOT have drifted
    resp, _, _ = _put_milestones(handler, [{**VALID_MS, "label": ""}])
    assert _err(resp) == "each milestone needs a non-empty label"


def test_milestone_duplicate_id_message_unchanged(handler):
    # WHIT-480 — [E4]
    rows = [{**VALID_MS, "id": "dup"},
            {"label": "Two", "targetBalance": 100000, "targetDate": "2027-06-18", "id": "dup"}]
    resp, repo, _ = _put_milestones(handler, rows)
    assert resp["statusCode"] == 400
    assert _err(resp) == "milestone ids must be unique"
    assert repo.set_calls == []


# =====================================================================
# Goal checkpoint save — the unification must NOT leak the milestone noun
# =====================================================================

def test_checkpoint_label_too_long_keeps_checkpoint_noun(handler):
    # WHIT-480 — [E5]
    resp, repo = _put_goal(handler, _grow_body(checkpoints=[_cp("x" * 101, 1000)]))
    assert resp["statusCode"] == 400
    assert _err(resp) == "checkpoint label too long"
    assert repo.upsert_calls == []


def test_checkpoint_blank_id_keeps_checkpoint_noun(handler):
    # WHIT-480 — [E6]
    resp, repo = _put_goal(handler, _grow_body(checkpoints=[_cp("A", 1000, id="   ")]))
    assert resp["statusCode"] == 400
    assert _err(resp) == "checkpoint id must be a non-empty string"
    assert repo.upsert_calls == []


def test_checkpoint_duplicate_id_keeps_checkpoint_noun(handler):
    # WHIT-480 — [E7]
    resp, repo = _put_goal(handler, _grow_body(
        checkpoints=[_cp("A", 1000, id="dup"), _cp("B", 2000, id="dup")]))
    assert resp["statusCode"] == 400
    assert _err(resp) == "checkpoint ids must be unique"
    assert repo.upsert_calls == []


def test_checkpoint_empty_label_keeps_checkpoint_noun(handler):
    # WHIT-480 — [E8]
    resp, _ = _put_goal(handler, _grow_body(checkpoints=[_cp("", 1000)]))
    assert _err(resp) == "each checkpoint needs a non-empty label"


# =====================================================================
# WHIT-447 mint bookkeeping × id-helper early-return
# (existing tests trigger the failure via ordering/balance; these trigger it
#  INSIDE _validate_id, after an earlier row already minted)
# =====================================================================

def test_mint_then_blank_id_failure_persists_nothing_and_migrates_nothing(handler):
    # WHIT-480 — [E9] row0 id-less -> mints & lands in `minted`; row1 blank id -> _validate_id
    # returns the 400. Must short-circuit before repo.set_milestones AND before migration.
    notify = RecordingNotifyRepo(fired={"bal:544000.00", "bal:100000.00"})
    rows = [
        {"label": "First", "targetBalance": 544000, "targetDate": "2026-06-18"},      # no id -> mints
        {"label": "Second", "targetBalance": 100000, "targetDate": "2027-06-18", "id": "  "},
    ]
    resp, repo, notify = _put_milestones(handler, rows, notify=notify)
    assert resp["statusCode"] == 400
    assert _err(resp) == "milestone id must be a non-empty string"
    assert repo.set_calls == []                        # nothing persisted
    assert notify.migrate_calls == []                  # no marker moved for an unsaved plan
    assert notify.fired == {"bal:544000.00", "bal:100000.00"}   # markers untouched


def test_mint_then_duplicate_id_failure_persists_and_migrates_nothing(handler):
    # WHIT-480 — [E10] row0 explicit "keep"; row1 id-less -> mints; row2 duplicates "keep".
    # The duplicate check in _validate_id fires AFTER a mint already ran on row1.
    notify = RecordingNotifyRepo(fired={"bal:100000.00"})
    rows = [
        {"label": "Keep", "targetBalance": 544000, "targetDate": "2026-06-18", "id": "keep"},
        {"label": "Minted", "targetBalance": 300000, "targetDate": "2027-06-18"},     # no id -> mints
        {"label": "Dup", "targetBalance": 100000, "targetDate": "2028-06-18", "id": "keep"},
    ]
    resp, repo, notify = _put_milestones(handler, rows, notify=notify)
    assert resp["statusCode"] == 400
    assert _err(resp) == "milestone ids must be unique"
    assert repo.set_calls == []
    assert notify.migrate_calls == []


# =====================================================================
# seen_ids scope — the set is per-call, and the two paths don't share one
# =====================================================================

def test_seen_ids_is_per_request_not_shared_across_calls(handler):
    # WHIT-480 — [E11] two independent saves reusing the same id must both succeed;
    # a leaked module-level set would 400 the second as a duplicate.
    resp1, repo1, _ = _put_milestones(handler, [{**VALID_MS, "id": "dup"}])
    resp2, repo2, _ = _put_milestones(handler, [{**VALID_MS, "id": "dup"}])
    assert resp1["statusCode"] == 200 and resp2["statusCode"] == 200
    assert repo1.set_calls[0]["milestones"][0]["id"] == "dup"
    assert repo2.set_calls[0]["milestones"][0]["id"] == "dup"


def test_milestone_and_goal_can_reuse_the_same_id(handler):
    # WHIT-480 — [E11] the milestone and checkpoint save paths keep separate seen-sets.
    resp_ms, _, _ = _put_milestones(handler, [{**VALID_MS, "id": "shared-1"}])
    resp_goal, repo_goal = _put_goal(handler, _grow_body(
        checkpoints=[_cp("Halfway", 2500, id="shared-1")]))
    assert resp_ms["statusCode"] == 200
    assert resp_goal["statusCode"] == 200
    assert repo_goal.upsert_calls[0][1]["checkpoints"][0]["id"] == "shared-1"


# =====================================================================
# Unicode / whitespace at the cap boundary (milestone path is not unicode-covered)
# =====================================================================

def test_milestone_label_100_unicode_code_points_accepted_101_rejected(handler):
    # WHIT-480 — [E12] len() counts code points; the emoji is one code point in Python 3.
    ok, repo_ok, _ = _put_milestones(handler, [{**VALID_MS, "label": "\U0001F600" * 100}])
    assert ok["statusCode"] == 200
    assert repo_ok.set_calls[0]["milestones"][0]["label"] == "\U0001F600" * 100
    over, repo_over, _ = _put_milestones(handler, [{**VALID_MS, "label": "\U0001F600" * 101}])
    assert over["statusCode"] == 400
    assert _err(over) == "milestone label too long"
    assert repo_over.set_calls == []


def test_milestone_label_trimmed_to_cap_is_accepted_and_stored_trimmed(handler):
    # WHIT-480 — [E13] raw is 104 chars but trims to exactly 100 -> accepted, stored trimmed.
    raw = "  " + "y" * 100 + "  "
    resp, repo, _ = _put_milestones(handler, [{**VALID_MS, "label": raw}])
    assert resp["statusCode"] == 200
    assert repo.set_calls[0]["milestones"][0]["label"] == "y" * 100
