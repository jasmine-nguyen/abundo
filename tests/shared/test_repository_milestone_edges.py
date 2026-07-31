"""WHIT-375 — adversarial repository-level edges for MilestoneRepository, INDEPENDENT
of the implementer's tests/shared/test_repository_milestone.py.

Gaps covered (verified absent from the implementer's suite first):
  [R-EMPTY]  a stored item whose `milestones` is [] returns [] (not None, not a crash) —
             the "exists but empty" state is distinct from "never saved" (None).
  [R-CENTS]  a Decimal balance with cents (595413.43) round-trips to the exact float.
  [R-SCOPES] two DIFFERENT non-default scopes don't bleed into each other.
  [R-KEY]    the stored row key is pk=MILESTONES / sk=<scope> (seam lives in the sort key).

WHIT-383 read-hardening (legacy/partial rows): the client read tolerates a row with no
`milestones` attribute and skips a milestone missing/null-ing a field. The poller's RAW read
still returns rows verbatim, but its own per-row skip now lives in shared/milestones._resolve_plan
(WHIT-387), so the poller path degrades a bad row rather than raising.
"""

from decimal import Decimal

import pytest


def _store_raw_row(milestone_repo, milestones, scope="SHARED"):
    """Inject a stored row directly, bypassing set_milestones' validation, to mimic a
    legacy / partially-written row. Pass milestones=None for a row with no attribute."""
    row = {"pk": "MILESTONES", "sk": scope}
    if milestones is not None:
        row["milestones"] = milestones
    milestone_repo._table.store[("MILESTONES", scope)] = row


_COMPLETE = {"id": "m1", "label": "Halfway", "targetBalance": Decimal("300000"),
             "targetDate": "2030-01-01"}


def test_stored_empty_list_returns_empty_list_not_none(milestone_repo):
    # Distinct from "never saved" (None): if a row exists with an empty list, get must
    # return [] so a caller can tell "saved, currently empty" from "unset".
    milestone_repo.set_milestones([])
    assert milestone_repo.get_milestones() == []
    assert milestone_repo.get_milestones() is not None


def test_decimal_with_cents_round_trips_to_exact_float(milestone_repo):
    plan = [{"id": "a", "label": "Odd", "targetBalance": Decimal("595413.43"),
             "targetDate": "2026-06-18"}]
    milestone_repo.set_milestones(plan)
    got = milestone_repo.get_milestones()
    assert got[0]["targetBalance"] == 595413.43


def test_two_non_default_scopes_do_not_bleed(milestone_repo):
    # The impl test isolates one non-default scope from SHARED; this proves two
    # non-default tenants are independent — the multi-user isolation guarantee.
    plan_x = [{"id": "x1", "label": "X", "targetBalance": Decimal("100000"), "targetDate": "2026-06-18"}]
    plan_y = [{"id": "y1", "label": "Y", "targetBalance": Decimal("200000"), "targetDate": "2027-06-18"}]
    milestone_repo.set_milestones(plan_x, scope="user-x")
    milestone_repo.set_milestones(plan_y, scope="user-y")
    assert [m["id"] for m in milestone_repo.get_milestones(scope="user-x")] == ["x1"]
    assert [m["id"] for m in milestone_repo.get_milestones(scope="user-y")] == ["y1"]
    assert milestone_repo.get_milestones() is None      # SHARED still empty
    assert len(milestone_repo._table.store) == 2


def test_row_key_is_milestones_pk_and_scope_sk(milestone_repo):
    # Locks the physical key shape the multi-tenant seam depends on: pk fixed, sk=scope.
    plan = [{"id": "a", "label": "K", "targetBalance": Decimal("100000"), "targetDate": "2026-06-18"}]
    milestone_repo.set_milestones(plan, scope="user-z")
    assert ("MILESTONES", "user-z") in milestone_repo._table.store


# --- WHIT-383 read-hardening --------------------------------------------------------------


def test_row_without_milestones_attribute_reads_as_none(milestone_repo):
    # A row exists at pk=MILESTONES but carries no `milestones` attribute (a legacy/partial
    # write). Both accessors must read it as "unset" (None), never KeyError-500.
    _store_raw_row(milestone_repo, None)
    assert milestone_repo.get_milestones() is None
    assert milestone_repo.get_milestones_raw() is None


@pytest.mark.parametrize("missing_field", ["id", "label", "targetBalance", "targetDate"])
def test_client_read_skips_a_milestone_missing_a_field(milestone_repo, missing_field):
    # A milestone missing any one field is skipped on the client read; the complete one stays.
    partial_base = {"id": "bad", "label": "Half", "targetBalance": Decimal("200000"),
                    "targetDate": "2031-01-01"}
    partial = {k: v for k, v in partial_base.items() if k != missing_field}
    _store_raw_row(milestone_repo, [_COMPLETE, partial])
    got = milestone_repo.get_milestones()
    assert [m["id"] for m in got] == ["m1"]


