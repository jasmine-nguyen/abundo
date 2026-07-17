"""WHIT-296: the budget_excluded override must survive re-sync exactly like notes/
tags. Reconciliation rebuilds the posted row from the bank feed (recomputing
counts_to_budget), then carries the user-owned fields off the matched pending /
existing posted via _with_carried_category. The override rides that same carry, so
a re-import can't wipe it.
"""


def test_carry_brings_budget_excluded_onto_a_fresh_posted(lam, repo):
    # The pending leg the user marked as a transfer; the freshly-normalised posted has
    # no override yet. The carry moves it across so the exclusion survives settlement.
    posted = {"transaction_id": "B", "category": "FOOD", "counts_to_budget": True}
    source = {"category": "coffee", "budget_excluded": True}

    carried = repo._with_carried_category(posted, source)

    assert carried["budget_excluded"] is True
    assert posted.get("budget_excluded") is None  # original not mutated (it's a copy)


def test_bank_recompute_of_counts_to_budget_does_not_wipe_the_override(lam, repo):
    # The re-imported posted carries the bank's own counts_to_budget=True; the override
    # lives in a SEPARATE field, so the recompute leaves it untouched — the whole point
    # of storing budget_excluded apart from counts_to_budget.
    posted = {"transaction_id": "B", "category": "coffee", "counts_to_budget": True}
    source = {"category": "coffee", "budget_excluded": True}

    carried = repo._with_carried_category(posted, source)

    assert carried["counts_to_budget"] is True  # bank value intact
    assert carried["budget_excluded"] is True    # user override intact


def test_absent_source_override_keeps_the_posted_own_override(lam, repo):
    # A source with no override never clobbers an override the posted already holds
    # (falsy/absent source is skipped) — mirrors the notes/tags carry rule.
    posted = {"transaction_id": "B", "category": "coffee", "budget_excluded": True}
    source = {"category": "coffee"}  # no override

    carried = repo._with_carried_category(posted, source)

    assert carried["budget_excluded"] is True


def test_dedupe_guard_keeps_a_post_settlement_override(lam, repo):
    # keep_posted_notes_tags (the dedupe sweep): the user excluded the POSTED after
    # settlement; a stale pending twin without the override must not un-exclude it.
    posted = {"transaction_id": "B", "category": "coffee", "budget_excluded": True}
    source = {"category": "coffee"}  # stale pending, no override

    carried = repo._with_carried_category(posted, source, keep_posted_notes_tags=True)

    assert carried["budget_excluded"] is True
