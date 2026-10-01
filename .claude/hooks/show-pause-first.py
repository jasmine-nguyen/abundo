#!/usr/bin/env python3
"""Claude Code PreToolUse hook: show the user what /build paused on before asking them about it.

build_graph.py saves the block it paused on (e.g. PLAN FOR REVIEW) to .build/pause.txt.
The first question asked at each pause is refused, with the block in the reason, so the
chat sends it as a message of its own; the next question goes through. A hook can't see
the message the question arrives in, so it can't check the block is already there.
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


def main() -> int:
    if os.environ.get("BUILD_PIPELINE_AGENT") == "1":
        return 0
    event = json.load(sys.stdin)
    if event.get("tool_name") != "AskUserQuestion":
        return 0
    build = Path(os.environ.get("CLAUDE_PROJECT_DIR") or event.get("cwd") or os.getcwd()) / ".build"
    try:
        pause = (build / "pause.txt").read_text()
    except OSError:
        return 0
    seen = hashlib.sha256(pause.encode()).hexdigest()
    marker = build / "pause.shown"
    try:
        if marker.read_text() == seen:
            return 0
    except OSError:
        pass
    try:
        marker.write_text(seen)
    except OSError:
        return 0
    json.dump({"hookSpecificOutput": {
        "hookEventName": "PreToolUse", "permissionDecision": "deny",
        "permissionDecisionReason": REASON.format(pause=pause),
    }}, sys.stdout)
    return 0


if __name__ == "__main__":
    sys.exit(main())
