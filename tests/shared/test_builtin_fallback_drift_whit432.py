"""The OTHER direction of the WHIT-432 mirror: server -> client (WHIT-432 QA).

WHIT-432's stated goal is that "a future server-side re-space reddens the client", and
the pin it added — src/__tests__/seedSlotSync.logic.test.ts [A7] — does read the real
.py. But that pin lives in JEST, and .github/workflows/client-tests.yml does NOT list
shared/repository_category.py in its pull_request `paths:`. A server-only pull request
that re-spaces a seed slot therefore skips the whole client workflow, and the guard
built for exactly that pull request never runs on it.

That asymmetry was already solved once in the opposite direction: python-tests.yml
lists src/chartColors.ts so a client-only edit still wakes the pytest guard (WHIT-406),
and test_chart_ramp_parser_edges.py [A17] keeps that entry alive. This file is the
mirror image — the same comparison, run from the suite a SERVER change actually
triggers, plus [B7] which names the missing trigger.

Covers, by checklist id:
  [B5]  BUILTIN_CATEGORY_INDEX parses out of the shipped client file
  [B6]  every seeded built-in's fallback position == ASSIGNMENT_ORDER[its seed slot]
  [B7]  client-tests.yml wakes when shared/repository_category.py changes
"""

import pathlib
import re

import pytest

from _chart_ramp import assignment_order, category_colors, ramp_source_path

_REPO_ROOT = pathlib.Path(__file__).resolve().parents[2]
_CLIENT_WORKFLOW = _REPO_ROOT / ".github" / "workflows" / "client-tests.yml"
_SEED_MODULE = "shared/repository_category.py"

# `export const BUILTIN_CATEGORY_INDEX: Record<string, number> = { ... };` — anchored at
# the start of a line so the several comment mentions of the name cannot match, and
# comments are stripped first so a commented-out entry is not counted as live.
_COMMENT = re.compile(r"//[^\n]*|/\*.*?\*/", re.DOTALL)
_DECLARATION = re.compile(
    r"^export const BUILTIN_CATEGORY_INDEX[^=]*=\s*\{(.*?)\}", re.MULTILINE | re.DOTALL
)
_PAIR = re.compile(r"([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(\d+)")


def parse_builtin_index(text: str) -> dict:
    """{built-in id -> its id-derived ramp position}, out of the client TypeScript.

    Asserts rather than returns short: a silently-empty map would make [B6] vacuous,
    which is the one failure mode a drift guard cannot afford (green is its normal
    state, so a reader that stopped reading looks exactly like a healthy run).
    """
    bodies = _DECLARATION.findall(_COMMENT.sub("", text))
    assert len(bodies) == 1, (
        "expected exactly one `export const BUILTIN_CATEGORY_INDEX = {...}` declaration, "
        f"found {len(bodies)} — if it was renamed or reshaped, update this parser; if "
        "there are two, delete the dead one."
    )
    index = {name: int(value) for name, value in _PAIR.findall(bodies[0])}
    assert index, (
        "parsed zero entries out of BUILTIN_CATEGORY_INDEX — the entry shape changed; "
        "update the parser in tests/shared/test_builtin_fallback_drift_whit432.py"
    )
    return index


@pytest.fixture
def slots(shared):
    """The server's colour-slot module, imported under `shared`'s sys.path.

    Same fixture as test_color_slot_ramp_drift.py's: repository_category is in
    conftest._REIMPORT, so it is shed afterwards and cannot leak into lambda_api.
    """
    import repository_category

    return repository_category


def test_the_builtin_index_parser_reads_fabricated_source():
    """[B5] Drive the parser against source whose answer is known, so "it still reads
    something real" is itself pinned — and against source it must refuse, so it can
    never return a short map that [B6] would compare vacuously."""
    good = "export const BUILTIN_CATEGORY_INDEX: Record<string, number> = {\n  a: 1, b: 2,\n};\n"
    assert parse_builtin_index(good) == {"a": 1, "b": 2}
    # a commented-out entry is not a live one
    commented = (
        "export const BUILTIN_CATEGORY_INDEX: Record<string, number> = {\n"
        "  a: 1, /* b: 2, */\n};\n"
    )
    assert parse_builtin_index(commented) == {"a": 1}
    for unreadable in ("// export const BUILTIN_CATEGORY_INDEX = { a: 1 };", good * 2, ""):
        with pytest.raises(AssertionError):
            parse_builtin_index(unreadable)


