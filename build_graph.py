# Build one backlog card end to end: plan → sign-off → tests → code → checks → review → PR.
#
# START → designer ─┬→ clarify (pause) → designer              card too thin to plan
#                   ├→ sign_off                                 card looks invalid
#                   └→ plan_critic ─┬→ designer                 NEEDS REWORK, tries left
#                                   └→ sign_off (pause)
# sign_off ─┬→ designer                                         sent back
#           ├→ END                                              card closed as invalid
#           └→ prepare_branch ─┬→ reproducer                    bug cards
#                              └→ test_writer
# reproducer / test_writer ─→ escalation (pause)                no valid failing test
# implementer ─┬→ escalation (pause) → implementer
#              └→ checks ─┬→ implementer                        typecheck/lint/tests/pinned tests failed
#                         └→ code_critic ∥ qa → fix_or_ship
# fix_or_ship ─┬→ implementer                                   findings, rounds left
#              ├→ next_slice → test_writer                      more slices to build
#              └→ ship → END                                    both reviews passed
#                 (END instead, with BUILD FAILED, when rounds run out)
# next_slice / ship ─→ implementer                               QA's new tests fail the checks, rounds left
import argparse
import asyncio
import contextlib
import hashlib
import inspect
import json
import operator
import os
import re
import shutil
import signal
import subprocess
import sys
import tempfile
import time
import traceback
import uuid
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Annotated, NotRequired, TypedDict

import jsonschema
from claude_agent_sdk import (
    ClaudeAgentOptions,
    CLIConnectionError,
    HookMatcher,
    ProcessError,
    ResultError,
    ResultMessage,
    query,
)
from langgraph.checkpoint.sqlite.aio import AsyncSqliteSaver
from langgraph.errors import GraphInterrupt
from langgraph.graph import END, START, StateGraph
from langgraph.types import Command, RetryPolicy, interrupt


def merge_unique(old: list, new: list | None) -> list:
    """Keep notes from every slice and round, without repeats. None empties the list (a replan)."""
    if new is None:
        return []
    return old + [item for item in new if item not in old]


class BuildState(TypedDict):
    thread_id: str
    card_number: str
    card_details: str
    card_type: NotRequired[str]
    untracked_at_start: NotRequired[list[str]]
    requested_branch: NotRequired[str]
    always_sign_off: NotRequired[bool]
    history: Annotated[list[str], operator.add]
    # planning
    validity: NotRequired[str]
    validity_evidence: NotRequired[str]
    clarify_questions: NotRequired[list[dict]]
    clarify_answers: NotRequired[str]
    clarify_rounds: NotRequired[int]
    designer_session: NotRequired[str]
    critic_session: NotRequired[str]
    plan: NotRequired[str]
    problem: NotRequired[list[str]]
    task: NotRequired[list[str]]
    solution: NotRequired[list[str]]
    files: NotRequired[list[str]]
    risks: NotRequired[list[str]]
    door: NotRequired[str]
    complexity: NotRequired[str]
    complexity_reason: NotRequired[str]
    blast_radius: NotRequired[str]
    seams: NotRequired[list[str]]
    decisions: NotRequired[list[dict]]
    sign_off_answers: NotRequired[str]
    slices: NotRequired[list[dict]]
    plan_verdict: NotRequired[str]
    plan_findings: NotRequired[list[str]]
    plan_tweaks: NotRequired[list[str]]
    plan_attempts: NotRequired[int]
    plan_decision: NotRequired[str]
    plan_feedback: NotRequired[str]
    # branch and slices
    base_branch: NotRequired[str]
    branch: NotRequired[str]
    build_base: NotRequired[str]
    slice_base: NotRequired[str]
    current_slice: NotRequired[int]
    # tests
    repro: NotRequired[str]
    repro_command: NotRequired[str]
    tests: NotRequired[str]
    test_attempts: NotRequired[int]
    test_feedback: NotRequired[str]
    test_rejection: NotRequired[str]
    pinned: NotRequired[dict[str, str]]
    unpinned: NotRequired[dict[str, str]]
    user_decisions: NotRequired[list[str]]
    # implementation
    implementer_session: NotRequired[str]
    implementer_resumes: NotRequired[int]
    implementation_attempts: NotRequired[int]
    implementation: NotRequired[str]
    checks_feedback: NotRequired[str]
    escalation: NotRequired[str]
    escalation_source: NotRequired[str]
    escalation_next: NotRequired[str]
    escalation_answer: NotRequired[str]
    pause_id: NotRequired[str]
    pause_options: NotRequired[list[dict]]
    pause_recommended: NotRequired[str]
    # review
    code_verdict: NotRequired[str]
    code_feedback: NotRequired[str]
    code_decisions: NotRequired[list[str]]
    advisory: Annotated[list[str], merge_unique]
    tech_debt: Annotated[list[dict], merge_unique]
    qa_verdict: NotRequired[str]
    qa_feedback: NotRequired[str]
    qa_patch: NotRequired[str]
    qa_test_command: NotRequired[str]
    manual_checks: Annotated[list[str], merge_unique]
    follow_ups: Annotated[list[str], merge_unique]
    last_review: NotRequired[dict[str, str]]
    # wrap-up
    failed: NotRequired[bool]
    outcome: NotRequired[str]
    pr_url: NotRequired[str]
    pr_error: NotRequired[str]
    pr_title: NotRequired[str]
    pr_compare_url: NotRequired[str]
    replaced_push: NotRequired[str]


# --- settings ---

ROOT = Path(__file__).resolve().parent
BUILD_DIR = ROOT / ".build"
DB_PATH = BUILD_DIR / "build_graph.db"
AGENTS_FILE = ROOT / "AGENTS.md"

DEFAULT_MODEL = "claude-opus-5-5"
# How hard each agent thinks. Claude Code's own default is higher; "medium" is faster
# and uses less of the plan.
AGENT_EFFORT = "medium"
MAX_CLARIFY_ROUNDS = 2
MAX_PLAN_ATTEMPTS = 2
MAX_TEST_ATTEMPTS = 2
MAX_IMPLEMENTATION_ROUNDS = 5
MAX_SESSION_RESUMES = 2
CHECK_TIMEOUT_S = 900

APPROVALS = {"go", "approve", "approved", "yes", "y", "lgtm", "ok"}
# Only a bare stop word, or one followed by ":" and a reason, ends the build: "Cancel button should be
# red" is an answer.
STOP_REPLY = re.compile(r"\s*(?:stop|cancel|abort)\s*(?:[:.!].*)?", re.I | re.S)
BUG_TYPES = {"bug", "defect"}
TYPE_TO_PREFIX = {
    "story": "feat", "feature": "feat",
    "bug": "fix", "defect": "fix",
    "chore": "chore",
    "refactor": "refactor",
    "docs": "docs", "test": "chore",
    "tech debt": "chore",
}

REVIEWERS = ["code_critic", "qa"]
REVIEW_LABELS = {
    "code": "Code review",
    "qa": "QA"
}

NODE_LABELS = {
    "designer": "Designer",
    "clarify": "Clarify",
    "plan_critic": "Plan Critic",
    "sign_off": "Sign-off",
    "prepare_branch": "Branch",
    "reproducer": "Reproducer",
    "test_writer": "Test Writer",
    "implementer": "Implementer",
    "escalation": "Escalation",
    "checks": "Checks",
    "code_critic": "Code Review",
    "qa": "QA",
    "fix_or_ship": "Fix or Ship",
    "next_slice": "Next Slice",
    "ship": "Ship",
}


@dataclass(frozen=True)
class Agent:
    prompt_file: str
    tools: tuple[str, ...]
    policy: str  # which guard applies: read_only, writer or qa
    max_turns: int
    max_budget_usd: float


READ = ("Read", "Grep", "Glob", "Bash")
WRITE = ("Read", "Grep", "Glob", "Edit", "Write", "Bash")

# Turn and usage caps stop a stuck agent. Usage is measured at API prices, even on a
# subscription. Raise the caps if big cards hit them.
AGENTS = {
    "designer": Agent("solution-designer.md", READ, "read_only", 80, 10.0),
    "plan_critic": Agent("solution-critic.md", READ, "read_only", 60, 6.0),
    "reproducer": Agent("reproducer.md", WRITE, "writer", 120, 12.0),
    "test_writer": Agent("test-writer.md", WRITE, "writer", 80, 8.0),
    "implementer": Agent("implementer.md", WRITE, "writer", 200, 25.0),
    "code_critic": Agent("code-critic.md", READ, "read_only", 80, 8.0),
    "qa": Agent("qa.md", WRITE, "qa", 150, 15.0),
}


# --- structured outputs ---
#
# Every agent answers in JSON checked against a schema, so a verdict is read,
# never guessed from keywords. No valid answer means the step stops.

TEXT = {"type": "string"}
TEXTS = {"type": "array", "items": TEXT}


def _object(**properties) -> dict:
    return {
        "type": "object",
        "properties": properties,
        "required": list(properties),
        "additionalProperties": False,
    }


def _one_of(*values: str) -> dict:
    return {"type": "string", "enum": list(values)}


def _list_of(**properties) -> dict:
    return {"type": "array", "items": _object(**properties)}


def _output(**properties) -> dict:
    return {"type": "json_schema", "schema": _object(**properties)}


VALIDITY_WORDS = {
    "ALREADY DONE": "it looks already done",
    "DEAD CODE": "the part of the app it's about isn't used anywhere",
    "WRONG PREMISE": "what it describes isn't how the app works today",
    "ALREADY COVERED": "the existing tests already cover it",
    "WRONG REPO": "the change belongs in another repo, which this build can't change",
}
DESIGNER_OUTPUT = _output(
    validity=_one_of("VALID", "ALREADY DONE", "DEAD CODE", "WRONG PREMISE", "ALREADY COVERED", "WRONG REPO"),
    validity_evidence=TEXT,
    clarifying_questions=_list_of(question=TEXT, recommendation=TEXT),
    problem=TEXTS,
    task=TEXTS,
    solution=TEXTS,
    files=TEXTS,
    risks=TEXTS,
    door=_one_of("one-way", "two-way"),
    complexity=_one_of("routine", "significant"),
    complexity_reason=TEXT,
    blast_radius=TEXT,
    seams=TEXTS,
    decisions=_list_of(question=TEXT, options=TEXT, recommendation=TEXT),
    slices=_list_of(title=TEXT, delivers=TEXT),
    plan=TEXT,
)
CRITIC_OUTPUT = _output(
    verdict=_one_of("SOLID", "SOLID WITH TWEAKS", "NEEDS REWORK"),
    top_findings=TEXTS,
    tweaks=TEXTS,
    complexity=_one_of("routine", "significant"),
    complexity_reason=TEXT,
    review=TEXT,
)
REPRODUCER_OUTPUT = _output(
    status=_one_of("REPRODUCED", "CANNOT_REPRODUCE"),
    command=TEXT,
    test_files=TEXTS,
    symptom=TEXT,
    tried=TEXT,
    summary=TEXT,
)
TEST_WRITER_OUTPUT = _output(seams=TEXTS, test_files=TEXTS, command=TEXT, summary=TEXT)
IMPLEMENTER_OUTPUT = _output(
    status=_one_of("DONE", "ESCALATE"),
    summary=TEXT,
    escalation=TEXT,
    options=_list_of(id=TEXT, label=TEXT, what_happens=TEXT, cost=TEXT, unpin_files=TEXTS),
    recommended=TEXT,
    follow_ups=TEXTS,
)
CODE_CRITIC_OUTPUT = _output(
    blocking_bugs=TEXTS,
    standards_breaches=TEXTS,
    decisions_to_escalate=TEXTS,
    advisory=TEXTS,
    tech_debt=_list_of(title=TEXT, problem=TEXT, fix=TEXT),
)
QA_OUTPUT = _output(
    spec_gaps=TEXTS, real_bugs=TEXTS, manual_checks=TEXTS, patch_written={"type": "boolean"}, test_command=TEXT,
)



# --- guards ---
#
# The pipeline owns git: no agent commits, pushes or switches branches.
# Planning and review agents are read-only; QA writes only in the worktree the
# pipeline makes for it.
# These hooks block the obvious commands. fix_or_ship and prepare_branch also
# check the working tree, which catches any write the hooks miss.


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


def _deny(reason: str) -> dict:
    return {
        "hookSpecificOutput": {
            "hookEventName": "PreToolUse",
            "permissionDecision": "deny",
            "permissionDecisionReason": reason,
        }
    }


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


def writable_roots(policy: str) -> tuple[Path, ...]:
    return (BUILD_DIR, *TEMP_DIRS) if policy == "qa" else (ROOT, *TEMP_DIRS)


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


def guard_hooks(policy: str) -> dict[str, list[HookMatcher]]:
    denied = BASH_DENY[policy]
    roots = writable_roots(policy)

    async def guard_bash(hook_input, _tool_use_id, _context):
        command = hook_input["tool_input"].get("command", "")
        if denied.search(command):
            return _deny(f"Blocked for a {policy} agent: `{command[:120]}`. The pipeline owns git.")
        if policy != "read_only":
            path = shell_writes_outside(command, roots)
            if path:
                return _deny(WRITES_OUTSIDE.format(path=path))
        return {}

    matchers = [HookMatcher(matcher="Bash", hooks=[guard_bash])]
    if policy != "read_only":

        async def guard_writes(hook_input, _tool_use_id, _context):
            tool_input = hook_input["tool_input"]
            path = Path(tool_input.get("file_path") or tool_input.get("notebook_path") or ".").resolve()
            if policy == "qa" and path.is_relative_to(ROOT) and not path.is_relative_to(BUILD_DIR):
                return _deny("QA writes only in its own worktree, never in the main checkout.")
            if outside(str(path), roots):
                return _deny(WRITES_OUTSIDE.format(path=path))
            return {}

        matchers.append(HookMatcher(matcher="Write|Edit|MultiEdit|NotebookEdit", hooks=[guard_writes]))
    return {"PreToolUse": matchers}


# --- agents ---


class AgentError(Exception):
    def __init__(self, agent: str, detail: str, transient: bool = False):
        super().__init__(f"{NODE_LABELS.get(agent, agent)} failed: {detail}")
        self.transient = transient


@dataclass
class AgentResult:
    output: dict
    session_id: str


TRANSIENT_STATUSES = {408, 429, 500, 502, 503, 504, 529}


def _transient(terminal_reason: str | None, status: int | None) -> bool:
    return terminal_reason == "api_error" or status in TRANSIENT_STATUSES


# Retry an agent step once on API hiccups; anything else stops the build.
AGENT_RETRY = RetryPolicy(max_attempts=2, retry_on=lambda e: getattr(e, "transient", False))


def agent_prompt(prompt_file: str) -> str:
    return (ROOT / ".claude" / "agents" / prompt_file).read_text()


async def run_agent(
    name: str, prompt: str, output_format: dict, resume: str | None = None, cwd: Path = ROOT
) -> AgentResult:
    agent = AGENTS[name]
    options = ClaudeAgentOptions(
        model=DEFAULT_MODEL,
        system_prompt=agent_prompt(agent.prompt_file),
        tools=list(agent.tools),
        allowed_tools=list(agent.tools),
        hooks=guard_hooks(agent.policy),
        output_format=output_format,
        max_turns=agent.max_turns,
        max_budget_usd=agent.max_budget_usd,
        effort=AGENT_EFFORT,
        # Nobody is there to answer a permission prompt, so never ask: the tools above run and
        # anything else is refused. Set here rather than inherited, so a build behaves the same
        # on a laptop and in a cloud session, whatever mode that session is in.
        permission_mode="dontAsk",
        # A `cd` doesn't carry over to the agent's next Bash call, so an agent that works
        # somewhere else (QA's worktree) has to start there.
        cwd=str(cwd),
        resume=resume,
        # The repo's own CLAUDE.md and settings, but not the user's global plugins,
        # MCP servers, hooks and preferences, which bloat every turn and hand
        # read-only agents write tools (e.g. a Notion MCP).
        setting_sources=["project"],
        strict_mcp_config=True,
        # The project's hook that keeps the chat session out of .build/ lets the build's own agents through.
        env={"BUILD_PIPELINE_AGENT": "1"},
    )
    result = None
    try:
        async for message in query(prompt=prompt, options=options):
            if isinstance(message, ResultMessage):
                result = message
    except ResultError as e:
        detail = f"{e.subtype}: {e.result or e.errors}"
        raise AgentError(name, detail, _transient(e.terminal_reason, e.api_error_status)) from e
    except (CLIConnectionError, ProcessError) as e:
        raise AgentError(name, str(e), transient=True) from e
    if result is None:
        raise AgentError(name, "ended without a result", transient=True)
    if result.is_error:
        detail = f"{result.subtype}: {result.result}"
        raise AgentError(name, detail, _transient(result.terminal_reason, result.api_error_status))
    if not isinstance(result.structured_output, dict):
        raise AgentError(name, "returned no structured answer")
    return AgentResult(result.structured_output, result.session_id)


