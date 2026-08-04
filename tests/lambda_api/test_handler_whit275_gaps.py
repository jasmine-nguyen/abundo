"""WHIT-275 adversarial GAP tests for patch_transaction (notes/tags).

The implementer covers over-limit rejections (501-char note, 21 tags, 51-char tag)
and the happy trims/dedupe. These add the MISSING halves: the EXACT-boundary
passes (== the cap must be accepted), the dedupe-then-cap ordering (>20 raw entries
that dedupe down to <=20 are accepted), and the partial-write guard (a blank
`category` alongside a valid `notes` must 400 the WHOLE request and write NOTHING).

FakeRepo / _patch_event are imported from the shared tests/shared/_handler_patch_fakes.py
so this gap suite and the impl suite share ONE definition — a copy could drift from the
real sentinel-gated update_transaction_fields (WHIT-445).
"""

import json

from _handler_patch_fakes import FakeRepo, _patch_event


# --- exact-boundary passes (implementer only tests one-over) -----------------


def test_patch_note_exactly_at_max_len_is_accepted(handler):  # [A6]
    repo = FakeRepo(keys={"pk": "p", "sk": "s"})
    note = "x" * handler.NOTE_MAX_LEN
    resp = handler.patch_transaction(_patch_event(body=json.dumps({"notes": note})), repo)
    assert resp["statusCode"] == 200
    assert repo.update_calls == [("p", "s", {"notes": note})]


def test_patch_tag_exactly_at_max_len_is_accepted(handler):  # [A7]
    repo = FakeRepo(keys={"pk": "p", "sk": "s"})
    tag = "y" * handler.TAG_MAX_LEN
    resp = handler.patch_transaction(_patch_event(body=json.dumps({"tags": [tag]})), repo)
    assert resp["statusCode"] == 200
    assert repo.update_calls == [("p", "s", {"tags": [tag]})]


def test_patch_exactly_max_count_tags_is_accepted(handler):  # [A8]
    repo = FakeRepo(keys={"pk": "p", "sk": "s"})
    tags = [f"t{i}" for i in range(handler.TAG_MAX_COUNT)]
    resp = handler.patch_transaction(_patch_event(body=json.dumps({"tags": tags})), repo)
    assert resp["statusCode"] == 200
    assert json.loads(resp["body"])["tags"] == tags


# --- dedupe happens BEFORE the count cap -------------------------------------


def test_patch_over_max_raw_tags_that_dedupe_under_the_cap_are_accepted(handler):  # [A9]
    # 20 unique + 10 case-insensitive dups = 30 raw, 20 survive dedupe. The cap is on
    # the CLEANED count, so this is a 200 — proving the count check runs after dedupe.
    unique = [f"t{i}" for i in range(handler.TAG_MAX_COUNT)]
    raw = unique + [t.upper() for t in unique[:10]]
    repo = FakeRepo(keys={"pk": "p", "sk": "s"})
    resp = handler.patch_transaction(_patch_event(body=json.dumps({"tags": raw})), repo)
    assert resp["statusCode"] == 200
    assert json.loads(resp["body"])["tags"] == unique  # first-seen casing kept


# --- partial-write guard: one bad field rejects the WHOLE request ------------


def test_patch_blank_category_with_valid_notes_400s_and_writes_nothing(handler):  # [A10]
    repo = FakeRepo(keys={"pk": "p", "sk": "s"})
    resp = handler.patch_transaction(
        _patch_event(body='{"category": "  ", "notes": "keep me"}'), repo)
    assert resp["statusCode"] == 400
    assert repo.update_calls == []  # the good note must NOT be partially persisted


def test_patch_bad_tag_with_valid_notes_400s_and_writes_nothing(handler):  # [A11]
    repo = FakeRepo(keys={"pk": "p", "sk": "s"})
    resp = handler.patch_transaction(
        _patch_event(body='{"notes": "keep me", "tags": [1]}'), repo)
    assert resp["statusCode"] == 400
    assert repo.update_calls == []
