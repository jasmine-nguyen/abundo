#!/usr/bin/env python3
"""Claude Code PreToolUse hook: the chat session may not change /build's saved progress.

Everything under .build/ belongs to build_graph.py (its database, locked-test copies,
plans), except .build/cards/, where the chat writes card details for --details-file.
Changes go through `build_graph.py --resume`, so the build knows about them.

The build's own agents (QA writes its patch under .build/) run with
BUILD_PIPELINE_AGENT=1 in their environment, which a shell command can't set for
this hook, so they're let through.
"""
import json
import os
import re
import sys
from pathlib import Path

REASON = (
    "This is /build's saved progress, which only build_graph.py may change. Don't edit it to unstick "
    "a build: resume it with the user's answer (`build_graph.py --resume`), or tell the user what's stuck."
)
WRITE_TOOLS = {"Edit", "Write", "MultiEdit", "NotebookEdit"}
BUILD_DIR = re.compile(r"(^|[\s'\"=/])\.build/(?!cards/)")
WRITES = re.compile(r">|\btee\b|\brm\b|\bmv\b|\bcp\b|\bsed\s+-i|\bsqlite3\b|\btruncate\b|\bdd\b|\bln\b|\bchmod\b")
SAVED_STATE = re.compile(r"build_graph\.db|update_state\(|AsyncSqliteSaver|SqliteSaver")
PYTHON_SCRIPT = re.compile(r"\bpython[\d.]*\s+(?:-\S+\s+)*([^\s;&|]+\.py)\b")


def touches_saved_state(command: str, cwd: Path) -> bool:
    if SAVED_STATE.search(command):
        return True
    if BUILD_DIR.search(command) and WRITES.search(command):
        return True
    for script in PYTHON_SCRIPT.findall(command):
        path = Path(script) if Path(script).is_absolute() else cwd / script
        if path.name != "build_graph.py" and path.is_file():
            try:
                if SAVED_STATE.search(path.read_text(errors="ignore")):
                    return True
            except OSError:
                pass
    return False


def in_build_dir(file_path: str, cwd: Path) -> bool:
    parts = (Path(file_path) if Path(file_path).is_absolute() else cwd / file_path).parts
    if ".build" not in parts:
        return False
    rest = parts[parts.index(".build") + 1:]
    return not (rest and rest[0] == "cards")


def main() -> int:
    if os.environ.get("BUILD_PIPELINE_AGENT") == "1":
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