async def continue_agent(name: str, session: str, news: str, fresh_prompt: str, output_format: dict) -> tuple[AgentResult, bool]:
    """Send just the news to the agent's earlier session, so it keeps everything it already
    read instead of researching again. Starts a fresh session when there's none to continue,
    or it can't be continued. Returns the result and whether the session was continued."""
    if session and news:
        try:
            return await run_agent(name, news, output_format, resume=session), True
        except AgentError as e:
            if e.transient:
                raise
            print(f"   ↺ Couldn't continue the {NODE_LABELS[name]}'s session, starting a fresh one", flush=True)
    return await run_agent(name, fresh_prompt, output_format), False


# --- helpers ---


class BuildError(Exception):
    """Something the user has to sort out before running --retry."""


# A cloud session's chat ID. Helpers inherit the environment, so with these set every
# helper's saved conversation is the chat itself, and continuing one reopens the chat.
PARENT_SESSION_VARS = ("CLAUDE_CODE_SESSION_ID", "CLAUDE_CODE_REMOTE_SESSION_ID")

# Either of these makes the agents bill per token instead of using the Claude plan.
PAID_AUTH_VARS = ("ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN")


def paid_auth_var() -> str | None:
    return next((name for name in PAID_AUTH_VARS if os.environ.get(name)), None)


# --- progress ---
#
# Every step prints one line when it starts (⌛) and one when it ends: ✅ done,
# ❌ sent back, ❓ or ⏸ waiting for you, ⏹ stopped. announce() wraps each step,
# so all the wording lives here instead of inside the steps.


def plural(count: int, word: str) -> str:
    return f"{count} {word}{'' if count == 1 else 's'}"


def finding_count(feedback: str) -> int:
    return sum(1 for line in (feedback or "").splitlines() if line.startswith("- "))


def running_message(name: str, state: BuildState) -> str | None:
    if fix_feedback(state):
        verb = "fixing"
    elif state.get("escalation_answer"):
        verb = "continuing"
    else:
        verb = "writing"
    round_number = state.get("implementation_attempts", 0) + 1
    messages = {
        "designer": "Designer is planning the change",
        "plan_critic": "Critic is checking the plan",
        "reproducer": "Reproducing the bug with a failing test",
        "test_writer": "Writing the tests that define done",
        "implementer": f"Implementer is {verb} the code (round {round_number})",
        "checks": "Running typecheck and tests",
        "code_critic": "Code review: hunting for bugs and checking your standards",
        "qa": None if qa_passed_last_round(state) else "QA: checking it does what the card asked, then testing the edge cases",
        "ship": "Opening the PR (after running QA's new tests and the typecheck, if it added any)",
    }
    return messages.get(name)


def paused_message(name: str, state: BuildState) -> str:
    if name == "sign_off" and state.get("validity", "VALID") != "VALID":
        return "Waiting for you: the designer thinks the card isn't needed"
    return {
        "sign_off": "Waiting for you to review the plan",
        "clarify": "Waiting for your answers to the designer's questions",
        "escalation": "Waiting for your decision",
    }.get(name, "Waiting for you")


def finished_message(name: str, state: BuildState, update: dict) -> str | None:
    if update.get("outcome") == "stopped":
        return "⏹ You stopped the build"
    if name in REVIEWERS:
        key = name.removesuffix("_critic")
        label = REVIEW_LABELS[key]
        if name == "qa" and qa_passed_last_round(state):
            return "✅ QA passed last round, not re-run (its tests ran in the checks)"
        if update[f"{key}_verdict"] == "APPROVED":
            return f"✅ {label} passed"
        return f"❌ {label}: {plural(finding_count(review_findings(update, key)), 'thing')} to fix"
    if name == "designer":
        if update["clarify_questions"]:
            return f"❓ Designer has {plural(len(update['clarify_questions']), 'question')} before planning"
        if update["validity"] != "VALID":
            return f"❌ Designer thinks the card isn't needed: {VALIDITY_WORDS.get(update['validity'], update['validity'])}"
        details = [
            plural(len(update[key]), word) for key, word in (("decisions", "decision"), ("slices", "slice")) if update[key]
        ]
        return "✅ Plan drafted" + (f" ({', '.join(details)})" if details else "")
    if name == "plan_critic":
        if update["plan_verdict"] != "NEEDS REWORK":
            tweaks = len(update["plan_tweaks"])
            return "✅ Critic approved the plan" + (f" with {plural(tweaks, 'tweak')}" if tweaks else "")
        if state.get("plan_attempts", 0) < MAX_PLAN_ATTEMPTS:
            return "❌ Critic sent the plan back to the designer"
        return "❌ Critic still has concerns; you'll decide at sign-off"
    if name == "fix_or_ship":
        unhappy = [label for key, label in REVIEW_LABELS.items() if state.get(f"{key}_verdict") == "NEEDS_REWORK"]
        if update["failed"]:
            return f"❌ Out of rounds, still unresolved: {', '.join(unhappy)}"
        if unhappy:
            return f"↩️ Sending the findings from {', '.join(unhappy)} back to the implementer"
        return "✅ Both reviews passed"
    if name == "checks":
        if not update["checks_feedback"]:
            return "✅ Typecheck and tests pass, changes committed"
        if update["failed"]:
            return f"❌ Checks still failing after {plural(MAX_IMPLEMENTATION_ROUNDS, 'round')}"
        return "❌ Checks failed, back to the implementer"
    if name == "ship":
        if update.get("outcome") == "shipped":
            return f"✅ PR opened: {update['pr_url']}"
        if update.get("outcome") == "pushed":
            return "✅ Branch pushed. The PR needs opening: there's no GitHub tool here"
        if update.get("checks_feedback"):
            return "❌ Final checks failed, nothing pushed" + ("" if update["failed"] else ", back to the implementer")
        return "❌ Couldn't push or open the PR"
    if name == "next_slice" and update.get("checks_feedback"):
        return "❌ QA's new tests fail the checks" + ("" if update["failed"] else ", back to the implementer")
    if name == "implementer":
        if update.get("escalation"):
            return "❓ Implementer needs a decision from you"
        return f"✅ Code written (round {update['implementation_attempts']})"
    if name == "test_writer":
        if update.get("escalation"):
            return "❌ Couldn't write tests that fail before the code exists"
        if update.get("test_feedback"):
            return f"❌ The new tests were rejected: {update['test_rejection']}. Rewriting them"
        if "pinned" in update:
            return "✅ Failing tests written and locked"
        return "✅ No new tests needed at this level"
    if name == "reproducer":
        if update.get("repro"):
            return "✅ Bug reproduced with a failing test"
        if update.get("test_rejection"):
            retry = "" if update.get("escalation") else ". Rewriting it"
            return f"❌ The bug test was rejected: {update['test_rejection']}{retry}"
        return "❌ Couldn't reproduce the bug"
    if name == "sign_off" and update.get("plan_decision") == "AUTO_APPROVED":
        return auto_approved_brief(state)
    if name == "next_slice":
        index, slices = update["current_slice"], state["slices"]
        return f"✅ Slice {index} done, starting slice {index + 1} of {len(slices)}: {slices[index]['title']}"
    return {
        "sign_off": {
            "APPROVED": "✅ You approved the plan",
            "REJECTED": "↩️ You sent the plan back to the designer",
            "CLOSED": "✅ Card closed as not needed",
        }.get(update.get("plan_decision")),
        "clarify": "✅ Got your answers",
        "escalation": "✅ Got your decision",
        "prepare_branch": f"✅ Working on branch {update.get('branch')}",
    }.get(name)


def write_progress(thread: str, **fields) -> None:
    """Where the build is, for anything watching it (the build-pause mod's pane, band and alerts):
    .build/<thread>/progress.json, replaced whole so a reader never sees half of it."""
    path = BUILD_DIR / thread / "progress.json"
    try:
        progress = json.loads(read_text(path) or "{}")
    except json.JSONDecodeError:
        progress = {}
    progress.update(fields, thread=thread, updated_at=time.time(), max_rounds=MAX_IMPLEMENTATION_ROUNDS)
    write_text(path.with_suffix(".tmp"), json.dumps(progress, indent=2))
    path.with_suffix(".tmp").replace(path)


def announce(name: str, node):
    """Wrap a step so it prints its own progress lines."""

    def before(state: BuildState):
        message = running_message(name, state)
        if message:
            print(f"⌛ {message}…", flush=True)
            write_progress(
                state["thread_id"], status="running", step=message, card=state.get("card_number") or "",
                round=state.get("implementation_attempts", 0), pid=os.getpid(),
            )

    def after(state: BuildState, update: dict | None):
        message = finished_message(name, state, update or {})
        if message:
            print(message, flush=True)
            write_progress(state["thread_id"], last=message)

    if inspect.iscoroutinefunction(node):

        async def run_async(state: BuildState):
            before(state)
            update = await node(state)
            after(state, update)
            return update

        return run_async

    def run(state: BuildState):
        before(state)
        try:
            update = node(state)
        except GraphInterrupt:
            print(f"⏸ {paused_message(name, state)}", flush=True)
            raise
        after(state, update)
        return update

    return run


def bullets(items) -> str:
    return "\n".join(f"- {item}" for item in items)


def first_line(text: str, limit: int = 100) -> str:
    lines = (text or "").strip().splitlines()
    line = lines[0] if lines else ""
    return line if len(line) <= limit else line[: limit - 1] + "…"


def tail(text: str, limit: int = 4000) -> str:
    return text if len(text) <= limit else "…" + text[-limit:]


def mark(ok: bool, text: str) -> str:
    return f"{'✓' if ok else '✗'} {text}"


def split_reply(reply: str) -> tuple[str, str]:
    """Split a reply like "go: use B" into ("go", "use B")."""
    match = re.match(r"\s*([A-Za-z]+)\b[\s:,.!—-]*(.*)", reply or "", re.DOTALL)
    if not match:
        return "", (reply or "").strip()
    return match.group(1).lower(), match.group(2).strip()


def is_stop(reply) -> bool:
    return isinstance(reply, str) and bool(STOP_REPLY.fullmatch(reply))


def stopped(node: str) -> dict:
    """The user said "stop" at a pause: end the build there, ship nothing."""
    return {"outcome": "stopped", "history": [f"• {node}: stopped by the user"]}


def read_text(path: Path) -> str:
    return path.read_text() if path.is_file() else ""


def write_text(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text)


def work_dir(state: BuildState) -> Path:
    return BUILD_DIR / state["thread_id"]


def plan_file(state: BuildState) -> Path:
    return work_dir(state) / "plan.md"


def is_bug(state: BuildState) -> bool:
    return state.get("card_type", "").strip().lower() in BUG_TYPES


def commit_prefix(state: BuildState) -> str:
    return TYPE_TO_PREFIX.get(state.get("card_type", "").strip().lower(), "feat")


def card_title(state: BuildState) -> str:
    return f"{state.get('card_number', '')} {first_line(state.get('card_details', ''), 72) or 'build'}".strip()


def checks_block() -> list[str]:
    match = re.search(r"^```checks\n(.*?)^```", read_text(AGENTS_FILE), re.DOTALL | re.MULTILINE)
    if not match:
        return []
    return [line.strip() for line in match.group(1).splitlines() if line.strip()]


def check_commands() -> list[str]:
    return [line for line in checks_block() if not line.startswith("#")]


# Checks that read the code without running it. After QA adds tests these run with QA's own
# tests instead of the whole suite: a test file can run fine yet fail the typecheck.
STATIC_CHECK = re.compile(r"typecheck|type-check|\btsc\b|mypy|pyright|lint|eslint|\bruff\b", re.IGNORECASE)


def static_check_commands() -> list[str]:
    return [command for command in check_commands() if STATIC_CHECK.search(command)]


def check_commands_in_parallel() -> bool:
    """The checks run at the same time unless the block has a `# one at a time` line."""
    return not any(re.fullmatch(r"#\s*one at a time", line, re.IGNORECASE) for line in checks_block())


# --- git and shell ---


def git(*args: str) -> str:
    return subprocess.run(
        ["git", *args], cwd=ROOT, check=True, capture_output=True, text=True
    ).stdout.strip()


def run(command: str | list[str], timeout: float | None = None, cwd: Path | None = None) -> tuple[int | None, str]:
    """Run a command in the repo. Returns (exit code, output); the code is None on timeout.
    The command gets its own process group, so a timeout also stops what it started
    (test runner workers, a dev server) instead of leaving them running."""
    process = subprocess.Popen(
        command, cwd=cwd or ROOT, shell=isinstance(command, str), stdout=subprocess.PIPE,
        stderr=subprocess.PIPE, text=True, start_new_session=True,
    )
    try:
        out, err = process.communicate(timeout=timeout)
    except BaseException as e:
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        if not isinstance(e, subprocess.TimeoutExpired):
            raise
        out, err = process.communicate()
        return None, f"timed out after {timeout}s\n{out}{err}"
    return process.returncode, out + err


def git_status() -> list[tuple[str, str]]:
    """(status, path) for every uncommitted change, untracked files included. Paths are from the
    git top, even when the pipeline lives in a subfolder."""
    out = subprocess.run(
        ["git", "status", "--porcelain", "-z", "--untracked-files=all"],
        cwd=ROOT, check=True, capture_output=True, text=True,
    ).stdout
    entries = iter(out.split("\0"))
    changes = []
    for entry in entries:
        if not entry:
            continue
        status, path = entry[:2], entry[3:]
        if status[0] in "RC":
            next(entries, None)  # a rename or copy lists its original path next
        changes.append((status, path))
    return changes


def stray_changes(state: BuildState) -> list[str]:
    ignore = set(state.get("untracked_at_start", []))
    return [path for _, path in git_status() if path not in ignore]


def commit_all(state: BuildState, message: str) -> tuple[bool, str]:
    """Commit every change except files that were already untracked when the build started."""
    still_untracked = {path for status, path in git_status() if status == "??"}
    excluded = [
        f":(top,exclude,literal){path}" for path in state.get("untracked_at_start", []) if path in still_untracked
    ]
    git("add", "-A", "--", ".", *excluded)
    if run(["git", "diff", "--cached", "--quiet"])[0] == 0:
        return True, ""
    code, output = run(["git", "commit", "-m", message])
    return code == 0, output


def in_cloud() -> bool:
    """True in a Claude Code cloud session, which can push only the session's own branch."""
    return os.environ.get("CLAUDE_CODE_REMOTE") == "true"


def default_branch() -> str:
    """The branch PRs go into. A clone records it as origin/HEAD; a repo that was pushed
    rather than cloned may not, so ask the remote, then guess from its branches."""
    try:
        return git("symbolic-ref", "--short", "refs/remotes/origin/HEAD").removeprefix("origin/")
    except subprocess.CalledProcessError:
        pass
    code, output = run(["git", "ls-remote", "--symref", "origin", "HEAD"], timeout=30)
    match = re.match(r"ref: refs/heads/(\S+)\s+HEAD", output) if code == 0 else None
    if match:
        return match.group(1)
    for name in ("main", "master"):
        if run(["git", "rev-parse", "--verify", "--quiet", f"refs/remotes/origin/{name}"])[0] == 0:
            return name
    return "main"


def branch_taken(name: str) -> bool:
    if run(["git", "rev-parse", "--verify", "--quiet", f"refs/heads/{name}"])[0] == 0:
        return True
    # A branch left on the remote by an earlier build would reject the push.
    return run(["git", "ls-remote", "--exit-code", "--heads", "origin", f"refs/heads/{name}"], timeout=30)[0] == 0


def free_branch_name(name: str) -> str:
    candidate, n = name, 1
    while branch_taken(candidate):
        n += 1
        candidate = f"{name}-{n}"
    return candidate


def exclude_build_dir() -> None:
    """Keep the pipeline's own files out of git status and commits without touching .gitignore."""
    exclude = Path(git("rev-parse", "--git-path", "info/exclude"))
    if not exclude.is_absolute():
        exclude = ROOT / exclude
    where = subfolder()
    pattern = "/.build/" if where == "." else f"/{where}/.build/"  # anchored at the git top
    if pattern not in read_text(exclude).splitlines():
        exclude.parent.mkdir(parents=True, exist_ok=True)
        with exclude.open("a") as f:
            f.write(f"\n{pattern}\n")


# Installed packages git doesn't carry into a worktree, linked from the main checkout.
DEPENDENCY_DIRS = ("node_modules", ".venv", "venv")


def add_worktree() -> Path:
    """A throwaway checkout of HEAD, outside the repo so the checks never pick it up."""
    worktree = Path(tempfile.mkdtemp(prefix="build-qa-")) / "worktree"
    git("worktree", "add", "--detach", str(worktree), "HEAD")
    for name in DEPENDENCY_DIRS:
        for source in [ROOT / name, *ROOT.glob(f"*/{name}")]:
            target = worktree / subfolder() / source.relative_to(ROOT)
            if source.is_dir() and target.parent.is_dir() and not target.exists():
                target.symlink_to(source)
    return worktree


