"""Adversarial gaps around the colour-slot drift guard (WHIT-406 QA).

test_color_slot_ramp_drift.py proves the two languages agree TODAY. These prove the
machinery that reads the client file cannot quietly stop reading it — the failure mode
a guard has that ordinary tests do not: green is its normal state, so a reader that
returns nothing, reads the wrong file, or is no longer triggered by CI looks exactly
like a healthy run.

Covers, by checklist id:
  [A1]-[A12]  parser behaviour against fabricated TypeScript (never the real file, so
              these keep meaning after a legitimate palette change)
  [A13]-[A16] ramp_source_path() discovery: test-tree fixtures, ambiguity, a missing
              client dir, build artefacts
  [A19]       tests/shared/conftest.py sheds every shared module this suite imports

The old [A17]/[A18] pinned the hand-maintained `src/chartColors.ts` paths entry in
python-tests.yml as a live trigger. WHIT-436 replaced that per-file pin with the
twin-guards.yml drift job (this suite reads a client file, so it is marked `crosslang`
and runs there on any src/ change), so those trigger pins are gone.
"""

import ast
import pathlib
import re

import pytest

import _chart_ramp

_REPO_ROOT = pathlib.Path(__file__).resolve().parents[2]
_SHARED_DIR = _REPO_ROOT / "shared"
_TESTS_SHARED_DIR = pathlib.Path(__file__).resolve().parent


def _ramp_src(body: str, name: str = "CATEGORY_COLORS") -> str:
    return f"export const {name} = [{body}] as const;\n"


# --------------------------------------------------------------------------- parsers


def test_hex_entry_forms_all_parse():
    """[A1] Design ships 6-digit hexes today, but #RGB shorthand and an 8-digit
    #RRGGBBAA are both legal CSS. If the palette ever moves to either, the reader must
    keep counting entries — an under-count reads as drift and cries wolf; an over-count
    could mask a real one."""
    assert _chart_ramp.parse_ramp(_ramp_src("'#abc', '#def'")) == ["#abc", "#def"]
    assert _chart_ramp.parse_ramp(
        _ramp_src("'#aabbccdd', '#112233ff'")
    ) == ["#aabbccdd", "#112233ff"]


def test_a_trailing_comma_does_not_invent_an_entry():
    """[A2] The real file ends every row with a trailing comma (src/chartColors.ts:11).
    A parser that split on commas would count a phantom 21st colour and report drift
    against a server that is perfectly in step."""
    assert _chart_ramp.parse_ramp("export const CATEGORY_COLORS = [\n  '#000000',\n];") == [
        "#000000"
    ]
    assert _chart_ramp.parse_order("export const ASSIGNMENT_ORDER = [\n  1, 0,\n];") == [1, 0]


def test_a_commented_out_entry_inside_the_block_is_not_counted():
    """[A3] The likeliest way a ramp shrinks in practice is someone commenting a line
    out rather than deleting it. If the reader counted the commented entry it would
    still report 20 while the app paints 19 — the guard would sit green over exactly
    the bug it exists to catch."""
    ramp = "export const CATEGORY_COLORS = [\n  '#000000',\n  // '#ffffff',\n];"
    assert _chart_ramp.parse_ramp(ramp) == ["#000000"]

    order = "export const ASSIGNMENT_ORDER = [\n  1, 0, // was 20 entries\n];"
    assert _chart_ramp.parse_order(order) == [1, 0], (
        "a number inside a trailing // comment leaked into ASSIGNMENT_ORDER"
    )


def test_crlf_source_parses_the_same_as_lf():
    """[A4] .gitattributes does not normalise this file, and a Windows checkout or an
    editor round-trip can hand pytest \\r\\n. The declaration must still be recognised —
    a reader that only matched \\n would fail with 'update the parser' on a file nobody
    touched."""
    crlf = "export const CATEGORY_COLORS = [\r\n  '#000000', '#111111',\r\n] as const;\r\n"
    assert _chart_ramp.parse_ramp(crlf) == ["#000000", "#111111"]
    crlf_order = "export const ASSIGNMENT_ORDER = [\r\n  1, 0,\r\n] as const;\r\n"
    assert _chart_ramp.parse_order(crlf_order) == [1, 0]


