"""WHIT-663: the hourly pending mirror moves a user's edit onto the settled charge straight away.

An edited pending the bank no longer lists → its edit is copied onto its settled twin and the
pending is removed, in the same run. No twin yet → the pending is kept for next hour.

Runs the REAL shared TransactionRepository over the in-memory FakeTable, like
test_pending_mirror.py.
"""

from _pending_mirror_fakes import (
    GUZMAN,
    MIRROR_TODAY,
    WESTPAC_AID,
    WESTPAC_SOURCE,
    bank_rows,
    fetch_returning,
    pending_row,
    stored,
    stored_ids,
    unfiled_except,
)

_is_unfiled = unfiled_except("groceries")


def test_an_edited_pending_the_bank_dropped_moves_its_edit_onto_the_settled_charge(repo, mirror):
    repo._table.seed(
        pending_row("listed"),
        # The user filed and noted this pending; the bank has since settled it as "settled".
        pending_row("edited", day="2026-09-27", category="groceries", notes="dinner with Sam", **GUZMAN),
        pending_row("settled", status="posted", **GUZMAN),
        # Edited too, but its settled charge hasn't arrived yet.
        pending_row("waiting", notes="gift for Mum"),
    )
    bank = bank_rows("listed") + [{"id": "settled", "accountId": WESTPAC_AID, "pending": False}]

    result = mirror.mirror_account(repo, fetch_returning(bank), WESTPAC_SOURCE, MIRROR_TODAY, _is_unfiled)

    assert stored_ids(repo) == {"listed", "settled", "waiting"}
    settled = stored(repo, "settled")
    assert settled["status"] == "posted"
    assert settled["category"] == "groceries"
    assert settled["notes"] == "dinner with Sam"
    assert stored(repo, "waiting")["notes"] == "gift for Mum"
    assert result["carried"] == 1
    assert result["kept"] == 1
    assert result["removed"] == 0
    assert result["failed"] == 0


def test_a_second_pending_never_overwrites_the_note_an_earlier_run_carried(repo, mirror):
    # WHIT-666: each run re-reads the settled charges, so the in-run "claimed twin" guard does not
    # protect a note carried by an earlier run.
    repo._table.seed(
        pending_row("first", day="2026-09-27", notes="dinner with Sam", **GUZMAN),
        pending_row("settled", status="posted", **GUZMAN),
    )
    bank = [{"id": "settled", "accountId": WESTPAC_AID, "pending": False}]

    first_run = mirror.mirror_account(repo, fetch_returning(bank), WESTPAC_SOURCE, MIRROR_TODAY, _is_unfiled)

    assert first_run["carried"] == 1
    assert stored(repo, "settled")["notes"] == "dinner with Sam"

    # A later pending at the same shop, same amount, turns up and then drops off the bank's list.
    repo._table.seed(pending_row("second", day="2026-09-28", notes="lunch with Jo", **GUZMAN))

    second_run = mirror.mirror_account(repo, fetch_returning(bank), WESTPAC_SOURCE, MIRROR_TODAY, _is_unfiled)

    assert stored(repo, "settled")["notes"] == "dinner with Sam"
    assert "second" in stored_ids(repo)
    assert stored(repo, "second")["notes"] == "lunch with Jo"
    assert second_run["carried"] == 0
    assert second_run["kept"] == 1