def remove_worktree(worktree: Path) -> None:
    run(["git", "worktree", "remove", "--force", str(worktree)])
    shutil.rmtree(worktree.parent, ignore_errors=True)
    run(["git", "worktree", "prune"])


# --- pinned tests ---
#
# Tests written before the code (and QA's tests) are fingerprinted and copied
# aside. The checks step puts back any the implementer edits or deletes, so
# "don't weaken the tests" is enforced rather than requested.


def git_top() -> Path:
    return Path(git("rev-parse", "--show-toplevel")).resolve()


def subfolder() -> str:
    """Where ROOT sits under the git top: "." unless the pipeline lives in a subfolder."""
    return ROOT.resolve().relative_to(git_top()).as_posix()


def strip_cd_to_root(command: str) -> str:
    """Drop a leading `cd <subfolder> &&`: agents may write commands from the git top."""
    folder = subfolder()
    if folder == ".":
        return command
    match = re.match(rf"\s*cd\s+(?:\./)?{re.escape(folder)}/?\s*&&\s*", command)
    if not match:
        return command
    return command[match.end():]


def repo_path(path: str) -> str | None:
    folder = subfolder()
    if folder != "." and path.startswith(folder + "/") and not (ROOT / path).is_file():
        path = path.removeprefix(folder + "/")
    resolved = (ROOT / path).resolve()
    return str(resolved.relative_to(ROOT)) if resolved.is_relative_to(ROOT) else None