def test_an_indented_declaration_is_not_read_as_the_ramp():
    """[A5] The pattern is anchored to the start of a line on purpose — src/chartColors.ts
    mentions CATEGORY_COLORS in half a dozen comments and inside chartCategoryColor
    (:106-:110), and any of those matching would parse a fragment as the palette. Prove
    the anchor holds: an indented declaration is refused loudly, not read."""
    with pytest.raises(AssertionError, match="update the parser"):
        _chart_ramp.parse_ramp("  export const CATEGORY_COLORS = ['#000000'];")


def test_a_name_that_merely_starts_with_the_ramps_name_is_not_matched():
    """[A6] A sibling palette called CATEGORY_COLORSX / CATEGORY_COLORS_DARK must not be
    mistaken for the ramp, and must not make the real one ambiguous either."""
    both = (
        "export const CATEGORY_COLORSX = ['#000000'];\n"
        "export const CATEGORY_COLORS = ['#111111'];\n"
    )
    assert _chart_ramp.parse_ramp(both) == ["#111111"]

    with pytest.raises(AssertionError, match="update the parser"):
        _chart_ramp.parse_ramp("export const CATEGORY_COLORSX = ['#000000'];")


def test_a_reshaped_declaration_says_update_the_parser_instead_of_going_green():
    """[A7] The vacuity case the card names. A type annotation
    (`: readonly string[] =`) is a routine TypeScript tidy-up that no longer matches the
    pattern. It must fail naming the parser, never return an empty list that compares
    equal to nothing and passes."""
    for reshaped in (
        "export const CATEGORY_COLORS: readonly string[] = ['#000000'];",
        "export const CATEGORY_COLORS = Object.freeze(['#000000']);",
        "export const CATEGORY_COLORS = RAMP;",
    ):
        with pytest.raises(AssertionError, match="update the parser"):
            _chart_ramp.parse_ramp(reshaped)

    with pytest.raises(AssertionError, match="update the parser"):
        _chart_ramp.parse_order("export const ASSIGNMENT_ORDER: number[] = [1, 0];")


def test_multi_line_and_suffixed_declarations_still_parse():
    """[A8] Prettier reflows the ramp across lines and may append `satisfies`. Neither
    is a semantic change, so neither may turn the guard red."""
    spread = (
        "export const CATEGORY_COLORS = [\n"
        "  '#000000',\n  '#111111',\n\n  '#222222',\n"
        "] satisfies readonly string[];\n"
    )
    assert _chart_ramp.parse_ramp(spread) == ["#000000", "#111111", "#222222"]


def test_an_entry_shape_with_no_hex_fails_loudly():
    """[A9] If the palette moved to `rgb()` / `oklch()` / imported tokens, the reader
    finds no colours. That must be an explicit failure, not an empty ramp — an empty
    ramp compared against the server's 20 would at least go red, but compared against a
    server that also shrank it would agree on nonsense."""
    with pytest.raises(AssertionError, match="update the parser"):
        _chart_ramp.parse_ramp("export const CATEGORY_COLORS = ['oklch(0.765 0.129 20)'];")
    with pytest.raises(AssertionError, match="update the parser"):
        _chart_ramp.parse_ramp("export const CATEGORY_COLORS = ['#ab'];")


