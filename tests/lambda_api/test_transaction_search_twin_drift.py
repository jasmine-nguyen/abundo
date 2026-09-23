"""Cross-file drift-pin for the Transactions search twins (WHIT-576).

The app (src/context.tsx) and the server (lambda_api/transaction_search.py) each carry a copy of
the CLEAN_NAME display-name map and the search settings. The shared parity fixture only tests the
rows written into it, so a new CLEAN_NAME entry added on one side alone would slip through — the
server would silently miss the cleaned name. This reads the app's source as TEXT (no JS runtime in
the pytest suite) and pins both copies equal.
"""

import pathlib
import re

import pytest

pytestmark = pytest.mark.crosslang

_TS_TWIN = pathlib.Path(__file__).resolve().parents[2] / "src" / "context.tsx"


def _ts_source():
    return _TS_TWIN.read_text()


def test_clean_name_maps_are_identical(transaction_search):
    block = re.search(r"export const CLEAN_NAME: Record<string, string> = \{(.*?)\n\};", _ts_source(), re.S)
    assert block, "CLEAN_NAME not found in src/context.tsx"
    entries = dict(re.findall(r"^\s*'([^']*)':\s*'([^']*)',", block.group(1), re.M))
    assert entries == transaction_search.CLEAN_NAME


def test_notes_and_tags_switch_is_identical(transaction_search):
    match = re.search(r"export const SEARCH_NOTES_AND_TAGS = (true|false);", _ts_source())
    assert match, "SEARCH_NOTES_AND_TAGS not found in src/context.tsx"
    assert (match.group(1) == "true") is transaction_search.SEARCH_NOTES_AND_TAGS


def test_query_max_length_is_identical(transaction_search):
    match = re.search(r"export const SEARCH_QUERY_MAX_LEN = (\d+);", _ts_source())
    assert match, "SEARCH_QUERY_MAX_LEN not found in src/context.tsx"
    assert int(match.group(1)) == transaction_search.SEARCH_QUERY_MAX_LEN