def _digest(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def pin_copy(state: BuildState, digest: str) -> Path:
    return work_dir(state) / "pins" / digest


def pin(state: BuildState, paths) -> dict[str, str]:
    """Fingerprint test files and keep a copy of each, to put back if they're changed."""
    pins = {}
    for path in paths:
        relative = repo_path(path)
        if relative and (ROOT / relative).is_file():
            digest = _digest(ROOT / relative)
            copy = pin_copy(state, digest)
            copy.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(ROOT / relative, copy)
            pins[relative] = digest
    return pins


def tampered_pins(pinned: dict[str, str]) -> list[str]:
    return [
        path for path, expected in pinned.items()
        if not (ROOT / path).is_file() or _digest(ROOT / path) != expected
    ]


def pinned_paths(state: BuildState, paths) -> list[str]:
    """The paths that name pinned (or already unlocked) test files, as the pins store them."""
    locked = {*state.get("pinned", {}), *state.get("unpinned", [])}
    return sorted({relative for relative in map(repo_path, paths) if relative in locked})


def unpinned_files(state: BuildState) -> dict[str, str]:
    """Unlocked test files and the fingerprint each had when it was unlocked."""
    unpinned = state.get("unpinned") or {}
    return unpinned if isinstance(unpinned, dict) else dict.fromkeys(unpinned, "")


def unpin_update(state: BuildState, files: list[str], approval: str) -> dict:
    """Unlock pinned test files for the implementer's next round; the checks after it pin them again."""
    pinned = state.get("pinned", {})
    return {
        "pinned": {path: digest for path, digest in pinned.items() if path not in files},
        "unpinned": {**unpinned_files(state), **{path: pinned[path] for path in files if path in pinned}},
        "user_decisions": [
            *state.get("user_decisions", []), f"Unlocked {', '.join(files)} so the implementer could change it: {approval}"
        ],
    }


def relock(state: BuildState) -> dict:
    """Pin the test files the user unlocked again, at the contents the implementer left them in.
    The user approved changing them, not deleting them, so a deleted one is put back first."""
    unpinned = unpinned_files(state)
    if not unpinned:
        return {}
    history = []
    for path, digest in unpinned.items():
        copy = pin_copy(state, digest) if digest else None
        if not (ROOT / path).is_file() and copy and copy.is_file():
            (ROOT / path).parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(copy, ROOT / path)
            print(f"   ↺ Put back {path}: it was deleted while unlocked, and only changing it was approved", flush=True)
            history.append(f"• put back {path}: deleted while unlocked")
    pins = pin(state, unpinned)
    if pins:
        print(f"   🔒 Locked {', '.join(sorted(pins))} again, at the implementer's new version", flush=True)
    gone = [path for path in unpinned if path not in pins]
    if gone:
        print(f"   ⚠️ {', '.join(gone)} was deleted while unlocked, and there's no copy to put back", flush=True)
        history.append(f"• unlocked test file deleted, no longer locked: {', '.join(gone)}")
    return {"pinned": {**state.get("pinned", {}), **pins}, "unpinned": {}, "history": history}


def restore_pins(state: BuildState) -> list[str]:
    """Put back every pinned test file that was changed or deleted. Returns their paths."""
    restored = []
    for path in tampered_pins(state.get("pinned", {})):
        copy = pin_copy(state, state["pinned"][path])
        if copy.is_file():
            (ROOT / path).parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(copy, ROOT / path)
            restored.append(path)
    return restored


# Test runners that found nothing to run: a typo'd path, or a filter that matched no test.
NO_TESTS_RAN = re.compile(
    r"no tests ran|no tests? (?:files? )?found|file or directory not found|no test files", re.IGNORECASE
)


REJECTIONS = {
    "no command given": "it gave no command to run them",
    "The pipeline won't run": "its test command touches git",
    "These test files are outside this repo": "they're outside this repo",
    "These test files already existed": "they were added to an existing test file instead of a new one",
    "These test files don't exist": "the test files it named don't exist",
    "No tests ran": "the test command ran no tests",
    "timed out after": "they timed out",
}


def rejection_reason(output: str, passed: str = "they passed before any code existed") -> str:
    """Why a red check failed, in a few plain words."""
    return next((reason for start, reason in REJECTIONS.items() if output.startswith(start)), passed)


def is_red(command: str, test_files=()) -> tuple[bool, str]:
    """Run a test command that must fail because the behaviour doesn't exist yet."""
    if not command.strip():
        return False, "no command given"
    # The agent wrote this command, so it gets the same guard as the agent's own shell.
    if BASH_DENY["writer"].search(command):
        return False, f"The pipeline won't run `{command}`: it touches git, and the pipeline owns git."
    # Pins cover whole files, so tests added to a shared file would lock every older test in it.
    inside = [repo_path(path) for path in test_files if repo_path(path)]
    existing = git("ls-files", "--", *inside).splitlines() if inside else []
    if existing:
        return False, (
            f"These test files already existed: {', '.join(existing)}. Put the new tests in a new file of their "
            "own: the pipeline locks every test file it's given, so adding to a shared file locks its older tests too."
        )
    elsewhere = [path for path in test_files if not repo_path(path)]
    if elsewhere:
        return False, f"These test files are outside this repo, where the pipeline can't run or pin them: {', '.join(elsewhere)}"
    missing = [path for path in test_files if not (ROOT / repo_path(path)).is_file()]
    if missing:
        return False, f"These test files don't exist: {', '.join(missing)}"
    code, output = run(strip_cd_to_root(command), timeout=CHECK_TIMEOUT_S)
    if NO_TESTS_RAN.search(output):
        return False, f"No tests ran.\n{output}"
    return code not in (0, 126, 127, None), output


TEST_PATH = re.compile(
    r"(^|/)(tests?|__tests__|specs?|fixtures|__fixtures__|__mocks__)/"
    r"|(^|/)test_[^/]+$"
    r"|[._-](test|spec)s?\.\w+$"
)


def apply_test_patch(patch: Path) -> tuple[list[str], str]:
    """Apply QA's test patch to the branch. Returns (files applied, history line)."""
    if not read_text(patch).strip():
        return [], "• qa: no tests handed back"
    code, numstat = run(["git", "apply", "--numstat", str(patch)])
    if code != 0:
        return [], f"✗ qa: test patch unreadable — {first_line(numstat)}"
    files = [line.split("\t")[2] for line in numstat.splitlines() if line.count("\t") >= 2]
    not_tests = [path for path in files if not TEST_PATH.search(path)]
    if not_tests:
        return [], f"✗ qa: test patch rejected, it touches non-test files: {', '.join(not_tests)}"
    code, output = run(["git", "apply", str(patch)])
    if code != 0:
        return [], f"✗ qa: test patch did not apply — {first_line(output)}"
    return files, f"• qa: applied {len(files)} test file(s) to the branch"


# --- prompt blocks ---


def card_block(state: BuildState) -> str:
    card = state.get("card_number") or "(ad-hoc request, no card)"
    return f"## Card\n{card} · type: {state.get('card_type', '')}\n\n{state.get('card_details', '').strip()}"


def slice_block(state: BuildState) -> str:
    slices = state.get("slices") or []
    if not slices:
        return ""
    index = state.get("current_slice", 0)
    done = ", ".join(s["title"] for s in slices[:index]) or "none yet"
    current = slices[index]
    return (
        f"## Current slice ({index + 1} of {len(slices)}): {current['title']}\n"
        f"{current['delivers']}\n\nBuild and judge ONLY this slice. Slices already done: {done}."
    )


def fix_round_block(state: BuildState, key: str) -> str:
    """On a fix round, point the reviewer at what changed since it last looked."""
    last = state.get("last_review") or {}
    if not last.get("head") or last["head"] == git("rev-parse", "HEAD"):
        return ""
    return (
        f"## Fix round\nYou already reviewed this slice up to {last['head'][:12]}. Your findings then:\n"
        f"{last.get(key) or 'None: you approved it.'}\n\n"
        f"The fixes since are `git diff {last['head']}..HEAD`. Check each finding was fixed, and look for "
        "problems the fixes introduced. Don't re-review code the fixes didn't touch, and don't repeat "
        "notes, tech debt or manual checks you already gave."
    )


def review_block(state: BuildState, key: str, extra: str = "") -> str:
    diff_range = f"{state['slice_base']}..HEAD"
    parts = [
        card_block(state),
        slice_block(state),
        f"## Approved plan\n{state['plan']}",
        (
            f"## What to review\nThe change is `git diff {diff_range}` "
            f"(commits: `git log --oneline {diff_range}`). Review only that range."
        ),
        fix_round_block(state, key),
        user_decisions_block(state),
        extra,
    ]
    return "\n\n".join(part for part in parts if part)


def user_decisions_block(state: BuildState) -> str:
    if not state.get("user_decisions"):
        return ""
    return (
        "## Decisions the user made during the build\nThe user answered the implementer's questions. Their "
        "answers win over the plan: check the code follows them, but never ask for something they approved to be "
        "undone, or for something they ruled out:\n" + bullets(state["user_decisions"])
    )


def format_questions(items: list[dict]) -> str:
    blocks = []
    for n, item in enumerate(items, 1):
        lines = [f"Q{n}. {item['question']}"]
        if item.get("options"):
            lines.append(f"    Options: {item['options']}")
        lines.append(f"    ➡ Recommended: {item['recommendation']}")
        blocks.append("\n".join(lines))
    return "\n\n".join(blocks)


ANSWER = re.compile(r"\bQ(\d+)\s*[:=.)-]?\s*(.*?)(?=[;,\n]?\s*\bQ\d+\b|$)", re.I | re.S)


def parse_answers(text: str) -> dict[int, str]:
    """The user's sign-off reply ("Q1 B; Q2 A", "Q1=B, Q2=A") as {question number: answer}."""
    answers = {}
    for match in ANSWER.finditer(text):
        answer = match.group(2).strip().rstrip(";,.").strip()
        if answer:
            answers[int(match.group(1))] = answer
    return answers


def option_text(options: str, letter: str) -> str:
    parts = re.split(r"\b([A-Z])\)", options)
    for label, wording in zip(parts[1::2], parts[2::2]):
        if label == letter:
            return wording.strip().rstrip(",;").strip()
    return ""


def answer_letter(answer: str) -> str:
    match = re.fullmatch(r"\s*\(?([A-Za-z])\)?[.:,]?\s*", answer)
    if not match:
        return ""
    return match.group(1).upper()


def answers_differ(decisions: list[dict], text: str) -> bool:
    """Whether the reply picks anything but the recommendation. Free text counts as differing."""
    answers = parse_answers(text)
    if text.strip() and not answers:
        return True
    for n, answer in answers.items():
        if not 1 <= n <= len(decisions):
            continue
        recommended = re.match(r"\s*\(?([A-Z])\b[).:,]?", decisions[n - 1]["recommendation"])
        letter = answer_letter(answer)
        if not recommended or not letter:
            return True
        options = decisions[n - 1].get("options", "")
        if letter != recommended.group(1) and not (keeps_plan(options, letter) and keeps_plan(options, recommended.group(1))):
            return True
    return False


def keeps_plan(options: str, letter: str) -> bool:
    """A long-term-fix answer that builds this plan as it is: "Card only", or "Later" (filed as its own card)."""
    return bool(re.match(r"(?:card only|later)\b", option_text(options, letter), re.I))


def spelled_answers(decisions: list[dict], text: str) -> str:
    answers = parse_answers(text)
    lines = []
    for n, item in enumerate(decisions, 1):
        answer = answers.get(n)
        if not answer:
            lines.append(f"Q{n}. {item['question']} → recommended: {item['recommendation']}")
            continue
        letter = answer_letter(answer)
        wording = option_text(item.get("options", ""), letter) if letter else ""
        lines.append(f"Q{n}. {item['question']} → {letter or answer}: {wording or answer}")
    if text.strip() and not answers:
        lines.append(text.strip())
    return "\n".join(lines)


def answered_question(line: str) -> str:
    match = re.match(r"Q\d+\. (.*?) → ", line)
    if not match:
        return ""
    return match.group(1)


def merge_answers(saved: str, new: str) -> str:
    """Answers from an earlier sign-off round plus this round's. A question answered earlier keeps
    that answer unless the user picks again; it never falls back to the recommendation."""
    lines = saved.splitlines()
    for line in new.splitlines():
        question = answered_question(line)
        earlier = [i for i, old in enumerate(lines) if question and answered_question(old) == question]
        if not earlier:
            lines.append(line)
        elif "→ recommended: " not in line:
            lines[earlier[0]] = line
    return "\n".join(lines)


def review_findings(values: dict, key: str) -> str:
    """A reviewer's must-fix findings. The code critic's unapproved decisions are kept
    apart, so they drop out once the user has answered them."""
    parts = [values.get(f"{key}_feedback", "")]
    if key == "code" and values.get("code_decisions"):
        parts.append(
            "### Decisions made without sign-off\nDon't change the code for these: reply with status "
            f"ESCALATE and put them to the user:\n{bullets(values['code_decisions'])}"
        )
    return "\n\n".join(part for part in parts if part)


def fix_feedback(state: BuildState) -> str:
    sections = []
    if state.get("checks_feedback"):
        sections.append(f"## Automatic checks failed\n{state['checks_feedback']}")
    for key, label in REVIEW_LABELS.items():
        findings = review_findings(state, key)
        if state.get(f"{key}_verdict") == "NEEDS_REWORK" and findings:
            sections.append(f"## {label}: must fix\n{findings}")
    if not sections:
        return ""
    return "--- FIX ROUND ---\nYour previous implementation was checked. Fix these issues:\n\n" + "\n\n".join(sections)


def cleared_reviews() -> dict:
    return {
        "checks_feedback": "",
        "code_decisions": [],
        **{f"{key}_verdict": "" for key in REVIEW_LABELS},
        **{f"{key}_feedback": "" for key in REVIEW_LABELS},
    }


# --- planning nodes ---


def designer_news(state: BuildState, continuing: bool) -> list[str]:
    """What the designer hasn't seen yet: answers to its questions, and feedback on its plan.
    A continued session already has its previous plan, unless it was edited during the pause."""
    parts = []
    if state.get("clarify_answers"):
        parts.append(f"## Your clarifying questions, answered\n{state['clarify_answers']}")
    if state.get("clarify_rounds", 0) >= MAX_CLARIFY_ROUNDS:
        parts.append(
            "You have used every clarifying round. Don't ask more questions: decide, "
            "and list each assumption under `decisions`."
        )
    feedback = state.get("plan_feedback", "")
    previous_plan = read_text(plan_file(state))
    if feedback and previous_plan:
        resend = not continuing or previous_plan != state.get("plan")
        parts.append(
            "--- REWORK ---\nYour previous plan was sent back. Do NOT start from scratch: "
            "apply the feedback and keep everything else intact.\n\n"
            f"## Feedback\n{feedback}" + (f"\n\n## Previous plan\n{previous_plan}" if resend else "")
        )
    elif feedback:
        parts.append(f"## Your previous plan was sent back. Feedback:\n{feedback}")
    if continuing and parts:
        parts.append("Return your whole answer again, every field, updated.")
    return parts


async def designer(state: BuildState):
    rounds = state.get("clarify_rounds", 0)
    result, _ = await continue_agent(
        "designer",
        state.get("designer_session", ""),
        "\n\n".join(designer_news(state, continuing=True)),
        "\n\n".join([card_block(state), *designer_news(state, continuing=False)]),
        DESIGNER_OUTPUT,
    )
    out = result.output
    if out["clarifying_questions"] and rounds < MAX_CLARIFY_ROUNDS:
        # Keep the previous plan and the feedback it was sent back with: the next draft still needs them.
        return {
            "designer_session": result.session_id,
            "clarify_questions": out["clarifying_questions"],
            "history": [f"• designer: asked {len(out['clarifying_questions'])} clarifying question(s)"],
        }
    write_text(plan_file(state), out["plan"])
    slices = [] if is_bug(state) else out["slices"]
    return {
        "designer_session": result.session_id,
        "validity": out["validity"],
        "validity_evidence": out["validity_evidence"],
        "clarify_questions": [],
        "plan": out["plan"],
        **{
            key: out[key]
            for key in ("problem", "task", "solution", "files", "risks", "door", "blast_radius", "complexity", "complexity_reason")
        },
        "seams": out["seams"],
        "decisions": out["decisions"],
        "slices": slices,
        "plan_attempts": state.get("plan_attempts", 0) + 1,
        "plan_feedback": "",
        "history": [f"• designer: {out['validity']}, {len(out['decisions'])} decision(s), {len(slices)} slice(s)"],
    }


def clarify(state: BuildState):
    questions = format_questions(state["clarify_questions"])
    reply = interrupt(
        f"QUESTIONS BEFORE PLANNING\n\n{questions}\n\n"
        'Reply with your answers, e.g. "Q1: ...; Q2: ...". "go" accepts every recommendation; '
        '"stop" ends the build.'
    )
    word, rest = split_reply(reply)
    if is_stop(reply):
        return {"clarify_questions": [], **stopped("clarify")}
    answer = "Use your recommended answer for every question." if word in APPROVALS and not rest else reply
    answered = f"{state.get('clarify_answers', '')}\n\n{questions}\n\nAnswer: {answer}".strip()
    return {
        "clarify_answers": answered,
        "clarify_rounds": state.get("clarify_rounds", 0) + 1,
        "clarify_questions": [],
        "history": ["• clarify: the card needed answers before planning"],
    }


async def plan_critic(state: BuildState):
    revised = (
        f"## Revised plan\n{state['plan']}\n\n"
        "The designer revised the plan since your review. Check your findings were addressed, and look "
        "for new problems in what changed. Don't re-check citations you already verified unless the plan "
        "changed them. Return your whole answer again, every field."
    )
    result, _ = await continue_agent(
        "plan_critic",
        state.get("critic_session", ""),
        revised,
        f"{card_block(state)}\n\n## Proposed plan\n{state['plan']}",
        CRITIC_OUTPUT,
    )
    out = result.output
    rework = out["verdict"] == "NEEDS REWORK"
    worst = f" — {out['top_findings'][0]}" if rework and out["top_findings"] else ""
    # Either planner rating the change significant is enough to ask the user.
    raised = out["complexity"] == "significant" and state.get("complexity") != "significant"
    return {
        "critic_session": result.session_id,
        **({"complexity": "significant", "complexity_reason": out["complexity_reason"]} if raised else {}),
        "plan_verdict": out["verdict"],
        "plan_findings": out["top_findings"],
        "plan_tweaks": out["tweaks"] if out["verdict"] == "SOLID WITH TWEAKS" else [],
        "plan_feedback": out["review"] if rework else "",
        "history": [mark(not rework, f"plan_critic: {out['verdict']}{worst}")],
    }


PLAN_APPROVALS = {
    "APPROVED": "approved by you",
    "AUTO_APPROVED": "approved automatically: a routine change, easy to undo, nothing to decide",
}
DOORS = {
    "one-way": "One-way door: hard to undo once merged",
    "two-way": "Two-way door: easy to roll back",
}


def section(title: str, items) -> list[str]:
    return ["", f"{title}:", *[f"  - {item}" for item in items]] if items else []


SEVERITY_WORDS = {"[BLOCKER]": "Must fix:", "[MAJOR]": "Should fix:", "[MINOR]": "Small:"}


def plain_finding(finding: str) -> str:
    for tag, words in SEVERITY_WORDS.items():
        if finding.startswith(tag):
            return f"{words}{finding.removeprefix(tag)}"
    return finding


def critic_summary(state: BuildState) -> str:
    verdict = state.get("plan_verdict")
    if verdict == "NEEDS REWORK":
        return "critic still has concerns (below)"
    tweaks = len(state.get("plan_tweaks", []))
    if tweaks:
        return f"critic approved, with {plural(tweaks, 'small change')} folded in"
    return "critic approved" if verdict else "critic not run"


def plan_summary(state: BuildState) -> list[str]:
    return [
        *section("Problem", state.get("problem", [])),
        *section("Task", state.get("task", [])),
        *section("Solution", state.get("solution", [])),
    ]


def plan_brief(state: BuildState, boxed: bool = False) -> str:
    """Only what's needed to decide: the why/what/how summary and any open questions.
    Files, tests, critic notes and risks stay in the plan file. `boxed`, for the question box,
    leaves out the questions and how to reply: the box asks them itself."""
    lines = [
        f"PLAN FOR REVIEW — {state.get('card_number') or 'ad-hoc request'} · {critic_summary(state)}",
        *plan_summary(state),
    ]
    if len(state.get("slices") or []) > 1:
        lines += section("Slices", [f"{s['title']}: {s['delivers']}" for s in state["slices"]])
    if state.get("complexity") == "significant" and state.get("complexity_reason"):
        lines += ["", f"Why this needs your sign-off: {state['complexity_reason']}"]
    if state.get("plan_verdict") == "NEEDS REWORK":
        lines += section("The critic's unresolved concerns", [plain_finding(f) for f in state.get("plan_findings", [])])
    if state.get("decisions") and not boxed:
        lines += ["", "Decisions for you:", format_questions(state["decisions"])]
    lines += ["", f"The technical details (files, tests, risks), if you want them: {plan_file(state).relative_to(ROOT)}"]
    if not boxed:
        lines += [
            "",
            (
                'Reply "go" to approve (recommended answers), "go: Q1 <answer>; Q2 <answer>" to approve '
                'with your answers, "rework: <feedback>" to send it back, or "stop" to end the build.'
            ),
        ]
    return "\n".join(lines)


def auto_approved_brief(state: BuildState) -> str:
    """Printed before any building starts, so the user sees what's coming and can step in."""
    reason = f": {state['complexity_reason']}" if state.get("complexity_reason") else ""
    return "\n".join([
        "=" * 60,
        f"PLAN APPROVED AUTOMATICALLY — {state.get('card_number') or 'ad-hoc request'} · a routine change{reason}",
        *plan_summary(state),
        "",
        'Building now. To change the plan, tell Claude "stop, <what to change>".',
        "=" * 60,
    ])


def invalid_brief(state: BuildState, boxed: bool = False) -> str:
    lines = [
        f"CARD LOOKS INVALID — {state.get('card_number') or 'ad-hoc request'}: "
        f"{VALIDITY_WORDS.get(state['validity'], state['validity'])}",
        *section("Problem", state.get("problem", [])),
        *section("What the card should become", state.get("solution", [])),
    ]
    if not boxed:
        lines += [
            "",
            (
                'Reply "close" if the card is not needed, "rework: <why it is still needed>" to plan it '
                'anyway, or "stop" to end the build without deciding.'
            ),
        ]
    return "\n".join(lines)


def _sent_back(state: BuildState, feedback: str) -> dict:
    if state.get("plan_verdict") == "NEEDS REWORK" and state.get("plan_feedback"):
        feedback += f"\n\n### The plan critic's review (still unresolved)\n{state['plan_feedback']}"
    return {
        "plan_decision": "REJECTED",
        "plan_feedback": feedback,
        "plan_attempts": 0,
        "always_sign_off": True,  # the user wants to see the next draft
        "history": [f"✗ sign_off: sent back — {first_line(feedback)}"],
    }


def sign_off(state: BuildState):
    if state.get("validity", "VALID") != "VALID":
        reply = interrupt(invalid_brief(state))
        word, rest = split_reply(reply)
        if is_stop(reply):
            return {"plan_decision": "STOPPED", **stopped("sign_off")}
        if word == "close":
            return {
                "plan_decision": "CLOSED",
                "outcome": "closed",
                "history": [f"• sign_off: card closed ({state['validity']})"],
            }
        return _sent_back(state, rest if word == "rework" else reply)

    if auto_approvable(state):
        return approve(state, "", "AUTO_APPROVED")
    reply = interrupt(plan_brief(state))
    word, rest = split_reply(reply)
    if is_stop(reply):
        return {"plan_decision": "STOPPED", **stopped("sign_off")}
    if word not in APPROVALS:
        return _sent_back(state, rest if word == "rework" else reply)
    decisions = state.get("decisions")
    if rest and decisions and answers_differ(decisions, rest):
        spelled = merge_answers(state.get("sign_off_answers", ""), spelled_answers(decisions, rest))
        return answers_sent_back(state, spelled)
    return approve(state, rest, "APPROVED")


def answers_sent_back(state: BuildState, spelled: str) -> dict:
    feedback = (
        "The user signed off with these answers, which override your recommendations. Rewrite every "
        "part of the plan (Problem/Task/Solution, Approach, tests, risks) to follow them, and remove "
        "these from `decisions`. If you must keep one there, keep its question word for word: a "
        f"reworded question counts as new and is asked again.\n{spelled}"
    )
    return {
        **_sent_back(state, feedback),
        "sign_off_answers": spelled,
        "history": ["✗ sign_off: answers differ from the recommendation — plan sent back to follow them"],
    }


def auto_approvable(state: BuildState) -> bool:
    """Small and medium cards skip sign-off: both planners rated the change routine (no complex
    logic, architectural change or critical area), it's easy to undo, it fits one slice, the
    critic is happy, and nothing is left for the user to decide."""
    return (
        not state.get("always_sign_off")
        and state.get("complexity") == "routine"
        and state.get("door") == "two-way"
        and not state.get("decisions")
        and not state.get("slices")
        and state.get("plan_verdict") in ("SOLID", "SOLID WITH TWEAKS")
    )


def approve(state: BuildState, answers: str, decision: str) -> dict:
    # Re-read the plan file so direct edits made during the pause count.
    new_answers = answers
    if state.get("decisions"):
        new_answers = spelled_answers(state["decisions"], answers)
    answers_block = merge_answers(state.get("sign_off_answers", ""), new_answers)
    sections = []
    if answers_block:
        sections.append(f"## Sign-off answers — these override anything below that disagrees\n{answers_block}")
    sections.append(read_text(plan_file(state)) or state["plan"])
    if state.get("plan_tweaks"):
        sections.append(f"## Critic tweaks (apply these)\n{bullets(state['plan_tweaks'])}")
    approved = "\n\n".join(sections)
    write_text(work_dir(state) / "approved-plan.md", approved)
    how = "approved automatically (routine)" if decision == "AUTO_APPROVED" else "approved"
    return {
        "plan_decision": decision,
        "plan": approved,
        "plan_feedback": "",
        "sign_off_answers": answers_block,
        "history": [f"✓ sign_off: {how}{' with answers' if answers else ''}"],
    }


def prepare_branch(state: BuildState):
    stray = stray_changes(state)
    if stray:
        raise BuildError(
            "Files changed while the plan was being made (planning agents are read-only, "
            f"so check these):\n{bullets(stray)}\nCommit, stash or remove them, then run --retry."
        )
    base = default_branch()
    branch = git("rev-parse", "--abbrev-ref", "HEAD")
    requested = state.get("requested_branch")
    if requested and requested != branch:
        if run(["git", "rev-parse", "--verify", "--quiet", f"refs/heads/{requested}"])[0] == 0:
            git("checkout", requested)
        elif run(["git", "ls-remote", "--exit-code", "--heads", "origin", requested], timeout=30)[0] == 0:
            git("fetch", "origin", requested)  # build on top of what's pushed, so the push isn't rejected
            git("checkout", "-b", requested, "--track", f"origin/{requested}")
        else:
            git("checkout", "-b", requested)
        branch = requested
    elif not requested and branch in (base, "HEAD"):
        branch = free_branch_name(f"{commit_prefix(state)}/{state['thread_id'].lower()}")
        git("checkout", "-b", branch)
    head = git("rev-parse", "HEAD")
    return {
        "base_branch": base,
        "branch": branch,
        "build_base": head,
        "slice_base": head,
        "current_slice": 0,
        "history": [f"• branch: {branch}"],
    }


# --- test-first nodes ---


async def reproducer(state: BuildState):
    parts = [card_block(state), f"## Approved plan\n{state['plan']}"]
    if state.get("test_feedback"):
        parts.append(f"## Your previous test was rejected\n{state['test_feedback']}")
    if state.get("escalation_answer"):
        parts.append(f"## You couldn't reproduce this before. The user says:\n{state['escalation_answer']}")
    result = await run_agent("reproducer", "\n\n".join(parts), REPRODUCER_OUTPUT)
    out = result.output
    done = {"test_attempts": 0, "test_feedback": "", "escalation_answer": ""}
    if out["status"] != "REPRODUCED":
        return {
            **done,
            "escalation": f"Couldn't reproduce the bug.\n\nSymptom: {out['symptom']}\n\n{out['tried']}",
            "escalation_source": "reproducer",
            "history": [f"✗ reproducer: couldn't reproduce — {first_line(out['tried'])}"],
        }
    red, output = is_red(out["command"], out["test_files"])
    if red:
        return {
            **done,
            "repro": f"`{out['command']}` fails on: {out['symptom']}\n\n{out['summary']}",
            "repro_command": out["command"],
            "tests": out["summary"],
            "pinned": {**state.get("pinned", {}), **pin(state, out["test_files"])},
            "history": [f"✓ reproducer: red on {first_line(out['symptom'])}"],
        }
    attempts = state.get("test_attempts", 0) + 1
    reason = rejection_reason(output, passed="it passed, so it doesn't show the bug")
    feedback = (
        f"You said `{out['command']}` fails on the bug, but the pipeline rejected it: {reason}. Output:\n"
        f"{tail(output, 1500)}"
    )
    update = {
        "test_attempts": attempts,
        "test_feedback": feedback,
        "test_rejection": reason,
        "history": [f"✗ reproducer: test rejected — {reason}"],
    }
    if attempts >= MAX_TEST_ATTEMPTS:
        update["escalation"] = (
            f"The reproducer wrote a test for the bug, but the build rejected it: {reason}.\n\n"
            f"Symptom it says the test catches: {out['symptom']}\n\n{feedback}"
        )
        update["escalation_source"] = "reproducer"
    return update


async def test_writer(state: BuildState):
    parts = [card_block(state), slice_block(state), f"## Approved plan\n{state['plan']}"]
    if state.get("seams"):
        parts.append(f"## Agreed test points (seams)\n{bullets(state['seams'])}")
    if state.get("test_feedback"):
        parts.append(f"## Your previous tests were rejected\n{state['test_feedback']}")
    if state.get("escalation_answer"):
        parts.append(f"## The user says\n{state['escalation_answer']}")
    result = await run_agent("test_writer", "\n\n".join(p for p in parts if p), TEST_WRITER_OUTPUT)
    out = result.output
    done = {"test_attempts": 0, "test_feedback": "", "escalation_answer": ""}
    if not out["test_files"]:
        return {**done, "tests": out["summary"], "history": [f"• test_writer: no tests — {first_line(out['summary'])}"]}

    red, output = is_red(out["command"], out["test_files"])
    if red:
        return {
            **done,
            "tests": out["summary"],
            "pinned": {**state.get("pinned", {}), **pin(state, out["test_files"])},
            "history": [f"✓ test_writer: {len(out['test_files'])} failing test file(s) pinned"],
        }
    attempts = state.get("test_attempts", 0) + 1
    reason = rejection_reason(output)
    feedback = (
        f"`{out['command']}` didn't fail for the right reason before any implementation exists: {reason}. "
        f"So the tests prove nothing yet. Output:\n{tail(output, 1500)}"
    )
    update = {
        "test_attempts": attempts,
        "test_feedback": feedback,
        "test_rejection": reason,
        "history": [f"✗ test_writer: tests weren't red — {first_line(out['command'])}"],
    }
    if attempts >= MAX_TEST_ATTEMPTS:
        update["escalation"] = f"The test writer couldn't produce failing acceptance tests.\n\n{feedback}"
        update["escalation_source"] = "test_writer"
    return update


# --- implementation nodes ---


def implementer_prompt(state: BuildState, feedback: str) -> str:
    parts = [card_block(state), slice_block(state), f"## Approved plan\n{state['plan']}"]
    if state.get("repro"):
        parts.append(f"## Bug reproduction (make this pass)\n{state['repro']}")
    if state.get("tests"):
        parts.append(f"## Failing tests already written (make these pass)\n{state['tests']}")
    parts.append(pinned_block(state))
    parts.append(unpinned_block(state))
    parts.append(feedback)
    if state.get("escalation_answer"):
        parts.append(f"## Your escalated question, answered\n{state['escalation_answer']}")
    return "\n\n".join(part for part in parts if part)


def pinned_block(state: BuildState) -> str:
    if not state.get("pinned"):
        return ""
    return (
        "## Pinned test files (read-only: the pipeline puts back any change; if one is wrong, ESCALATE "
        "with an option whose `unpin_files` lists it)\n" + bullets(sorted(state["pinned"]))
    )


def unpinned_block(state: BuildState) -> str:
    if not state.get("unpinned"):
        return ""
    return (
        "## Test files you may change this round\nThe user approved changing these pinned test files. Make only "
        "the change they approved. The pipeline pins them again, at your new contents, when you finish:\n"
        + bullets(sorted(unpinned_files(state)))
    )


async def implementer(state: BuildState):
    feedback = fix_feedback(state)
    answer = state.get("escalation_answer", "")
    answered = answer and f"## Your escalated question, answered\n{answer}"
    news = "\n\n".join(p for p in [pinned_block(state), unpinned_block(state), feedback, answered] if p)
    resumes = state.get("implementer_resumes", 0)
    # Continue the same session on fix rounds: it already knows the code it wrote.
    session = state.get("implementer_session", "") if resumes < MAX_SESSION_RESUMES else ""
    result, resume = await continue_agent(
        "implementer", session, news, implementer_prompt(state, feedback), IMPLEMENTER_OUTPUT
    )
    out = result.output
    session_update = {
        "implementer_session": result.session_id,
        "implementer_resumes": resumes + 1 if resume else 0,
        "follow_ups": out["follow_ups"],
    }
    if out["status"] == "ESCALATE":
        question = out["escalation"] or out["summary"]
        options = {}
        for option in out.get("options", []):
            key = option.get("id", "").strip()
            if key and key.lower() not in ("other", "stop") and key not in options:
                options[key] = {**option, "id": key, "unpin_files": pinned_paths(state, option.get("unpin_files", []))}
        options = list(options.values())
        if out.get("options") and not options:
            question += "\n\n**Options**\n" + bullets(f"{o.get('label', '')} — {o.get('what_happens', '')}" for o in out["options"])
        return {
            **session_update,
            "escalation": question,
            "escalation_source": "implementer",
            "pause_id": uuid.uuid4().hex[:6],
            "pause_options": options,
            "pause_recommended": out.get("recommended", ""),
            "history": [f"✗ implementer: escalated — {first_line(question)}"],
        }
    rounds = state.get("implementation_attempts", 0) + 1
    return {
        **session_update,
        **cleared_reviews(),
        "implementation": out["summary"],
        "implementation_attempts": rounds,
        "escalation_answer": "",
        "history": [f"• implementer: round {rounds}{' (resumed)' if resume else ''}"],
    }


SKIP_TO = {"reproducer": "test_writer", "test_writer": "implementer"}
ESCALATION_HINTS = {
    "reproducer": ' "skip" builds without a reproduction.',
    "test_writer": ' "skip" builds without acceptance tests.',
}


def unpin_hint(state: BuildState) -> str:
    """For a question without options: plain "unpin" unlocks every pinned test for one round."""
    files = sorted(state.get("pinned", {}))
    if not files:
        return ""
    return (
        f"\n\nOnly if this is about a locked test: \"unpin: <reason>\" unlocks all "
        f"{plural(len(files), 'locked test file')}: {', '.join(files)}, for the implementer's next round only."
    )


# --- structured replies (stage 2) ---
#
# The implementer's options reach the build as SDK-checked JSON. The reply comes
# back from the chat session as text on the command line, so the build checks it
# against a schema made for this pause before resuming. Which tests a choice
# unlocks is read off the option itself, never worked out by the messenger.


def structured_pause(values: dict) -> bool:
    return values.get("escalation_source") == "implementer" and bool(values.get("pause_options"))


def reply_schema(values: dict) -> dict:
    """What a reply to this pause must look like: this pause's ID, and one of its options or your own answer."""
    locked = sorted(values.get("pinned", {}))
    properties = {
        "pause_id": {"const": values["pause_id"]},
        "choice": {"enum": [option["id"] for option in values["pause_options"]] + ["other"]},
        "tests": {"enum": ["keep", "unpin"] if locked else ["keep"]},
        "answer": {"type": "string"},
    }
    other = {"required": ["tests", "answer"], "properties": {"answer": {"pattern": r"\S"}}}
    if locked:
        properties["files"] = {"type": "array", "items": {"enum": locked}, "uniqueItems": True}
        other["if"] = {"properties": {"tests": {"const": "unpin"}}, "required": ["tests"]}
        other["then"] = {"required": ["files"], "properties": {"files": {"minItems": 1}}}
    return {
        "type": "object",
        "required": ["pause_id", "choice"],
        "properties": properties,
        "additionalProperties": False,
        "if": {"properties": {"choice": {"const": "other"}}},
        "then": other,
        # A picked option already says which tests it unlocks.
        "else": {"properties": {"tests": False, "files": False}},
    }


def check_reply(values: dict, text: str) -> tuple[dict | str | None, str]:
    """The resume value for this reply, or None and why the reply was rejected."""
    if re.fullmatch(r"\s*rework\s*:?\s*", text, re.I):
        return None, 'say what to change: "rework: <what to change>"'
    if not structured_pause(values):
        if re.match(r"\s*\{", text) and '"pause_id"' in text:
            return None, "this question has no options to pick from, so reply with the decision in plain words, not JSON"
        return text, ""
    if is_stop(text):
        return text, ""
    try:
        reply = json.loads(text)
    except json.JSONDecodeError:
        return None, "this question needs a JSON reply, in the shape below"
    errors = sorted(jsonschema.Draft202012Validator(reply_schema(values)).iter_errors(reply), key=str)
    if errors:
        error = errors[0]
        where = ".".join(str(part) for part in error.absolute_path)
        if not where:
            where = error.message.split("'")[1] if error.validator == "required" else "reply"
        if error.schema is False:
            return None, "a picked option already says which tests it unlocks, so leave out tests and files"
        return None, f"{where}: {error.message}"
    return reply, ""


def reply_format(values: dict) -> str:
    pause = values["pause_id"]
    example = json.dumps({"pause_id": pause, "choice": values["pause_options"][0]["id"]})
    own = {"pause_id": pause, "choice": "other", "tests": "keep", "answer": "<the user's own words>"}
    return (
        f"Reply with JSON (pause {pause}). To pick an option: {example}\n"
        f"For the user's own answer: {json.dumps(own)}. Use \"tests\": \"unpin\" with \"files\": [...] "
        "to unlock locked tests for one round. \"stop\" ends the build.\n"
        f"Reply schema: {json.dumps(reply_schema(values))}"
    )


def option_lines(values: dict) -> str:
    lines = []
    for option in values["pause_options"]:
        recommended = " (recommended)" if option["id"] == values.get("pause_recommended") else ""
        files = option["unpin_files"]
        unlocks = f" Choosing it unlocks {plural(len(files), 'locked test')}: {', '.join(files)}." if files else ""
        lines.append(
            f"{option['id']}) {option['label']}{recommended} — {option.get('what_happens', '')} "
            f"Cost: {option.get('cost', '')}{unlocks}"
        )
    return "\n".join(lines)


def chosen(state: BuildState, reply: dict) -> tuple[str, list[str]]:
    """What the user chose, in words for the implementer and reviewers, and the tests it unlocks."""
    if reply["choice"] == "other":
        files = reply.get("files", []) if reply.get("tests") == "unpin" else []
        unlocks = f" Unlock for one round: {', '.join(files)}." if files else " Keep every test locked."
        return f"The user gave their own answer: {reply['answer']}{unlocks}", files
    option = next(option for option in state["pause_options"] if option["id"] == reply["choice"])
    words = f" The user added: {reply['answer']}" if reply.get("answer") else ""
    return f"The user chose {option['id']}) {option['label']}.{words}", option["unpin_files"]


def escalation(state: BuildState):
    source = state.get("escalation_source", "implementer")
    if structured_pause(state):
        ask = f"Options:\n{option_lines(state)}\n\n{reply_format(state)}"
    else:
        hint = unpin_hint(state) if source == "implementer" else ""
        ask = f"Reply with your decision, or \"stop\" to end the build.{ESCALATION_HINTS.get(source, '')}{hint}"
    reply = interrupt(f"DECISION NEEDED (from the {NODE_LABELS[source]})\n\n{state['escalation']}\n\n{ask}")
    if isinstance(reply, dict):
        answer, files = chosen(state, reply)
        word, rest = "", ""
    else:
        word, rest = split_reply(reply)
        answer = reply.strip()
        # A build paused before options existed may have named the files "unpin" unlocks.
        offered = state.get("unpin_request") if state.get("unpin_named") else sorted(state.get("pinned", {}))
        files = offered if word == "unpin" and source == "implementer" else []
    if is_stop(reply):
        return {"escalation": "", **stopped("escalation")}
    update = {
        "escalation": "",
        "escalation_answer": answer,
        "escalation_next": source,
        "history": [f"• escalation answered: {first_line(answer)}"],
    }
    if source in ("test_writer", "reproducer"):
        update["test_attempts"] = 0
    if word == "skip" and source in SKIP_TO:
        update.update(escalation_next=SKIP_TO[source], escalation_answer="", test_feedback="")
    if source == "implementer":
        update["code_decisions"] = []  # answered now, so don't ask the implementer to escalate them again
        update["pause_options"] = []
        # Reviewers see every answer, so they don't send back what the user decided.
        update["user_decisions"] = [*state.get("user_decisions", []), answer]
        if files:
            update.update(unpin_update(state, files, answer if isinstance(reply, dict) else rest or "approved"))
            update["history"].append(f"• unpinned for one round: {', '.join(files)}")
    return update


def failing_commands(commands: list[str]) -> list[str]:
    workers = len(commands) if check_commands_in_parallel() else 1
    with ThreadPoolExecutor(max_workers=max(workers, 1)) as pool:
        results = list(pool.map(lambda command: run(command, timeout=CHECK_TIMEOUT_S), commands))
    problems = []
    for command, (code, output) in zip(commands, results):
        print(f"   {'✅' if code == 0 else '❌'} {command}", flush=True)
        if code != 0:
            problems.append(f"$ {command}\n{tail(output)}")
    return problems


def failing_checks(state: BuildState) -> list[str]:
    """Put back tampered pinned tests, then run every command in AGENTS.md's checks block."""
    problems = []
    restored = restore_pins(state)
    if restored:
        print(f"   ↺ Put back {plural(len(restored), 'pinned test file')} the implementer changed", flush=True)
    tampered = tampered_pins(state.get("pinned", {}))
    if tampered:
        problems.append(
            "Pinned test files were changed or deleted, and the pipeline has no copy to put back. Restore "
            "them; if one is genuinely wrong, ESCALATE instead, with an option whose `unpin_files` lists it:\n"
            f"{bullets(tampered)}"
        )
    commands = check_commands()
    if not commands:
        problems.append(f"{AGENTS_FILE.name} has no ```checks block, so the tests can't be run.")
    problems += failing_commands(commands)
    # The bug's reproduction may not be a test the checks pick up, so it's run as well: the fix must turn it green.
    repro = state.get("repro_command", "")
    if repro and repro not in commands:
        code, output = run(strip_cd_to_root(repro), timeout=CHECK_TIMEOUT_S)
        print(f"   {'✅' if code == 0 else '❌'} {repro} (the bug's reproduction)", flush=True)
        if code != 0:
            problems.append(f"The bug still reproduces:\n$ {repro}\n{tail(output)}")
    if restored and problems:
        problems.insert(0, (
            "You changed or deleted pinned test files, so the pipeline put them back before running the "
            f"checks:\n{bullets(restored)}\nDon't edit them. If one is genuinely wrong, ESCALATE with an option "
            "whose `unpin_files` lists it: the user can unlock it for one round."
        ))
    return problems


def checks(state: BuildState):
    relocked = relock(state)
    problems = failing_checks(state)
    if not problems:
        ok, output = commit_all(state, commit_message(state))
        if not ok:
            problems.append(f"git commit failed (a pre-commit hook?):\n{tail(output)}")
    failed = bool(problems) and state.get("implementation_attempts", 0) >= MAX_IMPLEMENTATION_ROUNDS
    return {
        **relocked,
        "checks_feedback": "\n\n".join(problems),
        "failed": failed,
        "outcome": "failed" if failed else "",
        "history": [
            *relocked.get("history", []),
            mark(False, f"checks: {first_line(problems[0])}") if problems else mark(True, "checks: passed, committed"),
        ],
    }


def commit_message(state: BuildState) -> str:
    slices = state.get("slices") or []
    subject = slices[state.get("current_slice", 0)]["title"] if slices else card_title(state)
    if git("rev-parse", "HEAD") != state["slice_base"]:
        subject = f"address findings on {state.get('card_number') or subject}"
    return f"{commit_prefix(state)}: {subject}"[:100]


# --- review nodes (read-only, run in parallel) ---


async def code_critic(state: BuildState):
    result = await run_agent("code_critic", review_block(state, "code"), CODE_CRITIC_OUTPUT)
    out = result.output
    bugs, breaches, decisions = out["blocking_bugs"], out["standards_breaches"], out["decisions_to_escalate"]
    feedback = []
    if bugs:
        feedback.append(f"### Bugs\n{bullets(bugs)}")
    if breaches:
        feedback.append(f"### Standards breaches\n{bullets(breaches)}")
    rework = bool(feedback or decisions)
    summary = f"code review: {len(bugs)} bug(s), {len(breaches)} standards breach(es), {len(decisions)} decision(s)"
    return {
        "code_verdict": "NEEDS_REWORK" if rework else "APPROVED",
        "code_feedback": "\n\n".join(feedback),
        "code_decisions": decisions,
        "advisory": out["advisory"],
        "tech_debt": out["tech_debt"],
        "history": [mark(not rework, summary if rework else "code review: approved")],
    }


def thorough_qa(state: BuildState) -> bool:
    """Full QA for significant or hard-to-undo changes; a focused pass for routine ones."""
    return state.get("complexity") != "routine" or state.get("door") == "one-way"


def qa_depth_block(state: BuildState) -> str:
    if thorough_qa(state):
        return (
            "## Test depth: thorough\nThis change is significant or hard to undo. Automate every "
            "Automatable check, P0 first."
        )
    return (
        "## Test depth: focused\nThis is a routine change. Automate the P0 checks and the P1 checks "
        "most likely to break, at most 5 tests in all. If a check you didn't automate could plausibly "
        "break for users, add it to `manual_checks`."
    )


def qa_passed_last_round(state: BuildState) -> bool:
    """QA re-runs on a fix round only if it asked for changes. Its tests are pinned and run
    in every check, and the code critic reviews the fixes."""
    last = state.get("last_review") or {}
    return bool(last.get("head")) and not last.get("qa")


async def qa(state: BuildState):
    if qa_passed_last_round(state):
        return {
            "qa_verdict": "APPROVED",
            "qa_feedback": "",
            "qa_patch": "",
            "qa_test_command": "",
            "history": ["✓ qa: passed last round, not re-run (its tests ran in the checks)"],
        }
    patch = work_dir(state) / f"qa-{state.get('current_slice', 0)}-{state.get('implementation_attempts', 0)}.patch"
    patch.parent.mkdir(parents=True, exist_ok=True)
    patch.unlink(missing_ok=True)
    worktree = add_worktree()
    workdir = worktree / subfolder()
    extra = (
        f"## Your worktree\n`{workdir}`: your working directory, in a checkout of HEAD with the main "
        f"checkout's installed packages linked in. Work only there; never touch the main checkout at "
        f"`{ROOT}`. The pipeline removes the worktree when you finish.\n\n"
        f"## Where your tests go\nSave your test changes as a patch at `{patch}` "
        "(see 'Hand back your tests'). The pipeline applies it to the branch.\n\n"
        f"{qa_depth_block(state)}"
    )
    try:
        result = await run_agent("qa", review_block(state, "qa", extra), QA_OUTPUT, cwd=workdir)
    finally:
        remove_worktree(worktree)
    out = result.output
    gaps, bugs = out["spec_gaps"], out["real_bugs"]
    sections = [f"### {title}\n{bullets(items)}" for title, items in (("Spec gaps", gaps), ("Real bugs", bugs)) if items]
    return {
        "qa_verdict": "NEEDS_REWORK" if sections else "APPROVED",
        "qa_feedback": "\n\n".join(sections),
        "qa_patch": str(patch) if patch.is_file() else "",
        "qa_test_command": out["test_command"] if patch.is_file() else "",
        "manual_checks": out["manual_checks"],
        "history": [mark(not sections, f"qa: {len(gaps)} spec gap(s), {len(bugs)} real bug(s)" if sections else "qa: passed")],
    }


def fix_or_ship(state: BuildState):
    stray = stray_changes(state)
    if stray:
        raise BuildError(
            "Reviewers are read-only, but these files changed during review:\n"
            f"{bullets(stray)}\nInspect and discard them (e.g. `git checkout -- <file>`), then run --retry."
        )
    last_review = {"head": git("rev-parse", "HEAD"), **{key: review_findings(state, key) for key in REVIEW_LABELS}}
    update, history, applied = {"qa_patch": "", "last_review": last_review}, [], []
    if state.get("qa_patch"):
        applied, note = apply_test_patch(Path(state["qa_patch"]))
        history.append(note)
        if applied:
            update["pinned"] = {**state.get("pinned", {}), **pin(state, applied)}
        elif note.startswith("✗"):
            problem = f"QA's tests weren't added to the branch: {note.removeprefix('✗ qa: ')}"
            print(f"   ⚠️ {problem}", flush=True)
            update["advisory"] = [problem]
    if not applied:
        update["qa_test_command"] = ""
    needs_rework = any(state.get(f"{key}_verdict") == "NEEDS_REWORK" for key in REVIEW_LABELS)
    failed = needs_rework and state.get("implementation_attempts", 0) >= MAX_IMPLEMENTATION_ROUNDS
    return {**update, "failed": failed, "outcome": "failed" if failed else "", "history": history}


def failing_qa_tests(state: BuildState) -> list[str] | None:
    """Run only the tests QA just added. None when QA gave no command that runs them,
    so the caller falls back to every check. QA writes the command for the repo root, which
    isn't this folder when the pipeline lives in a subfolder."""
    command = state.get("qa_test_command", "")
    if not command.strip() or BASH_DENY["writer"].search(command):
        return None
    code, output = run(command, timeout=CHECK_TIMEOUT_S, cwd=git_top())
    if code in (126, 127) or NO_TESTS_RAN.search(output):
        return None
    print(f"   {'✅' if code == 0 else '❌'} {command}", flush=True)
    return [] if code == 0 else [f"$ {command}\n{tail(output)}"]


def recheck_qa_tests(state: BuildState, heading: str, where: str) -> dict | None:
    """QA's tests land after the checks last passed. If any did, run those tests plus the
    typecheck and lint (the rest of the code already passed every check, but a test file
    can run fine and still fail the typecheck). Every check runs when QA gave no command
    that runs its tests. Returns the update that sends the work back to the implementer,
    or None if all is green."""
    if not stray_changes(state):
        return None
    problems = failing_qa_tests(state)
    if problems is None:
        problems = failing_checks(state)
    elif not problems:
        problems = failing_commands(static_check_commands())
    if not problems:
        return None
    failed = state.get("implementation_attempts", 0) >= MAX_IMPLEMENTATION_ROUNDS
    return {
        "checks_feedback": f"{heading}\n\n" + "\n\n".join(problems),
        "failed": failed,
        "outcome": "failed" if failed else "",
        "history": [mark(False, f"{where} — {first_line(problems[0])}")],
    }


def next_slice(state: BuildState):
    index = state.get("current_slice", 0)
    title = state["slices"][index]["title"]
    sent_back = recheck_qa_tests(
        state, "The checks failed once QA's tests were added:", "next_slice: checks failed with QA's tests"
    )
    if sent_back:
        return sent_back
    ok, output = commit_all(state, f"test: QA tests for {title}")
    if not ok:
        raise BuildError(f"Couldn't commit QA's tests before the next slice:\n{tail(output)}\nFix it, then run --retry.")
    index += 1
    return {
        **cleared_reviews(),
        "current_slice": index,
        "slice_base": git("rev-parse", "HEAD"),
        "last_review": {},
        "implementer_session": "",
        "implementer_resumes": 0,
        "implementation_attempts": 0,
        # This slice's tests passed and were reviewed, so a later slice may change them (a rename,
        # a behaviour the plan changes). They still run in every check, and the code review
        # flags any change that weakens them.
        "pinned": {},
        "unpinned": {},
        "pause_options": [],
        "tests": "",
        "test_attempts": 0,
        "test_feedback": "",
        "history": [f"• slice {index + 1}/{len(state['slices'])}: {state['slices'][index]['title']}"],
    }


# --- wrap-up nodes ---


def pr_body(state: BuildState) -> str:
    """The PR description, in the sections of .github/pull_request_template.md."""
    card = f"{state.get('card_number') or 'Ad-hoc request'}: {first_line(state.get('card_details', ''), 120)}"
    if state.get("repro"):
        before = f"The bug reproduced with a failing test: {first_line(state['repro'], 200)}"
    elif state.get("tests"):
        before = f"The new tests failed, because the behaviour didn't exist yet: {first_line(state['tests'], 200)}"
    else:
        before = "No new test could fail first for this change."
    checks = ", ".join(f"`{command}`" for command in check_commands())
    door = state.get("door")
    sections = [
        ("Problem", bullets(state.get("problem", []))),
        ("Task", bullets([f"Card: {card}", *state.get("task", [])])),
        ("Solution", bullets(state.get("solution", []))),
        ("Evidence", bullets([
            f"**Before:** {before}",
            f"**After:** {checks} pass, and the code review and QA both approved.",
        ])),
        ("Merge danger", bullets([
            f"**Plan:** {PLAN_APPROVALS.get(state.get('plan_decision'), 'approved')}",
            f"**Door:** {DOORS[door] if door else 'not assessed'}",
            f"**Blast radius:** {state.get('blast_radius') or 'not assessed'}",
            *state.get("risks", []),
            *(f"**Decided during the build:** {' '.join(decision.split())}" for decision in state.get("user_decisions", [])),
        ])),
    ]
    if state.get("manual_checks"):
        sections.append(("Manual checks", "\n".join(f"- [ ] {check}" for check in state["manual_checks"])))
    follow_ups = [
        *(f"Tech debt: {t['title']}: {t['problem']}" for t in state.get("tech_debt", [])),
        *state.get("advisory", []),
    ]
    if follow_ups:
        sections.append(("Follow-ups", bullets(follow_ups)))
    return "\n\n".join(f"## {title}\n\n{body}" for title, body in sections) + "\n"


def gh_ready() -> bool:
    return shutil.which("gh") is not None and run(["gh", "auth", "status"], timeout=30)[0] == 0


def pr_body_file(state: BuildState) -> Path:
    return work_dir(state) / "pr-body.md"


def compare_url(base: str, branch: str) -> str:
    """GitHub's "open a pull request" page for the branch. A cloud session's origin is a
    local proxy, but its path still ends in <owner>/<repo>."""
    code, remote = run(["git", "remote", "get-url", "origin"])
    match = re.search(r"[/:]([^/:]+)/([^/]+?)(?:\.git)?/?$", remote.strip()) if code == 0 else None
    if not match:
        return ""
    return f"https://github.com/{match.group(1)}/{match.group(2)}/compare/{base}...{branch}?expand=1"


def ship(state: BuildState):
    # A failure goes back to the implementer, and its fix gets checked and reviewed again.
    sent_back = recheck_qa_tests(state, "The final checks before pushing failed:", "ship: final checks failed, nothing pushed")
    if sent_back:
        return sent_back
    branch, base = state["branch"], state["base_branch"]
    if branch == base:
        return {"outcome": "ship_error", "pr_error": f"Won't push: the build is on {base}, the branch the PR goes into."}
    ok, output = commit_all(state, f"test: add QA tests for {state.get('card_number') or 'build'}")
    if not ok:
        return {"outcome": "ship_error", "pr_error": f"git commit failed:\n{tail(output)}"}
    title = f"{commit_prefix(state)}: {card_title(state)}"[:72]
    push = ["push", "-u", "origin", branch]
    if state.get("replaced_push"):
        # A replan threw away this pushed work: replace it only if nobody pushed on top since.
        push.insert(2, f"--force-with-lease={branch}:{state['replaced_push']}")
    try:
        git(*push)
    except subprocess.CalledProcessError as e:
        return {"outcome": "ship_error", "pr_error": f"{' '.join(e.cmd[:3])}\n{e.stderr or e.stdout}".strip()}
    try:
        if not gh_ready():
            # A cloud session has no `gh` (or no GitHub login for it), so whoever runs the build opens the PR.
            write_text(pr_body_file(state), pr_body(state))
            compare = compare_url(base, branch)
            return {
                "outcome": "pushed",
                "pr_title": title,
                "pr_compare_url": compare,
                "pr_error": "",
                "replaced_push": "",
                "history": [f"✓ ship: pushed {branch}; the PR needs opening"],
            }
        # Only an open PR counts: an old closed one on a reused branch name isn't this build's.
        code, existing = run(["gh", "pr", "list", "--head", branch, "--state", "open", "--json", "url", "-q", ".[].url"])
        if code == 0 and existing.strip():
            pr_url = existing.strip().splitlines()[0]
        else:
            created = subprocess.run(
                ["gh", "pr", "create", "--base", base, "--head", branch, "--title", title, "--body", pr_body(state)],
                cwd=ROOT, check=True, capture_output=True, text=True,
            )
            pr_url = created.stdout.strip().splitlines()[-1]
    except subprocess.CalledProcessError as e:
        return {
            "outcome": "ship_error",
            "pr_error": f"{' '.join(e.cmd[:3])}\n{e.stderr or e.stdout}".strip(),
            "replaced_push": "",
        }
    return {"outcome": "shipped", "pr_url": pr_url, "pr_error": "", "replaced_push": "", "history": [f"✓ ship: {pr_url}"]}


# --- routing ---


def after_designer(state: BuildState):
    if state.get("clarify_questions"):
        return "clarify"
    if state.get("validity") != "VALID":
        return "sign_off"
    return "plan_critic"


def after_critic(state: BuildState):
    if state.get("plan_verdict") == "NEEDS REWORK" and state.get("plan_attempts", 0) < MAX_PLAN_ATTEMPTS:
        return "designer"
    return "sign_off"


def after_sign_off(state: BuildState):
    return {"APPROVED": "prepare_branch", "AUTO_APPROVED": "prepare_branch", "CLOSED": END, "STOPPED": END}.get(
        state.get("plan_decision"), "designer"
    )


def after_clarify(state: BuildState):
    return END if state.get("outcome") == "stopped" else "designer"


def after_prepare_branch(state: BuildState):
    return "reproducer" if is_bug(state) else "test_writer"


def after_reproducer(state: BuildState):
    if state.get("escalation"):
        return "escalation"
    if state.get("test_feedback"):
        return "reproducer"
    return "implementer"


def after_test_writer(state: BuildState):
    if state.get("escalation"):
        return "escalation"
    if state.get("test_feedback"):
        return "test_writer"
    return "implementer"


def after_implementer(state: BuildState):
    return "escalation" if state.get("escalation") else "checks"


def after_escalation(state: BuildState):
    if state.get("outcome") == "stopped":
        return END
    return state.get("escalation_next") or "implementer"


def after_checks(state: BuildState):
    if not state.get("checks_feedback"):
        return REVIEWERS
    return END if state.get("failed") else "implementer"


def after_review(state: BuildState):
    if any(state.get(f"{key}_verdict") == "NEEDS_REWORK" for key in REVIEW_LABELS):
        return END if state.get("failed") else "implementer"
    if state.get("current_slice", 0) + 1 < len(state.get("slices") or []):
        return "next_slice"
    return "ship"


def back_to_implementer(state: BuildState, otherwise: str):
    if not state.get("checks_feedback"):
        return otherwise
    return END if state.get("failed") else "implementer"


def after_next_slice(state: BuildState):
    return back_to_implementer(state, "test_writer")


def after_ship(state: BuildState):
    return back_to_implementer(state, END)


# --- graph ---

builder = StateGraph(BuildState)
for name, node in [
    ("designer", designer),
    ("plan_critic", plan_critic),
    ("reproducer", reproducer),
    ("test_writer", test_writer),
    ("implementer", implementer),
    ("code_critic", code_critic),
    ("qa", qa),
]:
    builder.add_node(name, announce(name, node), retry_policy=AGENT_RETRY)
for name, node in [
    ("clarify", clarify),
    ("sign_off", sign_off),
    ("prepare_branch", prepare_branch),
    ("escalation", escalation),
    ("checks", checks),
    ("fix_or_ship", fix_or_ship),
    ("next_slice", next_slice),
    ("ship", ship),
]:
    builder.add_node(name, announce(name, node))

builder.add_edge(START, "designer")
builder.add_edge(REVIEWERS, "fix_or_ship")

builder.add_conditional_edges("designer", after_designer)
builder.add_conditional_edges("clarify", after_clarify)
builder.add_conditional_edges("plan_critic", after_critic)
builder.add_conditional_edges("sign_off", after_sign_off)
builder.add_conditional_edges("prepare_branch", after_prepare_branch)
builder.add_conditional_edges("reproducer", after_reproducer)
builder.add_conditional_edges("test_writer", after_test_writer)
builder.add_conditional_edges("implementer", after_implementer)
builder.add_conditional_edges("escalation", after_escalation)
builder.add_conditional_edges("checks", after_checks)
builder.add_conditional_edges("fix_or_ship", after_review)
builder.add_conditional_edges("next_slice", after_next_slice)
builder.add_conditional_edges("ship", after_ship)


# --- cli ---
#
# Usage:
#   python3 build_graph.py --card WHIT-123 --type Feature --details-file card.md   → build a card
#   python3 build_graph.py "add a chat button for spending"                       → ad-hoc request
#   python3 build_graph.py --thread WHIT-123 --resume "go"                         → answer a pause
#   python3 build_graph.py --thread WHIT-123 --status                              → where is it?
#   python3 build_graph.py --thread WHIT-123 --retry                               → re-run a step that errored
#   python3 build_graph.py --thread WHIT-123 --recheck                             → after fixing a failed build by hand
#   add --unpin <test file> to --recheck when the user approved changing that locked test
#   python3 build_graph.py --thread WHIT-123 --replan "<what to change>"           → stop it, even mid-run, and replan
#   python3 build_graph.py --thread WHIT-123 --cancel                              → stop it, even mid-run, and end it
#   python3 build_graph.py --thread WHIT-123 --clean-backups                       → delete the backup branches replans left, once the ticket is done
#   add --restart to a new build to discard saved progress for that card
#   add --branch <name> to build on a given branch; a cloud session must pass its own
#   add --review-plan to pause for sign-off even when the card is routine
#
# Use .venv/bin/python instead of python3 when the repo has a .venv.
#
# Without --card, the request text is the card, and the thread ID is a short
# hash of it. Everything the pipeline writes lives in .build/ (kept out of git).


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Build one card: plan → tests → code → checks → review → PR.")
    parser.add_argument("request", nargs="?", help="ad-hoc request text, instead of --card")
    parser.add_argument("--card", help="card number, e.g. WHIT-123; also names the build thread")
    parser.add_argument("--type", default="Feature", help="card type: sets the branch prefix and the bug path")
    details = parser.add_mutually_exclusive_group()
    details.add_argument("--details", help="card title and description")
    details.add_argument("--details-file", help="read the card title and description from a file ('-' for stdin)")
    parser.add_argument("--thread", help="build thread ID (defaults to the card number)")
    parser.add_argument("--branch", help="branch to build and push on; in a cloud session, the session's own branch")
    parser.add_argument("--restart", action="store_true", help="discard saved progress and start over")
    parser.add_argument(
        "--review-plan", action="store_true", help="always pause for sign-off, even on a routine card"
    )
    action = parser.add_mutually_exclusive_group()
    action.add_argument("--resume", metavar="REPLY", help="answer the question a paused build is waiting on")
    action.add_argument(
        "--resume-answer", action="store_true",
        help="answer it with the picks the user made in the question box (.build/<thread>/answer.json)",
    )
    action.add_argument("--status", action="store_true", help="show where a build is")
    action.add_argument("--retry", action="store_true", help="re-run the step that stopped with an error")
    action.add_argument("--recheck", action="store_true", help="re-run checks and reviews after fixing a failed build")
    action.add_argument(
        "--replan", metavar="FEEDBACK",
        help="stop the build (even while it runs), throw away its unfinished work and send the plan back",
    )
    action.add_argument("--cancel", action="store_true", help="stop the build (even while it runs) and end it")
    action.add_argument(
        "--clean-backups", action="store_true", help="delete the backup branches replans left, once the build is done"
    )
    parser.add_argument(
        "--unpin", action="append", metavar="TEST_FILE",
        help="with --recheck: a locked test file the user approved changing (repeat for more)",
    )
    parser.add_argument(
        "--allow-api-billing", action="store_true",
        help="run even though an API key is set, so every token is billed (the user's call only)",
    )
    args = parser.parse_args(argv)

    if args.details_file:
        args.details = sys.stdin.read() if args.details_file == "-" else Path(args.details_file).read_text()
    continuing = (
        args.resume is not None or args.replan is not None or args.cancel or args.status or args.retry or args.recheck
        or args.clean_backups or args.resume_answer
    )
    if args.request and not args.card and not continuing:
        args.thread = args.thread or hashlib.sha256(args.request.encode()).hexdigest()[:8]
    args.thread = args.thread or args.card
    if args.unpin and not args.recheck:
        parser.error("--unpin only works with --recheck; at a pause, reply \"unpin: <reason>\" instead")
    if continuing:
        if not args.thread:
            parser.error(
                "--resume, --resume-answer, --replan, --cancel, --clean-backups, --status, --retry and --recheck need --thread (or --card)"
            )
    elif args.card and not (args.details or "").strip():
        parser.error(f"--card {args.card} requires --details or --details-file (fetch the card first)")
    elif not args.card and not args.request:
        parser.error("provide a request or --card")
    return args


def rerun() -> str:
    """How to run this script again with the same Python, e.g. `.venv/bin/python build_graph.py`."""
    python = Path(sys.executable)
    shown = python.relative_to(ROOT) if python.is_relative_to(ROOT) else "python3"
    return f"{shown} build_graph.py"


def print_history(values: dict, last: int = 15):
    history = values.get("history", [])
    if history:
        print("History:")
        for line in history[-last:]:
            print(f"  {line}")
        print()


WAITING_STEPS = {"sign_off", "clarify", "escalation"}


def duration(seconds: float) -> str:
    return f"{int(seconds // 60)}m {int(seconds % 60):02d}s"


async def step_timings(graph, config) -> list[tuple[str, float, bool]]:
    """(step, seconds, waiting for the user) for each step so far, oldest first.
    A step that hasn't finished yet is timed up to now."""
    history = [snapshot async for snapshot in graph.aget_state_history(config)]
    history.reverse()
    timings = []
    for index, snapshot in enumerate(history):
        nodes = [node for node in snapshot.next if not node.startswith("__")]
        if not nodes:
            continue
        started = datetime.fromisoformat(snapshot.created_at)
        if index + 1 < len(history):
            ended = datetime.fromisoformat(history[index + 1].created_at)
        else:
            ended = datetime.now(timezone.utc)
        label = " ∥ ".join(NODE_LABELS.get(node, node) for node in nodes)
        timings.append((label, (ended - started).total_seconds(), any(node in WAITING_STEPS for node in nodes)))
    return timings


def print_timings(timings: list[tuple[str, float, bool]], unfinished: bool):
    print("Step timings:")
    last = len(timings) - 1
    for index, (label, seconds, waiting) in enumerate(timings):
        notes = []
        if waiting:
            notes.append("waiting for you")
        if unfinished and index == last:
            notes.append("so far")
        suffix = f" ({', '.join(notes)})" if notes else ""
        print(f"  {duration(seconds):>8}  {label}{suffix}")
    machine = sum(seconds for _, seconds, waiting in timings if not waiting)
    human = sum(seconds for _, seconds, waiting in timings if waiting)
    print(f"  Machine time {duration(machine)} · waiting for you {duration(human)}\n")


async def print_status(graph, config, thread: str, snapshot) -> int:
    values = snapshot.values
    if not values:
        print(f"No saved build for thread {thread}.")
        return 1
    print(f"Thread: {thread}")
    print(f"Card: {values.get('card_number') or '(ad-hoc)'} · type: {values.get('card_type', '')}")
    running = running_pid(thread)
    if running:
        print(f"Running now (process {running}): wait for it to finish or pause.")
    if snapshot.interrupts:
        print(f"Paused: waiting for your reply (--resume) to this:\n\n{snapshot.interrupts[0].value}\n")
    print(f"Next step: {', '.join(snapshot.next) or 'finished'}")
    print(f"Outcome: {values.get('outcome') or 'in progress'}")
    plan = BUILD_DIR / thread / "plan.md"
    if plan.is_file():
        print(f"Plan: {plan.relative_to(ROOT)}")
    for key, label in [("branch", "Branch"), ("pr_url", "PR"), ("pr_error", "PR error")]:
        if values.get(key):
            print(f"{label}: {values[key]}")
    print()
    timings = await step_timings(graph, config)
    if timings:
        print_timings(timings, unfinished=bool(snapshot.next))
    print_history(values)
    return 0


FINAL_HEADLINES = {
    "closed": "card closed",
    "failed": "failed",
    "stopped": "cancelled",
    "ship_error": "passed, PR failed",
    "shipped": "PR opened",
    "pushed": "branch pushed",
}


def ping_user(title: str) -> None:
    """Play herdr's needs-input sound when the build runs in a herdr pane. The user mutes
    herdr's "finished" sound, since every step's agent finishing would ping them."""
    if os.environ.get("HERDR_ENV") != "1" or not shutil.which("herdr"):
        return
    try:
        run(["herdr", "notification", "show", title, "--sound", "request"], timeout=10)
    except OSError:
        pass


def report(thread: str, result: dict) -> int:
    interrupts = result.get("__interrupt__")
    if interrupts:
        print("\n" + "=" * 60)
        print(interrupts[0].value)
        print("=" * 60)
        print(f'\nPaused. Resume with:\n  {rerun()} --thread {thread} --resume "<your reply>"')
        return 0

    outcome, code = result.get("outcome"), 0
    print("\n" + "=" * 60)
    if outcome == "closed":
        print(f"CARD CLOSED — {result.get('validity')}: {result.get('validity_evidence', '')}")
    elif outcome == "failed":
        print(f"BUILD FAILED — unresolved issues after {MAX_IMPLEMENTATION_ROUNDS} implementation rounds:")
        if result.get("checks_feedback"):
            print(f"\n## Automatic checks\n{result['checks_feedback']}")
        for key, label in REVIEW_LABELS.items():
            if result.get(f"{key}_verdict") == "NEEDS_REWORK" and result.get(f"{key}_feedback"):
                print(f"\n## {label}\n{result[f'{key}_feedback']}")
        if result.get("code_decisions"):
            print(
                "\n## Decisions for the user\nThe code took these without sign-off. Ask the user about each "
                f"one, and change the code only as they decide:\n{bullets(result['code_decisions'])}"
            )
        if result.get("pinned"):
            print(
                f"\n## Locked test files\n{bullets(sorted(result['pinned']))}\nThe recheck puts back any change to "
                "these. Change one only if the user approves, then add --unpin <that file> to the recheck."
            )
        print(f"\nFix these by hand, then re-run checks and reviews:\n  {rerun()} --thread {thread} --recheck")
        code = 1
    elif outcome == "stopped":
        print("BUILD CANCELLED — you stopped it. Nothing was shipped.")
        if result.get("branch"):
            print(f"Work so far is on branch {result['branch']}.")
    elif outcome == "ship_error":
        print(f"BUILD PASSED but opening the PR failed:\n{result.get('pr_error', '')}")
        print(f"\nFix the cause, then:\n  {rerun()} --thread {thread} --retry")
        code = 1
    elif outcome == "shipped":
        print(f"PR opened: {result['pr_url']}")
    elif outcome == "pushed":
        print("BRANCH PUSHED — open the PR: `gh` isn't available here")
        print(f"Branch: {result['branch']} → {result['base_branch']}")
        print(f"Title: {result['pr_title']}")
        print(f"Description: {pr_body_file(result).relative_to(ROOT)}")
        if result.get("pr_compare_url"):
            print(f"Open it here: {result['pr_compare_url']}")
    else:
        print("Done.")
    print("=" * 60)
    ping_user(f"/build {thread}: {FINAL_HEADLINES.get(outcome, 'done')}")
    if outcome not in ("shipped", "pushed"):  # a failed build prints these again once it ships
        return code
    if result.get("follow_ups"):
        print("\nFOLLOW-UPS THE BUILD COULDN'T DO:")
        print(bullets(result["follow_ups"]))
    if result.get("manual_checks"):
        print("\nMANUAL CHECKS (also in the PR):")
        print(bullets(result["manual_checks"]))
    if result.get("tech_debt"):
        print("\nTECH DEBT CARDS TO FILE:")
        for card in result["tech_debt"]:
            print(f"- {card['title']}: {card['problem']} → {card['fix']}")
    return code


async def start_build(graph, saver, config, snapshot, args):
    thread = args.thread
    if snapshot.values and not args.restart:
        where = ", ".join(snapshot.next) or f"finished ({snapshot.values.get('outcome') or 'no outcome'})"
        print(
            f"A build for {thread} already exists (at: {where}).\n"
            "Continue it with --resume, --retry or --recheck, or add --restart to discard it and start over."
        )
        return None
    base, current = default_branch(), git("rev-parse", "--abbrev-ref", "HEAD")
    if args.branch == base:
        print(f"--branch can't be {base}: the build opens a PR into it.")
        return None
    if in_cloud() and not args.branch and current in (base, "HEAD"):
        print(
            "This is a cloud session, and it can push only its own branch. "
            "Run again with --branch <this session's branch>."
        )
        return None
    if not check_commands():
        print(
            f"{AGENTS_FILE.name} has no ```checks block, so the build couldn't run your tests. "
            "Add one (see AGENTS-template.md), then start again."
        )
        return None
    modified = [path for status, path in git_status() if status != "??"]
    if modified:
        print(f"Commit or stash these changes before starting a build:\n{bullets(modified)}")
        return None
    if snapshot.values:
        old = snapshot.values
        if old.get("base_branch") and old.get("branch") and git("branch", "--show-current") == old["branch"]:
            git("checkout", old["base_branch"])  # the new build branches from the base, not the old attempt
            print(f"Switched to {old['base_branch']}: the discarded attempt stays on {old['branch']}.")
        await saver.adelete_thread(thread)
    shutil.rmtree(BUILD_DIR / thread, ignore_errors=True)
    write_progress(thread, started_at=time.time(), card=args.card or "")
    print(f"Starting build (thread {thread})...\n")
    return await graph.ainvoke(
        {
            "thread_id": thread,
            "card_number": args.card or "",
            "card_details": args.details if args.card else args.request,
            "card_type": args.type,
            "untracked_at_start": [path for status, path in git_status() if status == "??"],
            "requested_branch": args.branch or "",
            "always_sign_off": args.review_plan,
            "history": [],
        },
        config,
    )


async def resume_build(graph, config, snapshot, reply: str):
    if not snapshot.values:
        print("No saved build for this thread.")
        return None
    if not snapshot.interrupts:
        if snapshot.next:
            print("This build isn't waiting for a reply: it stopped mid-step. Use --retry.")
        else:
            outcome = snapshot.values.get("outcome") or "no outcome"
            print(f"This build already finished ({outcome}). After fixing a failed build by hand use --recheck; "
                  "to start over use --restart.")
        return None
    value, problem = check_reply(snapshot.values, reply)
    if value is None:
        print(f"Reply rejected: {problem}. The build is still paused on the same question.\n\n{reply_format(snapshot.values)}")
        return None
    print_history(snapshot.values)
    return await graph.ainvoke(Command(resume=value), config)


async def answer_build(graph, config, snapshot, thread: str):
    """Resume with the picks the user made in the question box, saved by the build-pause mod."""
    if not snapshot.interrupts:
        print("This build isn't waiting for a reply.")
        return None
    ask = ask_for(snapshot)
    if not ask:
        print("This question isn't asked through the question box: reply with --resume.")
        return None
    try:
        answer = json.loads(read_text(BUILD_DIR / thread / ANSWER_FILE))
    except json.JSONDecodeError:
        answer = None
    if not isinstance(answer, dict):
        print("No answers are saved for this question: ask the user in the question box, or reply with --resume.")
        return None
    reply, problem = reply_from_answer(snapshot.values, ask, answer)
    if not reply:
        print(f"Can't use the saved answers: {problem}.")
        return None
    print(f"The user's answers, as the build's reply: {reply}\n")
    return await resume_build(graph, config, snapshot, reply)


async def retry_build(graph, config, snapshot):
    if snapshot.interrupts:
        print("This build is waiting for your reply. Use --resume.")
        return None
    if snapshot.next:
        print(f"Retrying {', '.join(snapshot.next)}...\n")
        return await graph.ainvoke(None, config)
    if snapshot.values.get("outcome") == "ship_error":
        await graph.aupdate_state(config, {"outcome": "", "pr_error": ""}, as_node="fix_or_ship")
        return await graph.ainvoke(None, config)
    print("Nothing to retry: the build isn't stopped on an error.")
    return None


async def recheck_build(graph, config, snapshot, unpin: list[str]):
    values = snapshot.values
    if values.get("outcome") != "failed" or snapshot.next:
        print("Only a failed, finished build can be rechecked. Use --status to see where this one is.")
        return None
    files = pinned_paths(values, unpin)
    unknown = [path for path in unpin if repo_path(path) not in files]
    if unknown:
        print(f"{', '.join(unknown)} isn't a locked test file. Locked: {', '.join(sorted(values.get('pinned', {}))) or 'none'}.")
        return None
    await graph.aupdate_state(
        config,
        {
            **cleared_reviews(),
            **(unpin_update(values, files, "the user approved changing it after the build failed") if files else {}),
            "failed": False,
            "outcome": "",
            "implementation_attempts": 0,
            "escalation": "",
            "history": ["• recheck: re-running checks and reviews after manual fixes"],
        },
        as_node="implementer",
    )
    return await graph.ainvoke(None, config)


# --- stopping a running build ---


# --- answering a pause through the question box ---
# At each pause, progress.json carries `ask`: the pause's questions and options, with ids. The build-pause
# mod (mods/build-pause in the claude repo) asks them in the question box and saves the picks, by id, to
# .build/<thread>/answer.json; `--resume-answer` turns them into this pause's reply. So neither writing
# the options nor turning the user's picks into the reply's format is left to the chat.

MAX_ASKED = 4  # the question box holds at most 4 questions of 2-4 options each
ANSWER_FILE = "answer.json"


def lettered(options: str) -> list[dict]:
    """A decision's options, written "A) keep · B) move", as [{id, label}]."""
    parts = re.split(r"\b([A-Z])\)", options)
    return [
        {"id": letter, "label": f"{letter}) {wording.strip().strip('·,;').strip()}"}
        for letter, wording in zip(parts[1::2], parts[2::2])
    ]


def ask_for(snapshot) -> dict | None:
    """The questions this pause asks, for the question box; None when they don't fit it, so the chat asks."""
    if not snapshot.interrupts or not snapshot.next:
        return None
    values, node = snapshot.values or {}, snapshot.next[0]
    asked = hashlib.sha256(str(snapshot.interrupts[0].value).encode()).hexdigest()[:12]
    stop = {"id": "stop", "label": "Stop", "description": "End the build"}
    questions, final = [], None
    if node == "sign_off" and values.get("validity", "VALID") != "VALID":
        kind, intro = "invalid_card", invalid_brief(values, boxed=True)
        final = {
            "id": "final", "question": "Close the card? To plan it anyway, type why it's still needed.",
            "options": [{"id": "close", "label": "Close the card", "description": "It isn't needed"}, stop],
        }
    elif node == "sign_off":
        kind, intro = "sign_off", plan_brief(values, boxed=True)
        for n, decision in enumerate(values.get("decisions", []), 1):
            options = lettered(decision.get("options", ""))
            if not 2 <= len(options) <= 4:
                return None
            recommended = re.match(r"\s*\(?([A-Z])\b", decision.get("recommendation", ""))
            questions.append({
                "id": f"Q{n}", "question": decision["question"], "options": options,
                "recommended": recommended.group(1) if recommended else "",
            })
        final = {
            "id": "final", "question": "Approve the plan? To send it back, type what to change.",
            "options": [{"id": "go", "label": "Approve", "description": "Build it, with the answers above"}, stop],
        }
    elif node == "clarify":
        kind, intro = "clarify", "QUESTIONS BEFORE PLANNING: the card was too thin to plan."
        for n, item in enumerate(values.get("clarify_questions", []), 1):
            recommendation = item.get("recommendation", "")
            questions.append({
                "id": f"Q{n}", "question": item["question"], "recommended": "rec",
                "options": [
                    {"id": "rec", "label": first_line(recommendation, 60), "description": "The designer's recommendation"},
                    {"id": "designer", "label": "Let the designer decide", "description": "Use their judgement"},
                ],
            })
    elif node == "escalation" and structured_pause(values):
        kind = "decision"
        intro = f"DECISION NEEDED (from the {NODE_LABELS['implementer']})\n\n{values['escalation']}"
        options = [
            {"id": o["id"], "label": first_line(f"{o['id']}) {o['label']}", 60),
             "description": first_line(f"{o.get('what_happens', '')} Cost: {o.get('cost', '')}", 160)}
            for o in values["pause_options"]
        ]
        questions = [{
            "id": "choice", "question": "What should the build do? To answer in your own words, type it.",
            "options": options + ([stop] if len(options) < 4 else []),
            "recommended": values.get("pause_recommended", ""),
        }]
    else:
        return None
    if len(questions) + bool(final) > MAX_ASKED or not questions and not final:
        return None
    # `intro`: the block, less the questions and how to reply, which the box asks itself.
    return {"id": asked, "kind": kind, "intro": intro, "questions": questions, "final": final}


def reply_from_answer(values: dict, ask: dict, answer: dict) -> tuple[str, str]:
    """This pause's reply, made from the picks saved in answer.json; or "" and why it can't be."""
    if answer.get("id") != ask["id"]:
        return "", "these answers are for an earlier question; ask the user again"
    picks = answer.get("answers") or {}
    typed = lambda pick: pick.get("text", "").strip() if isinstance(pick, dict) else ""
    final = picks.get("final")
    if ask["kind"] in ("sign_off", "invalid_card"):
        if final == "stop":
            return "stop", ""
        if typed(final):
            return f"rework: {typed(final)}", ""
        if ask["kind"] == "invalid_card":
            return ("close", "") if final == "close" else ("", "the user didn't answer whether to close the card")
        if final != "go":
            return "", "the user didn't answer whether to approve the plan"
        parts = [f"{q['id']} {typed(picks[q['id']]) or picks[q['id']]}" for q in ask["questions"] if picks.get(q["id"])]
        return ("go: " + "; ".join(parts) if parts else "go"), ""
    if ask["kind"] == "clarify":
        answers = []
        for q, item in zip(ask["questions"], values.get("clarify_questions", [])):
            pick = picks.get(q["id"], "rec")
            words = typed(pick) or ("use your judgement" if pick == "designer" else item.get("recommendation", ""))
            answers.append(f"{q['id']}: {words}")
        return "; ".join(answers), ""
    pick = picks.get("choice")
    if pick == "stop" or is_stop(typed(pick)):
        return "stop", ""
    if typed(pick):
        return json.dumps({"pause_id": values["pause_id"], "choice": "other", "tests": "keep", "answer": typed(pick)}), ""
    if isinstance(pick, str) and pick:
        return json.dumps({"pause_id": values["pause_id"], "choice": pick}), ""
    return "", "the user didn't pick an option"


def save_pause(thread: str, snapshot) -> None:
    """Whether the build waits on the user, and the question it asks them word for word, in
    progress.json: the build-pause mod (mods/build-pause in the claude repo) puts it in front of them."""
    (BUILD_DIR / thread / ANSWER_FILE).unlink(missing_ok=True)
    if snapshot.interrupts:
        write_progress(thread, status="paused", question=snapshot.interrupts[0].value, ask=ask_for(snapshot))
    else:
        outcome = (snapshot.values or {}).get("outcome", "")
        write_progress(thread, status="finished" if outcome else "stopped", outcome=outcome, question="", ask=None)


def last_save_file(thread: str) -> Path:
    return BUILD_DIR / thread / "last-save"


def record_saves(saver) -> None:
    """Note each save this build writes, so a save written by anything else shows up (see changed_elsewhere)."""
    put = saver.aput

    async def aput(config, checkpoint, metadata, new_versions):
        saved = await put(config, checkpoint, metadata, new_versions)
        write_text(last_save_file(saved["configurable"]["thread_id"]), saved["configurable"]["checkpoint_id"])
        return saved

    saver.aput = aput


def changed_elsewhere(thread: str, snapshot) -> bool:
    """Whether the thread's latest save isn't the last one the build wrote: something else changed its
    saved progress. A repair session the user opened (`ticket repair`) may, and its changes are accepted."""
    recorded = read_text(last_save_file(thread)).strip()
    latest = (snapshot.config or {}).get("configurable", {}).get("checkpoint_id", "")
    if not recorded or not latest or recorded == latest:
        return False
    if os.environ.get("ALLOW_BUILD_REPAIR") == "1":
        write_text(last_save_file(thread), latest)
        return False
    return True


def pid_file(thread: str) -> Path:
    return BUILD_DIR / f"{thread}.pid"


def alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    code, stat = run(["ps", "-o", "stat=", "-p", str(pid)])
    return code == 0 and not stat.strip().startswith("Z")


def running_pid(thread: str) -> int | None:
    """The process ID of a build of this thread that's still running, if there is one."""
    text = read_text(pid_file(thread)).strip()
    pid = int(text) if text.isdigit() else None
    if not pid or pid == os.getpid() or not alive(pid):
        return None
    # A pid file left by a killed build may name a process that later got the same number.
    code, command = run(["ps", "-o", "command=", "-p", str(pid)])
    return pid if code == 0 and "build_graph" in command else None


def take_lock(thread: str, running: int | None) -> bool:
    """Record this run as the thread's build. False if another run took it first."""
    path = pid_file(thread)
    path.parent.mkdir(parents=True, exist_ok=True)
    try:
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | (os.O_TRUNC if running else os.O_EXCL))
    except FileExistsError:
        if running_pid(thread):  # another run took it since `running` was read
            return False
        path.unlink(missing_ok=True)  # stale: its build is gone
        try:
            fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL)
        except FileExistsError:
            return False
    with os.fdopen(fd, "w") as f:
        f.write(str(os.getpid()))
    return True


