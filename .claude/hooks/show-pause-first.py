#!/usr/bin/env python3
"""Claude Code PreToolUse hook: show the user what /build paused on before asking them about it.

build_graph.py saves the block each build paused on (e.g. PLAN FOR REVIEW) to
.build/<thread>/pause.txt. The first question asked at each pause is refused, with the
block in the reason, so the chat sends it as a message of its own; the next question goes
through. A hook can't see the message the question arrives in, so it can't check the block
is already there.
"""
import hashlib
import json
import os
import sys
from pathlib import Path

REASON = (
    "/build is paused on the block below, and the user hasn't seen it: the question box alone doesn't tell "
    "them what they're deciding. Send it to them now, in a message of its own, formatted as /build's step 3 "
    "says for this pause (section titles in bold, lines as bullets, nothing added or cut). Then ask your "
    "question again. If your question isn't about this pause, just ask it again.\n\n{pause}"
)


def unseen_pause(build: Path) -> str | None:
    """The newest pause not yet shown, marking it shown."""
    pauses = sorted(build.glob("*/pause.txt"), key=lambda path: path.stat().st_mtime, reverse=True)
    for path in pauses:
        try:
            pause = path.read_text()
            marker = path.with_name("pause.shown")
            seen = hashlib.sha256(pause.encode()).hexdigest()
            if marker.is_file() and marker.read_text() == seen:
                continue
            marker.write_text(seen)
        except OSError:
            continue
        return pause
    return None


def build_dirs(event: dict) -> list[Path]:
    """The .build folders from the session's folder up to the project's: the pipeline may live in a subfolder."""
    project = Path(os.environ.get("CLAUDE_PROJECT_DIR") or event.get("cwd") or os.getcwd()).resolve()
    here = Path(event.get("cwd") or project).resolve()
    folders = [here, *here.parents] if here.is_relative_to(project) else [project]
    return [folder / ".build" for folder in folders[: folders.index(project) + 1] if (folder / ".build").is_dir()]


def main() -> int:
    if os.environ.get("BUILD_PIPELINE_AGENT") == "1":
        return 0
    event = json.load(sys.stdin)
    if event.get("tool_name") != "AskUserQuestion":
        return 0
    pause = next(filter(None, map(unseen_pause, build_dirs(event))), None)
    if pause is not None:
        json.dump({"hookSpecificOutput": {
            "hookEventName": "PreToolUse", "permissionDecision": "deny",
            "permissionDecisionReason": REASON.format(pause=pause),
        }}, sys.stdout)
    return 0


if __name__ == "__main__":
    sys.exit(main())
