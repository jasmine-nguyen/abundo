"""One shared reader for an array `export const NAME = [...]` in a TypeScript file (WHIT-446).

Several guards keep a client-side list in step with a server value by reading the array
straight out of the TypeScript source as TEXT — there is no JS runtime in the pytest
suite. Two guards hand-rolled the same read (locate the one `export const NAME = [...]`
block, strip comments first, pin exactly one declaration). This is that read, in one
place, so a future parse fix (a reshape, a nested form, a comment inside the array) lands
once instead of twice — the scalar sibling _ts_const already did this for `const N = 5`.

Comments are stripped BEFORE the body is located, on purpose: a `]` inside a comment would
otherwise end the array early and read it short, and a `/* '#e991cc', */` would be counted
as a live entry — the second is the dangerous one, it makes a drift guard agree with a
list the app no longer uses (WHIT-406 found that bug live in the colour ramp).

Unlike _ts_const, exactly-one is FOLDED INTO the body read (`one_array_body`): both array
callers want the body back, and _chart_ramp already paired the two. `array_bodies` (every
match) stays separate for the file-discovery walk that only needs a yes/no.

`allow_type_annotation` is off by default so the read reproduces _chart_ramp's original
regex byte-for-byte: CATEGORY_COLORS has no annotation, and an annotated form MUST fail
loudly (WHIT-406 [A7]). MILESTONES requires its `: Milestone[]` annotation, so its caller
opts in. That one difference is load-bearing — do not collapse it.

The functions take TEXT, not a path, so a meta-guard can drive them against fabricated
source and prove they still report drift — same convention as tests/shared/_chart_ramp.py.

Lives in tests/shared because pytest.ini's `pythonpath` makes only that directory
importable by name. Test-only: never staged into the deployed shared layer.
"""

import re

# Both comment forms, stripped BEFORE the array body is located (see module docstring).
_COMMENT = re.compile(r"//[^\n]*|/\*.*?\*/", re.DOTALL)


def _pattern(name: str, allow_type_annotation: bool) -> re.Pattern:
    """The `export const <name> = [...]` matcher.

    Anchored at the start of a line so a bare mention of the name in a comment cannot
    match. `name` is escaped so an unusual identifier can't inject regex. With
    `allow_type_annotation`, an optional `: <type>` between the name and `=` is allowed
    (MILESTONES needs it); without it the annotated form is refused, which the colour-ramp
    guard relies on to fail loudly on a `: readonly string[]` reshape.
    """
    head = re.escape(name) + (r"\s*(?::[^=]*)?" if allow_type_annotation else r"\s*")
    return re.compile(rf"^export const {head}=\s*\[(.*?)\]", re.MULTILINE | re.DOTALL)


def array_bodies(text: str, name: str, *, allow_type_annotation: bool = False) -> list:
    """The bracketed body of every `export const <name> = [...]` in `text`.

    Comments are stripped first, so a commented-out entry or a `]` inside a comment can
    neither pad nor truncate the body. Takes every match; call `one_array_body` to also
    pin that exactly one declaration exists.
    """
    return _pattern(name, allow_type_annotation).findall(_COMMENT.sub("", text))


def one_array_body(text: str, name: str, *, allow_type_annotation: bool = False) -> str:
    """The single declaration's body, or a failure naming what to fix.

    Exactly one, not the first match: a shadowing second declaration (a commented-out old
    list left above the live one) would otherwise be parsed instead, and could hide a real
    drift by happening to agree with the server.
    """
    bodies = array_bodies(text, name, allow_type_annotation=allow_type_annotation)
    assert len(bodies) == 1, (
        f"expected exactly one `export const {name} = [...]` declaration, "
        f"found {len(bodies)} — if the declaration was renamed or reshaped, update the "
        "parser in tests/shared/_ts_array.py; if there are two, delete the dead one."
    )
    return bodies[0]