def descendants(pid: int) -> list[int]:
    code, out = run(["pgrep", "-P", str(pid)])
    children = [int(child) for child in out.split()] if code == 0 else []
    return [found for child in children for found in (child, *descendants(child))]


def stop_process_tree(pid: int) -> None:
    """Stop the build and everything it started (agents, test runs), so nothing keeps
    editing files after its work is thrown away."""
    targets = [pid, *descendants(pid)]
    for target in targets:
        with contextlib.suppress(ProcessLookupError):
            os.kill(target, signal.SIGTERM)
    deadline = time.monotonic() + 10
    while time.monotonic() < deadline and any(alive(target) for target in targets):
        time.sleep(0.2)
    for target in targets:
        with contextlib.suppress(ProcessLookupError):
            if alive(target):
                os.kill(target, signal.SIGKILL)


def discard_build_work(state: BuildState, to: str) -> None:
    """Reset the branch to `to` and delete the files the build created but didn't commit."""
    for line in git("worktree", "list", "--porcelain").splitlines():
        path = line.removeprefix("worktree ")
        if line.startswith("worktree ") and "build-qa-" in path:
            remove_worktree(Path(path))
    lock = Path(git("rev-parse", "--git-path", "index.lock"))
    (lock if lock.is_absolute() else ROOT / lock).unlink(missing_ok=True)  # left by a killed commit
    git("reset", "--hard", to)
    top = git_top()
    for path in stray_changes(state):
        (top / path).unlink(missing_ok=True)


