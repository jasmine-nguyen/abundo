# Guards on what a build helper may run or write.
#
# The pipeline owns git: no agent commits, pushes or switches branches.
# Planning and review agents are read-only; QA writes only in the worktree the
# pipeline makes for it.
# These checks block the obvious commands. fix_or_ship and prepare_branch also
# check the working tree, which catches any write the checks miss.
#
# Standard library only: the Pi runner's extension (build_guard.ts) runs this file on every
# tool call, so it must start fast. `python3 build_guard.py <policy> <root>` reads the call
# as JSON on stdin and prints why it's blocked, or nothing.

import json
import os
import re
import sys
import tempfile
from pathlib import Path


def _git(subcommands: str) -> str:
    return rf"\bgit\b(?:\s+-C\s+\S+)?\s+(?:{subcommands})\b"


_NEVER = [
    _git("commit|push|pull|reset|rebase|merge|cherry-pick|revert|stash|clean|switch|tag|am"),
    r"\bgit\b[^;&|]*\bbranch\s+-[dDmMcCf]",
    r"\bgh\s+pr\s+(?:create|merge|close|edit|ready|review)\b",
]
BASH_DENY = {
    "read_only": re.compile("|".join([
        *_NEVER,
        _git("add|rm|mv|checkout|restore|apply|worktree"),
        r"(?:^|[;&|(]\s*)(?:rm|mv|cp|touch|mkdir|tee)\s",
        r"\bsed\s+-i",
    ])),
    "writer": re.compile("|".join([*_NEVER, _git("worktree"), _git(r"checkout(?!\s+--\s)")])),
    "qa": re.compile("|".join([*_NEVER, _git("worktree")])),
}

# Claude Code's and Pi's names for the tools that write files.
WRITE_TOOLS = {"write", "edit", "multiedit", "notebookedit"}

# Helpers change only the repo being built (QA: only its worktree) plus scratch space. The
# pipeline can check, commit and undo changes here, but it can't even see another repo's.
TEMP_DIRS = tuple({Path(tempfile.gettempdir()).resolve(), Path("/tmp").resolve()})
SHELL_PATH = re.compile(r"(?<![\w.:/-])(?:~|/)[^\s'\"`;&|()<>]*")
SHELL_CD = re.compile(r"""(?:^|[;&|(]\s*)cd\s+("[^"]*"|'[^']*'|[^\s;&|)]+)""")
SHELL_WRITES = re.compile(
    r">|\b(?:tee|cp|mv|rm|touch|mkdir|ln|install|rsync|patch)\b|\bsed\s+-i|\.write|write_(?:text|bytes)"
    r"|\bopen\([^)]*['\"][wax]"
)
HARMLESS_REDIRECTS = re.compile(r"[0-9]?>&[0-9]|[0-9&]?>>?\s*/dev/(?:null|stdout|stderr)")
WRITES_OUTSIDE = (
    "Blocked: `{path}` is outside the repo you're building, and helpers change only this repo. Reading "
    "it with absolute paths is fine. If the card needs a change elsewhere, don't make it: finish here and "
    "list it under `follow_ups`."
)


def writable_roots(policy: str, root: Path) -> tuple[Path, ...]:
    return (root / ".build", *TEMP_DIRS) if policy == "qa" else (root, *TEMP_DIRS)


def outside(path_text: str, roots: tuple[Path, ...]) -> bool:
    text = path_text.strip("'\"")
    if not text or "$" in text or text.startswith("/dev/"):
        return False
    path = Path(os.path.expanduser(text))
    if not path.is_absolute():
        return False  # relative paths are where the agent works
    return not any(path.resolve().is_relative_to(root) for root in roots)


def shell_writes_outside(command: str, roots: tuple[Path, ...]) -> str | None:
    """A path outside `roots` that the command moves into or may write to, if any."""
    for target in SHELL_CD.findall(command):
        if outside(target, roots):
            return target
    if not SHELL_WRITES.search(HARMLESS_REDIRECTS.sub("", command)):
        return None
    return next((path for path in SHELL_PATH.findall(command) if outside(path, roots)), None)


def blocked(policy: str, tool: str, tool_input: dict, root: Path) -> str | None:
    """Why a `policy` agent may not make this tool call in the repo at `root`, or None."""
    roots = writable_roots(policy, root)
    tool = tool.lower()
    if tool == "bash":
        command = tool_input.get("command", "")
        if BASH_DENY[policy].search(command):
            return f"Blocked for a {policy} agent: `{command[:120]}`. The pipeline owns git."
        path = None if policy == "read_only" else shell_writes_outside(command, roots)
        return WRITES_OUTSIDE.format(path=path) if path else None
    if tool not in WRITE_TOOLS:
        return None
    # Pi passes paths relative to the agent's folder, which is this process's folder.
    path = Path(tool_input.get("file_path") or tool_input.get("path") or tool_input.get("notebook_path") or ".").resolve()
    if policy == "qa" and path.is_relative_to(root) and not path.is_relative_to(root / ".build"):
        return "QA writes only in its own worktree, never in the main checkout."
    if outside(str(path), roots):
        return WRITES_OUTSIDE.format(path=path)
    return None


if __name__ == "__main__":
    call = json.load(sys.stdin)
    print(blocked(sys.argv[1], call["toolName"], call["input"], Path(sys.argv[2])) or "")
