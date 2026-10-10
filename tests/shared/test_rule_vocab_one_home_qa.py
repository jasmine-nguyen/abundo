"""WHIT-608 QA — the rule engine reads the ONE shared rule vocabulary, and still accepts/rejects
exactly the same (field, operator) pairs and logic values as before the move.

Identity is checked in a fresh interpreter (shared/ only on the path) so other suites that shed
and re-import `constants` can't make it flaky.
"""

import pathlib
import subprocess
import sys

from _ast_bindings import _top_level_binding_list
from _rule_pairs import PAIR_VALUE, RULE_PAIRS

ROOT = pathlib.Path(__file__).resolve().parents[2]
SHARED_DIR = ROOT / "shared"

_RULE_VOCAB_NAMES = {"RULE_FIELD_OPERATORS", "RULE_FIELDS", "RULE_OPERATORS", "RULE_LOGIC",
                     "RULE_DIRECTIONS", "_FIELD_OPERATORS", "_LOGIC"}


def _rule(field, operator):
    return {"id": "r1", "categoryId": "transport", "field": field, "operator": operator,
            "value": PAIR_VALUE.get(field, "UBER")}


# [A3] (P0) the engine's vocabulary IS the shared constants object — no private copy.
def test_engine_vocabulary_is_the_shared_constants_object():
    probe = (
        "import constants, rule_engine; "
        "print(rule_engine.RULE_FIELD_OPERATORS is constants.RULE_FIELD_OPERATORS, "
        "rule_engine.RULE_LOGIC is constants.RULE_LOGIC)"
    )
    result = subprocess.run([sys.executable, "-c", probe], cwd=SHARED_DIR,
                            capture_output=True, text=True, check=True)
    assert result.stdout.split() == ["True", "True"], result.stdout + result.stderr


def test_no_other_server_file_keeps_a_copy_of_the_rule_vocabulary():
    server_files = [path for folder in ROOT.glob("lambda*/") for path in folder.glob("*.py")]
    server_files += [path for path in SHARED_DIR.glob("*.py") if path.name != "constants.py"]
    copies = [f"{path.relative_to(ROOT)}: {name}" for path in sorted(server_files)
              for name in sorted(set(_top_level_binding_list(path)) & _RULE_VOCAB_NAMES)]
    assert copies == [], f"import the rule vocabulary from constants instead: {copies}"


# [A4] (P0) every supported pair is still applicable by the engine.
def test_engine_accepts_every_supported_pair(rule_engine):
    skipped = {pair: rule_engine._skip_reason(_rule(*pair), lambda _id: False) for pair in RULE_PAIRS}
    assert {pair: reason for pair, reason in skipped.items() if reason} == {}


# [A5] (P0) pairs outside the vocabulary are still refused as unsupported.
def test_engine_refuses_pairs_outside_the_vocabulary(rule_engine):
    for field, operator in [("amount", "contains"), ("category", "contains"), ("direction", "equals"),
                            ("account", "contains"), ("merchant", "is"), ("payee", "equals")]:
        reason = rule_engine._skip_reason(_rule(field, operator), lambda _id: False)
        assert reason == "unsupported rule type", (field, operator, reason)


# [A6] (P1) "any" is still honoured as OR; an unknown logic still falls back to "all" (AND).
def test_engine_logic_any_is_or_and_unknown_falls_back_to_all(rule_engine):
    conditions = [{"field": "description", "operator": "contains", "value": "UBER"},
                  {"field": "description", "operator": "contains", "value": "NOPE"}]
    transaction = {"description": "UBER TRIP", "amount": -10}
    assert rule_engine.rule_matches({"conditions": conditions, "logic": "any"}, transaction) is True
    assert rule_engine.rule_matches({"conditions": conditions, "logic": "all"}, transaction) is False
    assert rule_engine.rule_matches({"conditions": conditions, "logic": "xor"}, transaction) is False