def test_every_builtin_fallback_equals_its_seed_slots_ramp_position(slots):
    """[B6] The WHIT-432 contract, checked from the side a server-only change triggers.

    A built-in resolves its colour two ways: CATEGORY_COLORS[ASSIGNMENT_ORDER[stored
    colorSlot]] when the slot has arrived, and CATEGORY_COLORS[BUILTIN_CATEGORY_INDEX[id]]
    when it has not. Re-space a seed slot here and only the first moves, so the same
    category paints two different colours depending on whether that user's row has been
    backfilled yet — which is precisely the bug WHIT-432 closed for
    shopping/transport/phonenet."""
    index = parse_builtin_index(ramp_source_path().read_text())
    order = assignment_order()
    ramp = category_colors()

    assert set(index) == set(slots.SEED_CATEGORIES), (
        "the client fallback table and the server seed no longer know the same category "
        f"ids: client-only {sorted(set(index) - set(slots.SEED_CATEGORIES))}, "
        f"server-only {sorted(set(slots.SEED_CATEGORIES) - set(index))}"
    )
    assert len(index) == 13

    drift = {
        category_id: {
            "seed_slot": category["colorSlot"],
            "server_paints": ramp[order[category["colorSlot"]]],
            "client_fallback_paints": ramp[index[category_id]],
        }
        for category_id, category in slots.SEED_CATEGORIES.items()
        if index[category_id] != order[category["colorSlot"]]
    }
    assert not drift, (
        "built-in colour drift: BUILTIN_CATEGORY_INDEX in "
        f"{ramp_source_path().name} must equal ASSIGNMENT_ORDER[the seed colorSlot] for "
        f"every built-in, and these disagree: {drift}. A user whose row has been "
        "backfilled sees one colour and a user whose row has not sees another. If you "
        "re-spaced a seed slot on purpose, move the client table in the same commit."
    )

    # Non-vacuity: the loop above proves nothing if the two tables are trivially equal
    # because ASSIGNMENT_ORDER is the identity. It is a real permutation, so at least one
    # built-in's seed slot differs from the ramp position it resolves to.
    assert any(
        category["colorSlot"] != order[category["colorSlot"]]
        for category in slots.SEED_CATEGORIES.values()
    )


# ------------------------------------------------------------------ the missing trigger

# One list entry: a quoted or bare scalar, stopping before any inline `# comment`.
# Same hand-parse as test_chart_ramp_parser_edges.py — PyYAML is not installed on the
# runner (CI installs only lambda_sync_trigger/requirements-dev.txt).
_ENTRY = re.compile(r"-\s*(?:\"([^\"]*)\"|'([^']*)'|([^#\s]+))")


def _pull_request_paths(workflow: pathlib.Path) -> list:
    """The LIVE `paths:` list of a workflow's pull_request trigger.

    A `#`-commented line is NOT an entry — which is the whole point: a substring search
    would find a commented-out path and report a trigger that GitHub ignores.
    """
    paths, in_pull_request, indent, pull_request_column = [], False, None, 0
    for raw in workflow.read_text().splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        column = len(raw) - len(raw.lstrip())
        if not in_pull_request:
            in_pull_request = line == "pull_request:"
            pull_request_column = column
            continue
        if indent is None:
            if column <= pull_request_column:
                break
            if line == "paths:":
                indent = column
            continue
        if column <= indent and not line.startswith("-"):
            break
        match = _ENTRY.match(line)
        if match:
            paths.append(next(group for group in match.groups() if group is not None))
    return paths


def test_a_server_only_seed_change_still_wakes_the_client_guard():
    """[B7] The Jest pin that reads this .py only protects anything if a pull request
    touching this .py RUNS Jest. client-tests.yml filters on paths, and a server-only
    change matches none of them — so the guard WHIT-432 built for a server-side re-space
    is exactly the guard that server-side re-space skips.

    python-tests.yml already carries the mirror-image entry (src/chartColors.ts) for the
    same reason. Fix by adding `- "shared/repository_category.py"` to client-tests.yml's
    pull_request paths, or by keeping [B6] above as the pytest-side guard and saying so."""
    assert (_REPO_ROOT / _SEED_MODULE).exists(), (
        f"{_SEED_MODULE} no longer exists — this test names a file that moved, so it "
        "would stay green while nothing was guarded. Update the name."
    )
    paths = _pull_request_paths(_CLIENT_WORKFLOW)
    assert paths, f"parsed no pull_request paths out of {_CLIENT_WORKFLOW.name}"
    covered = any(
        _SEED_MODULE.startswith(entry.rstrip("*").rstrip("/")) for entry in paths
    )
    assert covered, (
        f"no live on.pull_request.paths entry in {_CLIENT_WORKFLOW.name} covers "
        f"{_SEED_MODULE} — the entries actually present are {paths}. "
        "src/__tests__/seedSlotSync.logic.test.ts reads that .py to catch a seed re-space, "
        "but a server-only pull request skips the client workflow entirely, so the pin "
        "never runs on the change it exists for."
    )


def test_the_guard_and_the_ramp_file_are_covered_by_the_python_trigger():
    """[B7b] The counterpart: this file must itself run when either side moves. `tests/**`
    covers it and `src/chartColors.ts` is listed explicitly (WHIT-406); if either entry is
    ever narrowed, a re-space could pass unguarded from BOTH directions."""
    paths = _pull_request_paths(_REPO_ROOT / ".github" / "workflows" / "python-tests.yml")
    ramp = ramp_source_path().relative_to(_REPO_ROOT).as_posix()
    for guarded in (ramp, _SEED_MODULE, "tests/shared/test_builtin_fallback_drift_whit432.py"):
        assert any(
            guarded.startswith(entry.rstrip("*").rstrip("/")) for entry in paths
        ), f"no on.pull_request.paths entry in python-tests.yml covers {guarded}"
