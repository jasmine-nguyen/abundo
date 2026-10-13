"""Readers for a workflow's `on.pull_request.paths` and `on.push.paths-ignore` lists
(WHIT-435 / WHIT-436 / WHIT-634).

Two guard files hand-rolled this parse and DIVERGED: one broke the list on any
non-`"- "` line, the other only on a dedent — two copies meant to be identical that
behaved differently, which is worse than two identical ones. This is the single copy,
adopting the newer end-of-list rule (a list item at the same indent as its `paths:` key
still counts) and rejecting an empty `- ""` entry that both old copies passed for free.

Hand-parsed, not via PyYAML: CI installs only lambda_sync_trigger/requirements-dev.txt
(pytest, pytest-cov, standardwebhooks), so `import yaml` ImportErrors on the runner. The
one rule that matters — a `#` line is not an entry — is encoded directly.

Each reader is scoped to its own event block, NOT the first matching key in the file:
`push:` is declared above `pull_request:`, so reading the wrong block could report an
entry present when that event had dropped it.

Takes TEXT, not a path, so a guard can drive it against fabricated YAML and prove it
still reads the shape it claims to.
"""

import re

# One list entry: a quoted or bare scalar, stopping before any inline `# comment`.
_ENTRY = re.compile(r"-\s*(?:\"([^\"]*)\"|'([^']*)'|([^#\s]+))")


def pull_request_paths(text: str) -> list:
    """The live `on.pull_request.paths` entries declared in a workflow's YAML `text`."""
    return _block_list(text, "pull_request", "paths")


def push_paths_ignore(text: str) -> list:
    """The live `on.push.paths-ignore` entries declared in a workflow's YAML `text`."""
    return _block_list(text, "push", "paths-ignore")


def _block_list(text: str, block: str, key: str) -> list:
    """The `- ` entries under `key:` inside the `block:` section of a workflow's YAML."""
    entries, in_block, indent, block_column = [], False, None, 0
    for raw in text.splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):        # a commented-out entry is NOT an entry
            continue
        column = len(raw) - len(raw.lstrip())
        if not in_block:
            in_block = line == f"{block}:"
            block_column = column
            continue
        if indent is None:
            if column <= block_column:
                break                                # left the block without the key
            if line == f"{key}:":
                indent = column
            continue
        # Newer end-of-list rule: a list item at the SAME indent as its key still counts;
        # only a dedent to a NON-item line ends the list. The old copy broke on any
        # non-`"- "` line, which a same-indent list would trip on for no reason.
        if column <= indent and not line.startswith("-"):
            break
        match = _ENTRY.match(line)
        if match:
            entry = next(group for group in match.groups() if group is not None)
            assert entry, (
                f'an empty path entry (`- ""`) in on.{block}.{key} matches nothing and '
                "is almost certainly a mistake — remove it or give it a real path"
            )
            entries.append(entry)
    assert entries, (
        f"parsed zero entries out of on.{block}.{key} — the reader no longer "
        "understands the workflow's shape, so every assertion built on it is vacuous"
    )
    return entries