def test_a_nested_reshape_cannot_report_the_full_ramp():
    """[A10] Grouping the ramp into rows (`[[...], [...]]`) is a plausible readability
    edit. The reader stops at the first `]`, so it sees a SHORT ramp — which is the safe
    direction: the drift guard goes red and a human looks. Pin that it can never come
    back looking complete."""
    rows = (
        "export const CATEGORY_COLORS = [\n"
        "  ['#000000', '#111111'],\n  ['#222222', '#333333'],\n"
        "] as const;\n"
    )
    assert len(_chart_ramp.parse_ramp(rows)) < 4, (
        "a nested reshape must not read back as a complete ramp — the drift guard would "
        "compare a number the app does not actually paint with"
    )


def test_a_block_commented_entry_is_not_counted():
    """[A11] The sibling of [A3] for `/* ... */`. This was a real defect found in review:
    the reader stripped `//` only, so a block-commented-out colour was still counted and
    the guard reported 20 while the app painted 19 — green over exactly the drift it
    exists to catch. Block comments are stripped now; this pins that."""
    ramp = "export const CATEGORY_COLORS = [\n  '#000000', /* '#ffffff', */\n];"
    assert _chart_ramp.parse_ramp(ramp) == ["#000000"], (
        "a /* */ block-commented colour is being counted as live — a commented-out entry "
        "would keep the drift guard green while the app paints one fewer"
    )

    order = "export const ASSIGNMENT_ORDER = [\n  1, /* was 20 */ 0,\n];"
    assert _chart_ramp.parse_order(order) == [1, 0], (
        "a number inside a /* */ comment leaked into ASSIGNMENT_ORDER"
    )


def test_a_bracket_inside_a_comment_does_not_truncate_the_ramp():
    """[A12] The other half of the same defect: comments are stripped BEFORE the array
    body is located, not after. Otherwise a `]` inside a comment inside the array ends
    the body early and the ramp reads short — a confusing red rather than a clear one."""
    ramp = (
        "export const CATEGORY_COLORS = [\n"
        "  '#000000', // ends the array ] here\n"
        "  '#ffffff',\n"
        "];"
    )
    assert _chart_ramp.parse_ramp(ramp) == ["#000000", "#ffffff"], (
        "a ] inside a comment truncated the ramp — strip comments before matching the body"
    )


# ------------------------------------------------------------------- file discovery


def _tree(root: pathlib.Path, files: dict) -> None:
    for relative, text in files.items():
        path = root / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text)


def test_a_ramp_declared_by_a_test_fixture_is_not_mistaken_for_the_apps(tmp_path, monkeypatch):
    """[A13] src/__tests__ is full of chart tests, and a fixture there declaring its own
    palette is entirely reasonable. If discovery picked it up, the guard would compare
    the server against a ramp the app never paints with — passing or failing for
    reasons unrelated to shipped behaviour."""
    _tree(tmp_path, {
        "src/chartColors.ts": _ramp_src("'#000000', '#111111'"),
        "src/__tests__/chartColors.logic.test.ts": _ramp_src("'#aaaaaa'"),
        "src/__tests__/fixtures/palette.ts": _ramp_src("'#bbbbbb', '#cccccc', '#dddddd'"),
    })
    monkeypatch.setattr(_chart_ramp, "_REPO_ROOT", tmp_path)

    assert _chart_ramp.ramp_source_path() == tmp_path / "src" / "chartColors.ts"
    assert _chart_ramp.category_colors() == ["#000000", "#111111"]


def test_two_shipped_ramps_fail_loudly_instead_of_picking_one(tmp_path, monkeypatch):
    """[A14] A copy left behind by a move (the exact thing that already happened to this
    file, _chart_ramp.py:9-12) must not be silently resolved by sort order. Whichever
    one it picked, half the app would paint from the other."""
    _tree(tmp_path, {
        "src/chartColors.ts": _ramp_src("'#000000', '#111111'"),
        "app/theme/chartColors.ts": _ramp_src("'#222222'"),
    })
    monkeypatch.setattr(_chart_ramp, "_REPO_ROOT", tmp_path)

    with pytest.raises(AssertionError, match="found 2"):
        _chart_ramp.ramp_source_path()


