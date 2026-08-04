"""One shared reader for a scalar `const NAME = <number>` in a TypeScript file (WHIT-420).

Several guards keep a client-side `const` in step with a server value by reading the
number straight out of the TypeScript source as TEXT — there is no JS runtime in the
pytest suite. Each guard hand-rolled the same read (a `const NAME = <number>` regex,
underscores stripped, plus an "exactly one declaration" pin). This is that read, in one
place, so a future parser fix (an `as const` suffix, a hex or exponent literal, a
declaration left commented out above the live one) lands once instead of three times.

The functions take TEXT, not a path, so a meta-guard can drive them against fabricated
source and prove they still report drift — same convention as tests/shared/_chart_ramp.py.

Behaviour is deliberately identical to the copies it replaces: `number_const` takes the
FIRST match (like the guards' original `.search`), and `assert_one_number_const` owns the
"exactly one" pin separately. A caller that wants both keeps calling both, as before.

Lives in tests/shared because pytest.ini's `pythonpath` makes only that directory
importable by name. Test-only: never staged into the deployed shared layer.
"""

import re


def _pattern(name: str) -> re.Pattern:
    """The `const <name> = <number>` matcher.

    Anchored on `const` so a bare mention of the name in a comment can't match. `name`
    is escaped so an unusual identifier can't inject regex, and the required `=` after
    it means a longer name that merely starts with `name` (LOANFACTS_FIELD_MAXX) is not
    matched.
    """
    return re.compile(rf"const\s+{re.escape(name)}\s*=\s*([\d_]+)")


def number_const(text: str, name: str) -> int:
    """The `const <name> = <number>` in `text`, as an int (underscores stripped).

    Takes the FIRST match, like the guards' original `.search`. Pair it with
    `assert_one_number_const` to also pin that exactly one declaration exists."""
    match = _pattern(name).search(text)
    assert match, (
        f"could not locate `const {name} = <number>` — if it was renamed or reshaped "
        "(a hex/exponent literal, an `as const`), update the parser in "
        "tests/shared/_ts_const.py rather than letting the sync guard pass on nothing"
    )
    return int(match.group(1).replace("_", ""))


def assert_one_number_const(text: str, name: str) -> None:
    """Pin exactly one `const <name> = <number>` declaration in `text`.

    `number_const` takes the FIRST match, so a shadowing second declaration (a
    commented-out old value left above the live one) would be read instead — and could
    hide a real drift by happening to equal the server. This makes that case fail loudly.
    """
    matches = _pattern(name).findall(text)
    assert len(matches) == 1, (
        f"expected exactly one `const {name} = <number>` declaration, found "
        f"{len(matches)}: {matches} — a shadowing/commented copy makes the sync guard "
        "compare the wrong (first-matched) value"
    )
