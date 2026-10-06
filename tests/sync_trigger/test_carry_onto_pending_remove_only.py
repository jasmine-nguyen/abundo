"""WHIT-790: carry_onto_pending with nothing to carry but a cleared rule stamp sends a valid
'clear only' write (the old hand-built instruction sent an empty SET)."""

from _pending_mirror_fakes import CETTIRE_NEW, stored


def test_carry_with_every_field_empty_only_clears_the_rule_stamp(repo, row):
    pending = row("new_cettire", CETTIRE_NEW, "-260.36", category="clothing", notes="Jacket", filed_by_rule="rule-1")
    repo._table.seed(pending)
    carried = {"pk": pending["pk"], "sk": pending["sk"]}

    assert repo.carry_onto_pending(pending["pk"], pending["sk"], carried) is True

    expected = dict(pending)
    expected.pop("filed_by_rule")
    assert stored(repo, "new_cettire") == expected