def test_client_read_skips_a_milestone_with_null_target_balance(milestone_repo):
    # The field is PRESENT but null: float(None) would 500 the read. Must skip, not crash.
    partial = {**_COMPLETE, "id": "bad", "targetBalance": None}
    _store_raw_row(milestone_repo, [_COMPLETE, partial])
    assert [m["id"] for m in milestone_repo.get_milestones()] == ["m1"]


def test_client_read_skips_a_milestone_with_non_numeric_target_balance(milestone_repo):
    # A non-numeric string balance (float("abc") -> ValueError) is skipped, not a crash.
    partial = {**_COMPLETE, "id": "bad", "targetBalance": "not-a-number"}
    _store_raw_row(milestone_repo, [_COMPLETE, partial])
    assert [m["id"] for m in milestone_repo.get_milestones()] == ["m1"]


def test_client_read_all_partial_returns_empty_list(milestone_repo):
    # Every stored milestone is malformed -> [] (a coherent "nothing usable"), not None/500.
    _store_raw_row(milestone_repo, [{"id": "x"}, {"label": "y"}])
    assert milestone_repo.get_milestones() == []


def test_raw_read_does_not_skip_partial_milestones(milestone_repo):
    # The RAW read returns rows verbatim (the per-row skip lives in _resolve_plan, not the
    # repo, since WHIT-387). get_milestones_raw hands back the partial milestone untouched;
    # shared/milestones._resolve_plan is where it gets skipped.
    partial = {"id": "bad", "label": "no balance", "targetDate": "2030-01-01"}
    _store_raw_row(milestone_repo, [_COMPLETE, partial])
    raw = milestone_repo.get_milestones_raw()
    assert len(raw) == 2
    assert raw[1] == partial


def test_poller_resolve_skips_a_partial_row_not_raises(shared, milestone_repo):
    # WHIT-387: a present-but-partial stored milestone is now SKIPPED by resolve_plan, not
    # raised into the poller's swallow. A lone bad row leaves an empty plan; it never falls
    # back to the default (which would send a wrong default celebration for corrupt data).
    partial = {"id": "bad", "label": "no balance", "targetDate": "2030-01-01"}  # no targetBalance
    _store_raw_row(milestone_repo, [partial])
    assert shared.milestones.resolve_plan(milestone_repo) == []


# --- WHIT-383 read-hardening: `milestones` stored as a non-list -----------------------------

_COMPLETE2 = {"id": "m2", "label": "Target", "targetBalance": Decimal("55000"),
              "targetDate": "2032-01-01"}


@pytest.mark.parametrize("scalar", [5, Decimal("5"), True])
def test_client_read_scalar_milestones_returns_empty(milestone_repo, scalar):
    # A corrupt row storing `milestones` as a non-iterable scalar must NOT 500 on the
    # iteration itself — the client read degrades to [].
    _store_raw_row(milestone_repo, scalar)
    assert milestone_repo.get_milestones() == []


def test_client_read_milestones_stored_as_dict_returns_empty(milestone_repo):
    # `milestones` is a dict (corrupt/legacy write) -> [], not a 500.
    _store_raw_row(milestone_repo, {"m1": _COMPLETE})
    assert milestone_repo.get_milestones() == []


def test_client_read_milestones_stored_as_string_returns_empty(milestone_repo):
    # `milestones` stored as a bare string -> [], not a 500.
    _store_raw_row(milestone_repo, "corrupt")
    assert milestone_repo.get_milestones() == []


@pytest.mark.parametrize("junk", ["a string", None, 42, ["nested"]])
def test_client_read_skips_non_dict_list_elements(milestone_repo, junk):
    # A non-dict element (string/None/int/list) among valid milestones is skipped
    # (TypeError on subscription), the valid ones survive.
    _store_raw_row(milestone_repo, [_COMPLETE, junk, _COMPLETE2])
    assert [m["id"] for m in milestone_repo.get_milestones()] == ["m1", "m2"]


def test_client_read_preserves_order_of_survivors(milestone_repo):
    # Interleaved valid/invalid: survivors keep their STORED order (m2 before m1),
    # locking the append-in-iteration-order contract.
    bad = {"id": "bad", "label": "x", "targetBalance": None, "targetDate": "2031-01-01"}
    _store_raw_row(milestone_repo, [_COMPLETE2, bad, _COMPLETE])
    assert [m["id"] for m in milestone_repo.get_milestones()] == ["m2", "m1"]


def test_poller_resolve_degrades_non_list_milestones_to_empty(shared, milestone_repo):
    # WHIT-387: a `milestones` stored as a non-list (a dict here) is not iterable as rows, so
    # resolve_plan's isinstance guard degrades it to an empty plan rather than raising into the
    # poller's swallow. Still never the default (no wrong default celebration for corrupt data).
    _store_raw_row(milestone_repo, {"m1": _COMPLETE})
    assert shared.milestones.resolve_plan(milestone_repo) == []