def test_discovery_survives_a_missing_client_directory(tmp_path, monkeypatch):
    """[A15] `app/` is a real directory today but the layout has moved before, and
    _CLIENT_DIRS is a hard-coded pair. A missing one must be skipped, not crash the
    guard with a FileNotFoundError that reads like a broken test rig."""
    _tree(tmp_path, {"src/chartColors.ts": _ramp_src("'#000000'")})
    monkeypatch.setattr(_chart_ramp, "_REPO_ROOT", tmp_path)
    monkeypatch.setattr(_chart_ramp, "_CLIENT_DIRS", ("src", "app", "packages"))

    assert _chart_ramp.ramp_source_path() == tmp_path / "src" / "chartColors.ts"


def test_build_artefacts_beside_the_ramp_are_not_read_as_ramps(tmp_path, monkeypatch):
    """[A16] The walk is rglob("*.ts*") — wider than .ts/.tsx. It also matches
    .tsbuildinfo, .ts.map and a Jest .tsx.snap. None of those declare the ramp today, so
    discovery must ignore them rather than counting a second match."""
    _tree(tmp_path, {
        "src/chartColors.ts": _ramp_src("'#000000', '#111111'"),
        "src/tsconfig.tsbuildinfo": '{"version":"5","files":["chartColors.ts"]}',
        "src/chartColors.ts.map": '{"mappings":"CATEGORY_COLORS"}',
        "src/SpendingDonut.tsx": "import { CATEGORY_COLORS } from './chartColors';\n",
    })
    monkeypatch.setattr(_chart_ramp, "_REPO_ROOT", tmp_path)

    assert _chart_ramp.ramp_source_path() == tmp_path / "src" / "chartColors.ts"


# ------------------------------------------------------------- module-leak regression


def _reimport_names() -> tuple:
    """conftest._REIMPORT, read as source so importing it has no side effects."""
    tree = ast.parse((_TESTS_SHARED_DIR / "conftest.py").read_text())
    for node in ast.walk(tree):
        if isinstance(node, ast.Assign) and any(
            isinstance(t, ast.Name) and t.id == "_REIMPORT" for t in node.targets
        ):
            return tuple(ast.literal_eval(node.value))
    raise AssertionError("no _REIMPORT assignment in tests/shared/conftest.py")


def test_every_shared_module_this_suite_imports_is_shed_between_tests():
    """[A19] The bug the drift guard introduced and the diff fixed by hand. `shared/`
    modules have bare names that collide with lambda_api's own copies; the `shared`
    fixture only sheds the names listed in _REIMPORT, so importing one that is NOT
    listed leaves it in sys.modules and the next suite resolves the wrong module.

    Worth automating because the symptom is invisible where you would look for it: with
    repository_category dropped from _REIMPORT, `pytest tests/shared tests/lambda_api`
    fails 24 lambda_api tests, but a plain full-suite `pytest` — where shared sorts
    AFTER lambda_api — passes all 2329. The leak is real and the default run is blind to
    it, so pin the rule at its source instead of hoping for an unlucky order."""
    shared_modules = {path.stem for path in _SHARED_DIR.glob("*.py")}
    imported = set()
    import_pattern = re.compile(r"^\s*(?:import|from)\s+([A-Za-z_][A-Za-z0-9_]*)", re.MULTILINE)
    for test_file in sorted(_TESTS_SHARED_DIR.glob("*.py")):
        if test_file.name == "conftest.py":
            continue
        imported |= set(import_pattern.findall(test_file.read_text()))

    unshed = sorted((imported & shared_modules) - set(_reimport_names()))
    assert not unshed, (
        f"tests/shared imports shared modules that conftest._REIMPORT does not shed: "
        f"{unshed}. They stay in sys.modules after the `shared` fixture tears down, and "
        "a sibling suite (lambda_api / sync_trigger, which have their own module of the "
        "same name) then imports shared's copy instead of its own. Add them to _REIMPORT."
    )