def remote_tip(branch: str) -> str:
    """The commit the branch points at on origin, or "" if it isn't there."""
    code, output = run(["git", "ls-remote", "origin", f"refs/heads/{branch}"], timeout=30)
    if code != 0 or not output.strip():
        return ""
    return output.split()[0]


def pr_exists(branch: str) -> bool | None:
    """Whether an open or merged PR was opened from the branch. None if it can't tell."""
    if gh_ready():
        code, output = run(
            ["gh", "pr", "list", "--head", branch, "--state", "all", "--json", "url,state",
             "-q", '.[] | select(.state != "CLOSED") | .url'],
            timeout=30,
        )
        if code != 0:
            return None
        return bool(output.strip())
    # Without gh, GitHub's refs/pull/<n>/head refs show which commits have a PR.
    tip = remote_tip(branch)
    if not tip:
        return None
    code, output = run(["git", "ls-remote", "origin", "refs/pull/*/head"], timeout=30)
    if code != 0 or not output.strip():
        return None
    return any(line.split()[0] == tip for line in output.splitlines())


def pushed_by_build(values: dict) -> bool | None:
    """Whether the build's own commits are on origin. A branch that was already pushed before the
    build started doesn't count. None if origin can't be reached."""
    if values.get("outcome") == "pushed":
        return True
    branch, base = values.get("branch"), values.get("build_base")
    if not branch or not base:
        return False
    code, output = run(["git", "ls-remote", "--exit-code", "--heads", "origin", branch], timeout=30)
    if code == 2:
        return False
    if code != 0 or not output.strip():
        return None
    return run(["git", "merge-base", "--is-ancestor", output.split()[0], base])[0] != 0


