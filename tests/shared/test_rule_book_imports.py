"""WHIT-623 — shared/rule_book.py ships in both the webhook and the API bundles, which carry
different `constants` and only the webhook has `banksync`. So the rule book imports neither."""

import pathlib

SOURCE = (pathlib.Path(__file__).resolve().parents[2] / "shared" / "rule_book.py").read_text()


def test_rule_book_imports_no_constants():
    assert "from constants import" not in SOURCE
    assert "import constants" not in SOURCE


def test_rule_book_imports_no_banksync():
    assert "from banksync import" not in SOURCE
    assert "import banksync" not in SOURCE
