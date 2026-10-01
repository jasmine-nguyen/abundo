#!/usr/bin/env python3
"""Claude Code PreToolUse hook: the chat session may not change /build's saved progress.

Everything under .build/ belongs to build_graph.py (its database, locked-test copies,
plans), except .build/cards/, where the chat writes card details for --details-file.
Changes go through `build_graph.py --resume`, so the build knows about them.

Let through, by a variable set when the session starts (a shell command can't set
it for this hook):
- the build's own agents (QA writes its patch under .build/): BUILD_PIPELINE_AGENT=1
- a repair session the user opened on purpose with `ticket repair <card>`: ALLOW_BUILD_REPAIR=1
"""
import json
import os
import re
import sys
from pathlib import Path

REASON = (
    "This is /build's saved progress, which only build_graph.py may change. Don't edit it to unstick "
    "a build: resume it with the user's answer (`build_graph.py --resume`), or use --retry, --recheck or "
    "--replan. If none of those fixes it, tell the user what's stuck and that `ticket repair <card>` opens a "
    "session allowed to change these files."
)
WRITE_TOOLS = {"Edit", "Write", "MultiEdit", "NotebookEdit"}
BUILD_DIR = re.compile(r"(^|[\s'\"=/>(])\.build(/cards/\.\.|/(?!cards(?:/|\b))|(?=[\s'\";&|)]|$))")
WRITES = re.compile(
    r">|\b(?:tee|rm|mv|cp|sqlite3|truncate|dd|ln|chmod|touch|mkdir|unlink|install|rsync|patch)\b|\bsed\s+-i"
    r"|\bperl\s+-\S*i|-delete\b|\.write|write_(?:text|bytes)|\bopen\([^)]*['\"][wax]"
)
HARMLESS_REDIRECTS = re.compile(r"[0-9]?>&[0-9]|[0-9&]?>>?\s*/dev/(?:null|stdout|stderr)")
SAVED_STATE = re.compile(r"build_graph\.db|update_state\(|AsyncSqliteSaver|SqliteSaver")
RUNS_CODE = re.compile(r"\bpython[\d.]*\b|\bsqlite3\b|\buv\s+run\b")
# Running code a script holds: python/uv/a shell, or a path like ./x.py.
RUNS_SCRIPT = re.compile(r"\bpython[\d.]*\b|\buv\s+run\b|\b(?:ba|z)?sh\b|(?:^|[\s;&|(])\.{0,2}/\S")
WORD = re.compile(r"[^\s;&|()'\"`<>]+")
# The pipeline itself, in the project this hook belongs to; a file elsewhere with its name isn't trusted.
PIPELINE = {
    (Path(folder) / "build_graph.py").resolve()
    for folder in (Path(__file__).resolve().parents[2], os.environ.get("CLAUDE_PROJECT_DIR"))
    if folder
}


def touches_saved_state(command: str, cwd: Path) -> bool:
    command = HARMLESS_REDIRECTS.sub(" ", command)
    if SAVED_STATE.search(command) and RUNS_CODE.search(command):
        return True
    if BUILD_DIR.search(command) and WRITES.search(command):
        return True
    return bool(RUNS_SCRIPT.search(command)) and any(
        SAVED_STATE.search(read(path)) for path in scripts(command, cwd) if path not in PIPELINE
    )


def scripts(command: str, cwd: Path) -> set[Path]:
    """Files the command may run: every word that names a file, and every `-m module`."""
    words = WORD.findall(command)
    found = set()
    for before, word in zip(["", *words], words):
        name = word.replace(".", "/") + ".py" if before == "-m" else word
        path = Path(name) if Path(name).is_absolute() else cwd / name
        if path.is_file():
            found.add(path.resolve())
    return found


def read(path: Path) -> str:
    try:
        return path.read_text(errors="ignore")
    except OSError:
        return ""


def in_build_dir(file_path: str, cwd: Path) -> bool:
    parts = Path(os.path.normpath(Path(file_path) if Path(file_path).is_absolute() else cwd / file_path)).parts
    if ".build" not in parts:
        return False
    rest = parts[parts.index(".build") + 1:]
    return not (rest and rest[0] == "cards")


def main() -> int:
    if "1" in (os.environ.get("BUILD_PIPELINE_AGENT"), os.environ.get("ALLOW_BUILD_REPAIR")):
        return 0
    event = json.load(sys.stdin)
    tool, given = event.get("tool_name", ""), event.get("tool_input") or {}
    cwd = Path(event.get("cwd") or os.getcwd())
    if tool in WRITE_TOOLS:
        blocked = in_build_dir(given.get("file_path") or given.get("notebook_path") or "", cwd)
    elif tool == "Bash":
        blocked = touches_saved_state(given.get("command", ""), cwd)
    else:
        blocked = False
    if blocked:
        json.dump({"hookSpecificOutput": {
            "hookEventName": "PreToolUse", "permissionDecision": "deny", "permissionDecisionReason": REASON,
        }}, sys.stdout)
    return 0


if __name__ == "__main__":
    sys.exit(main())