def stop_running_build(values: dict, pid: int | None, replan: bool = False, before_stop=None) -> bool:
    """Stop the build of this thread running as `pid`, if any. False if it can't be stopped any more.
    A replan may still throw away pushed work, as long as no PR was opened from it. `before_stop`
    runs once every check has passed but before anything is stopped; if it fails, nothing is."""
    if not values:
        print("No saved build for this thread.")
        return False
    outcome = values.get("outcome")
    if outcome in ("shipped", "closed", "stopped") or (outcome == "pushed" and not replan):
        print("This build already finished. Open a new card for the change, or change the PR directly.")
        return False
    branch = values.get("branch")
    pushed = pushed_by_build(values)
    if pushed is None:
        print(f"Couldn't reach origin to check whether {branch} was pushed, so nothing was changed.")
        return False
    if pushed and not replan:
        print(f"Branch {branch} is already pushed, so its work can't be thrown away. Change the PR directly.")
        return False
    if pushed:
        found = pr_exists(branch)
        if found:
            print(f"A PR exists for {branch}. Change the PR directly.")
            return False
        if found is None:
            print(f"Couldn't check GitHub for a PR on {branch}, so nothing was changed.")
            return False
    if not safe_to_discard(values, pid):
        return False
    if before_stop:
        try:
            before_stop()
        except subprocess.CalledProcessError as e:
            print(f"`{' '.join(e.cmd)}` failed, so nothing was changed:\n{e.stderr or e.output or ''}")
            return False
    if pid:
        print("⏹ Stopping the running build…", flush=True)
        stop_process_tree(pid)
    return True


