"""One reader for a workflow's `on.pull_request.paths` list (WHIT-435 / WHIT-436).

Two guard files hand-rolled this parse and DIVERGED: one broke the list on any
non-`"- "` line, the other only on a dedent — two copies meant to be identical that
behaved differently, which is worse than two identical ones. This is the single copy,
adopting the newer end-of-list rule (a list item at the same indent as its `paths:` key
still counts) and rejecting an empty `- ""` entry that both old copies passed for free.

Hand-parsed, not via PyYAML: CI installs only lambda_sync_trigger/requirements-dev.txt
(pytest, pytest-cov, standardwebhooks), so `import yaml` ImportErrors on the runner. The
one rule that matters — a `#` line is not an entry — is encoded directly.

Scoped to the `pull_request:` block, NOT the first `paths:` in the file: `push:` is
declared above it and may grow its own paths filter; reading the wrong list could report
an entry present when pull_request had dropped it.

Takes TEXT, not a path, so a guard can drive it against fabricated YAML and prove it
still reads the shape it claims to.
"""

import re

# One list entry: a quoted or bare scalar, stopping before any inline `# comment`.
_ENTRY = re.compile(r"-\s*(?:\"([^\"]*)\"|'([^']*)'|([^#\s]+))")


def pull_request_paths(text: str) -> list:
    """The live `on.pull_request.paths` entries declared in a workflow's YAML `text`."""
    paths, in_pull_request, indent, pull_request_column = [], False, None, 0
    for raw in text.splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):        # a commented-out entry is NOT an entry
            continue
        column = len(raw) - len(raw.lstrip())
        if not in_pull_request:
            in_pull_request = line == "pull_request:"
            pull_request_column = column
            continue
        if indent is None:
            if column <= pull_request_column:
                break                                # left the block without a paths:
            if line == "paths:":
                indent = column
            continue
        # Newer end-of-list rule: a list item at the SAME indent as its `paths:` key still
        # counts; only a dedent to a NON-item line ends the list. The old copy broke on any
        # non-`"- "` line, which a same-indent list would trip on for no reason.
        if column <= indent and not line.startswith("-"):
            break
        match = _ENTRY.match(line)
        if match:
            entry = next(group for group in match.groups() if group is not None)
            assert entry, (
                'an empty path entry (`- ""`) in on.pull_request.paths matches nothing and '
                "is almost certainly a mistake — remove it or give it a real path"
            )
            paths.append(entry)
    assert paths, (
        "parsed zero entries out of on.pull_request.paths — the reader no longer "
        "understands the workflow's shape, so every assertion built on it is vacuous"
    )
    return paths