def safe_to_discard(values: dict, pid: int | None) -> bool:
    """Whether throwing the build's work away can only touch the build's own work."""
    branch, current = values.get("branch"), git("branch", "--show-current")
    if values.get("build_base") and branch and current != branch:
        print(f"You're on {current or 'a detached HEAD'}, not the build's branch {branch}. "
              f"Check out {branch} first, so nothing else is thrown away.")
        return False
    changes = stray_changes(values) if values.get("build_base") and not pid else []
    if changes:
        print("The build isn't running, so these uncommitted changes aren't its half-written work. "
              f"Commit, stash or delete them first:\n{bullets(changes)}")
        return False
    return True


async def cancel_build(graph, config, snapshot, pid: int | None):
    values = snapshot.values
    if not stop_running_build(values, pid):
        return None
    if values.get("build_base"):
        discard_build_work(values, "HEAD")  # keep what was committed, drop what was half-written
    await graph.aupdate_state(config, stopped("cancel"), as_node="clarify")  # clarify ends a stopped build
    return (await graph.aget_state(config)).values


def keep_pushed_work(branch: str) -> dict:
    """Back up the branch's pushed tip locally, and record it so the re-ship replaces only that."""
    tip = remote_tip(branch) if branch else ""
    if not tip:
        return {}
    git("fetch", "origin", branch)  # the tip may not be local if someone else pushed it
    backup = f"{branch}-before-replan-{tip[:7]}"
    git("branch", "-f", backup, tip)
    print(f"🗄 Kept the pushed work on {backup}. Delete it with --clean-backups once the ticket is done.", flush=True)
    return {"replaced_push": tip}


async def replan_build(graph, config, snapshot, feedback: str, pid: int | None):
    values = snapshot.values
    kept = {}
    if not stop_running_build(values, pid, replan=True, before_stop=lambda: kept.update(keep_pushed_work(values.get("branch", "")))):
        return None
    if values.get("build_base"):
        discard_build_work(values, values["build_base"])
        print("🗑 Threw away the unfinished work", flush=True)
    await graph.aupdate_state(
        config,
        {
            **cleared_reviews(),
            "plan_decision": "REJECTED",
            "plan_feedback": feedback,
            "plan_attempts": 0,
            "always_sign_off": True,
            "sign_off_answers": "",
            "clarify_questions": [],
            "escalation": "",
            "escalation_answer": "",
            "escalation_next": "",
            "pinned": {},
            "unpinned": {},
            "pause_options": [],
            "user_decisions": [],
            "repro": "",
            "repro_command": "",
            "tests": "",
            "test_attempts": 0,
            "test_feedback": "",
            "implementer_session": "",
            "implementer_resumes": 0,
            "implementation_attempts": 0,
            "implementation": "",
            "last_review": {},
            "current_slice": 0,
            "qa_patch": "",
            "qa_test_command": "",
            "failed": False,
            "outcome": "",
            "pr_error": "",
            "pr_title": "",
            "pr_compare_url": "",
            **kept,
            "advisory": None,
            "tech_debt": None,
            "manual_checks": None,
            "follow_ups": None,
            "history": [f"↩️ replan: {first_line(feedback)}"],
        },
        as_node="sign_off",
    )
    print("↩️ Sending the plan back to the designer with your changes", flush=True)
    return await graph.ainvoke(None, config)


def clean_backups(values: dict, branch: str | None = None) -> int:
    """Delete the local backup branches replans left, once the build is done. With no saved
    build (e.g. its worktree was removed), --branch names the build's branch."""
    if not values and not branch:
        print("No saved build for this thread. Add --branch <the build's branch> to delete its backups.")
        return 1
    if values and values.get("outcome") not in ("shipped", "pushed", "closed", "stopped"):
        print("This build isn't done yet, so its backups are kept.")
        return 1
    branch = branch or values.get("branch")
    if not branch:
        print("No backup branches: this build never made a branch.")
        return 0
    backups = git("branch", "--list", f"{branch}-before-replan-*", "--format=%(refname:short)").splitlines()
    if not backups:
        print(f"No backup branches for {branch}.")
        return 0
    for backup in backups:
        git("branch", "-D", backup)
        print(f"🗑 Deleted {backup}")
    return 0


async def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    for name in PARENT_SESSION_VARS:
        os.environ.pop(name, None)
    paid = paid_auth_var()
    if paid and not args.allow_api_billing and not args.status:
        print(
            f"{paid} is set, so every agent in this build would be billed per token instead of "
            "using your Claude plan. Unset it to use your plan, or add --allow-api-billing if "
            "per-token billing is what you want."
        )
        return 1
    if paid and not args.status:
        print(f"⚠️ {paid} is set, so this build is billed per token, not to your Claude plan.\n")
    if not AGENTS_FILE.is_file():
        print(f"Missing {AGENTS_FILE.name}: copy AGENTS-template.md and fill it in.")
        return 1
    # Claude Code skips AGENTS.md beside a CLAUDE.md, so the agents would never see it.
    claude_md = read_text(ROOT / "CLAUDE.md")
    if claude_md and "@AGENTS.md" not in claude_md:
        print("CLAUDE.md doesn't import AGENTS.md, so the agents won't read it. Add an `@AGENTS.md` line to CLAUDE.md.")
        return 1
    BUILD_DIR.mkdir(exist_ok=True)
    exclude_build_dir()
    config = {"configurable": {"thread_id": args.thread}}
    async with AsyncSqliteSaver.from_conn_string(str(DB_PATH)) as saver:
        await saver.setup()
        record_saves(saver)
        graph = builder.compile(checkpointer=saver)
        snapshot = await graph.aget_state(config)
        if args.status:
            return await print_status(graph, config, args.thread, snapshot)
        running = running_pid(args.thread)  # read before this run takes the lock
        if running and args.replan is None and not args.cancel:
            print(f"A build of {args.thread} is already running. Wait for it, or stop it with --replan or --cancel.")
            return 1
        if args.clean_backups:
            return clean_backups(snapshot.values, args.branch)
        if not args.restart and changed_elsewhere(args.thread, snapshot):
            print(
                f"{args.thread}'s saved progress was changed by something other than the build, so it won't run "
                "on it. If that was a deliberate repair, run this command from the repair session "
                f"(`ticket repair {args.thread}`); otherwise start over with --restart."
            )
            return 1
        if not take_lock(args.thread, running):
            print(f"Another run of {args.thread} just started. Wait for it, or stop it with --replan or --cancel.")
            return 1
        try:
            if args.replan is not None:
                result = await replan_build(graph, config, snapshot, args.replan, running)
            elif args.cancel:
                result = await cancel_build(graph, config, snapshot, running)
            elif args.resume is not None:
                result = await resume_build(graph, config, snapshot, args.resume)
            elif args.resume_answer:
                result = await answer_build(graph, config, snapshot, args.thread)
            elif args.retry:
                result = await retry_build(graph, config, snapshot)
            elif args.recheck:
                result = await recheck_build(graph, config, snapshot, args.unpin or [])
            else:
                result = await start_build(graph, saver, config, snapshot, args)
        except Exception as e:  # noqa: BLE001 — every failure gets the same --retry advice
            if not isinstance(e, (BuildError, AgentError)):
                traceback.print_exc()
            stopped = await graph.aget_state(config)
            save_pause(args.thread, stopped)
            print("\n" + "=" * 60)
            print(f"BUILD STOPPED at {', '.join(stopped.next) or 'the end'}:\n{e}")
            print("=" * 60)
            ping_user(f"/build {args.thread}: stopped")
            print(f"\nFix the cause, then run:\n  {rerun()} --thread {args.thread} --retry")
            return 1
        finally:
            if read_text(pid_file(args.thread)).strip() == str(os.getpid()):
                pid_file(args.thread).unlink()
        if result is None:
            return 1
        save_pause(args.thread, await graph.aget_state(config))
        return report(args.thread, result)


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
