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
#                         └→ standards ∥ spec ∥ correctness ∥ qa → fix_or_ship
# fix_or_ship ─┬→ implementer                                   findings, rounds left
#              ├→ next_slice → test_writer                      more slices to build
#              └→ retro → retro_review (pause, if proposals) → ship → END
#                                                   (END instead of ship when the build failed)
import argparse
import asyncio
import hashlib
import operator
import os
import re
import shutil
import subprocess
import sys
import traceback
from dataclasses import dataclass
from pathlib import Path
from typing import Annotated, NotRequired, TypedDict

from claude_agent_sdk import (
    AssistantMessage,
    ClaudeAgentOptions,
    CLIConnectionError,
    HookMatcher,
    ProcessError,
    ResultError,
    ResultMessage,
    ToolUseBlock,
    query,
)
from langgraph.checkpoint.sqlite.aio import AsyncSqliteSaver
from langgraph.graph import END, START, StateGraph
from langgraph.types import Command, RetryPolicy, interrupt


class BuildState(TypedDict):
    thread_id: str
    card_number: str
    card_details: str
    card_type: NotRequired[str]
    untracked_at_start: NotRequired[list[str]]
    requested_branch: NotRequired[str]
    history: Annotated[list[str], operator.add]
    cost_usd: Annotated[float, operator.add]
    # planning
    validity: NotRequired[str]
    validity_evidence: NotRequired[str]
    clarify_questions: NotRequired[list[dict]]
    clarify_answers: NotRequired[str]
    clarify_rounds: NotRequired[int]
    plan: NotRequired[str]
    summary: NotRequired[str]
    seams: NotRequired[list[str]]
    decisions: NotRequired[list[dict]]
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
    slice_base: NotRequired[str]
    current_slice: NotRequired[int]
    # tests
    repro: NotRequired[str]
    tests: NotRequired[str]
    test_attempts: NotRequired[int]
    test_feedback: NotRequired[str]
    pinned: NotRequired[dict[str, str]]
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
    # review
    standards_verdict: NotRequired[str]
    standards_feedback: NotRequired[str]
    standards_advisory: NotRequired[list[str]]
    tech_debt: NotRequired[list[dict]]
    spec_verdict: NotRequired[str]
    spec_feedback: NotRequired[str]
    correctness_verdict: NotRequired[str]
    correctness_feedback: NotRequired[str]
    correctness_minor: NotRequired[list[str]]
    context_updates: NotRequired[list[str]]
    qa_verdict: NotRequired[str]
    qa_feedback: NotRequired[str]
    qa_patch: NotRequired[str]
    manual_checks: NotRequired[list[str]]
    # wrap-up
    retro_proposals: NotRequired[list[dict]]
    lint_ideas: NotRequired[list[str]]
    failed: NotRequired[bool]
    outcome: NotRequired[str]
    pr_url: NotRequired[str]
    pr_error: NotRequired[str]


# --- settings ---

ROOT = Path(__file__).resolve().parent
BUILD_DIR = ROOT / ".build"
DB_PATH = BUILD_DIR / "build_graph.db"
PROJECT_CONTEXT_FILE = ROOT / "project-context.md"

DEFAULT_MODEL = "claude-opus-5-5"
MAX_CLARIFY_ROUNDS = 2
MAX_PLAN_ATTEMPTS = 2
MAX_TEST_ATTEMPTS = 2
MAX_IMPLEMENTATION_ROUNDS = 5
MAX_SESSION_RESUMES = 2
CHECK_TIMEOUT_S = 900

APPROVALS = {"go", "approve", "approved", "yes", "y", "lgtm", "ok"}
STOPS = {"stop", "cancel", "abort"}
BUG_TYPES = {"bug", "defect"}
TYPE_TO_PREFIX = {
    "story": "feat", "feature": "feat",
    "bug": "fix", "defect": "fix",
    "chore": "chore",
    "refactor": "refactor",
    "docs": "docs", "test": "chore",
    "tech debt": "chore",
}

REVIEWERS = ["standards_critic", "spec_critic", "correctness_critic", "qa"]
REVIEW_LABELS = {
    "standards": "Standards review",
    "spec": "Spec review",
    "correctness": "Correctness review",
    "qa": "QA",
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
    "standards_critic": "Standards Review",
    "spec_critic": "Spec Review",
    "correctness_critic": "Correctness Review",
    "qa": "QA",
    "fix_or_ship": "Fix or Ship",
    "next_slice": "Next Slice",
    "retro": "Retro",
    "retro_review": "Retro Review",
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

# Turn and spend caps stop a stuck agent. Raise them if big cards hit them.
AGENTS = {
    "designer": Agent("solution-designer.md", READ, "read_only", 80, 10.0),
    "plan_critic": Agent("solution-critic.md", READ, "read_only", 60, 6.0),
    "reproducer": Agent("reproducer.md", WRITE, "writer", 120, 12.0),
    "test_writer": Agent("test-writer.md", WRITE, "writer", 80, 8.0),
    "implementer": Agent("implementer.md", WRITE, "writer", 200, 25.0),
    "standards_critic": Agent("standards-critic.md", READ, "read_only", 50, 5.0),
    "spec_critic": Agent("spec-critic.md", READ, "read_only", 50, 5.0),
    "correctness_critic": Agent("correctness-critic.md", READ, "read_only", 60, 6.0),
    "qa": Agent("qa.md", WRITE, "qa", 150, 15.0),
    "retro": Agent("retro.md", READ, "read_only", 30, 3.0),
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


DESIGNER_OUTPUT = _output(
    validity=_one_of("VALID", "ALREADY DONE", "DEAD CODE", "WRONG PREMISE", "ALREADY COVERED"),
    validity_evidence=TEXT,
    clarifying_questions=_list_of(question=TEXT, recommendation=TEXT),
    summary=TEXT,
    seams=TEXTS,
    decisions=_list_of(question=TEXT, options=TEXT, recommendation=TEXT),
    slices=_list_of(title=TEXT, delivers=TEXT),
    plan=TEXT,
)
CRITIC_OUTPUT = _output(
    verdict=_one_of("SOLID", "SOLID WITH TWEAKS", "NEEDS REWORK"),
    top_findings=TEXTS,
    tweaks=TEXTS,
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
IMPLEMENTER_OUTPUT = _output(status=_one_of("DONE", "ESCALATE"), summary=TEXT, escalation=TEXT)
STANDARDS_OUTPUT = _output(
    blocking=TEXTS,
    advisory=TEXTS,
    tech_debt=_list_of(title=TEXT, problem=TEXT, fix=TEXT),
    report=TEXT,
)
SPEC_OUTPUT = _output(missing=TEXTS, wrong=TEXTS, scope_creep=TEXTS, report=TEXT)
CORRECTNESS_OUTPUT = _output(
    blocking_bugs=TEXTS,
    minor_bugs=TEXTS,
    decisions_to_escalate=TEXTS,
    context_updates=TEXTS,
    report=TEXT,
)
QA_OUTPUT = _output(real_bugs=TEXTS, manual_checks=TEXTS, patch_written={"type": "boolean"}, report=TEXT)
RETRO_OUTPUT = _output(
    context_additions=_list_of(
        section=_one_of("Known landmines", "Coding standards", "Glossary"), text=TEXT
    ),
    lint_ideas=TEXTS,
    notes=TEXT,
)


# --- guards ---
#
# The pipeline owns git: no agent commits, pushes or switches branches.
# Planning and review agents are read-only; QA writes only in its own worktree.
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
    "qa": re.compile("|".join(_NEVER)),
}


def _deny(reason: str) -> dict:
    return {
        "hookSpecificOutput": {
            "hookEventName": "PreToolUse",
            "permissionDecision": "deny",
            "permissionDecisionReason": reason,
        }
    }


def guard_hooks(policy: str) -> dict[str, list[HookMatcher]]:
    denied = BASH_DENY[policy]

    async def guard_bash(hook_input, _tool_use_id, _context):
        command = hook_input["tool_input"].get("command", "")
        if denied.search(command):
            return _deny(f"Blocked for a {policy} agent: `{command[:120]}`. The pipeline owns git.")
        return {}

    matchers = [HookMatcher(matcher="Bash", hooks=[guard_bash])]
    if policy == "qa":

        async def guard_writes(hook_input, _tool_use_id, _context):
            tool_input = hook_input["tool_input"]
            path = Path(tool_input.get("file_path") or tool_input.get("notebook_path") or ".").resolve()
            if path.is_relative_to(ROOT) and not path.is_relative_to(BUILD_DIR):
                return _deny("QA writes only in its own worktree, never in the main checkout.")
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
    cost: float


TRANSIENT_STATUSES = {408, 429, 500, 502, 503, 504, 529}


def _transient(terminal_reason: str | None, status: int | None) -> bool:
    return terminal_reason == "api_error" or status in TRANSIENT_STATUSES


# Retry an agent step once on API hiccups; anything else stops the build.
AGENT_RETRY = RetryPolicy(max_attempts=2, retry_on=lambda e: getattr(e, "transient", False))


def agent_prompt(prompt_file: str) -> str:
    return (ROOT / ".claude" / "agents" / prompt_file).read_text() + "\n\n" + read_text(PROJECT_CONTEXT_FILE)


def print_progress(message):
    if isinstance(message, AssistantMessage):
        for block in message.content:
            if isinstance(block, ToolUseBlock):
                print(f"  → {block.name}", flush=True)


async def run_agent(name: str, prompt: str, output_format: dict, resume: str | None = None) -> AgentResult:
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
        cwd=str(ROOT),
        resume=resume,
        # The repo's own CLAUDE.md and settings, but not the user's global plugins,
        # MCP servers, hooks and preferences, which bloat every turn and hand
        # read-only agents write tools (e.g. a Notion MCP).
        setting_sources=["project"],
        strict_mcp_config=True,
    )
    result = None
    try:
        async for message in query(prompt=prompt, options=options):
            print_progress(message)
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
    return AgentResult(result.structured_output, result.session_id, result.total_cost_usd or 0.0)


# --- helpers ---


class BuildError(Exception):
    """Something the user has to sort out before running --retry."""


def node_start(name: str):
    print(f"\n▶ {NODE_LABELS.get(name, name)}...", flush=True)


def node_done(name: str, cost: float | None = None):
    spent = f" (${cost:.2f})" if cost else ""
    print(f"✅ {NODE_LABELS.get(name, name)} done{spent}", flush=True)


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


def check_commands() -> list[str]:
    match = re.search(r"^```checks\n(.*?)^```", read_text(PROJECT_CONTEXT_FILE), re.DOTALL | re.MULTILINE)
    if not match:
        return []
    lines = (line.strip() for line in match.group(1).splitlines())
    return [line for line in lines if line and not line.startswith("#")]


# --- git and shell ---


def git(*args: str) -> str:
    return subprocess.run(
        ["git", *args], cwd=ROOT, check=True, capture_output=True, text=True
    ).stdout.strip()


def run(command: str | list[str], timeout: float | None = None) -> tuple[int | None, str]:
    """Run a command in the repo. Returns (exit code, output); the code is None on timeout."""
    try:
        done = subprocess.run(
            command, cwd=ROOT, shell=isinstance(command, str), check=False,
            capture_output=True, text=True, timeout=timeout,
        )
    except subprocess.TimeoutExpired as e:
        partial = e.stdout or ""
        if isinstance(partial, bytes):
            partial = partial.decode(errors="replace")
        return None, f"timed out after {timeout}s\n{partial}"
    return done.returncode, done.stdout + done.stderr


def git_status() -> list[tuple[str, str]]:
    """(status, path) for every uncommitted change, untracked files included."""
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
    excluded = [f":(exclude,literal){path}" for path in state.get("untracked_at_start", [])]
    git("add", "-A", "--", ".", *excluded)
    if run(["git", "diff", "--cached", "--quiet"])[0] == 0:
        return True, ""
    code, output = run(["git", "commit", "-m", message])
    return code == 0, output


def in_cloud() -> bool:
    """True in a Claude Code cloud session, which can push only the session's own branch."""
    return os.environ.get("CLAUDE_CODE_REMOTE") == "true"


def default_branch() -> str:
    try:
        return git("symbolic-ref", "--short", "refs/remotes/origin/HEAD").removeprefix("origin/")
    except subprocess.CalledProcessError:
        return "main"


def free_branch_name(name: str) -> str:
    candidate, n = name, 1
    while run(["git", "rev-parse", "--verify", "--quiet", f"refs/heads/{candidate}"])[0] == 0:
        n += 1
        candidate = f"{name}-{n}"
    return candidate


def exclude_build_dir() -> None:
    """Keep the pipeline's own files out of git status and commits without touching .gitignore."""
    exclude = Path(git("rev-parse", "--git-path", "info/exclude"))
    if not exclude.is_absolute():
        exclude = ROOT / exclude
    if "/.build/" not in read_text(exclude).splitlines():
        exclude.parent.mkdir(parents=True, exist_ok=True)
        with exclude.open("a") as f:
            f.write("\n/.build/\n")


# --- pinned tests ---
#
# Tests written before the code (and QA's tests) are fingerprinted. The checks
# step fails if the implementer edits or deletes one, so "don't weaken the
# tests" is enforced rather than requested.


def repo_path(path: str) -> str | None:
    resolved = (ROOT / path).resolve()
    return str(resolved.relative_to(ROOT)) if resolved.is_relative_to(ROOT) else None


def _digest(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def fingerprints(paths) -> dict[str, str]:
    pins = {}
    for path in paths:
        relative = repo_path(path)
        if relative and (ROOT / relative).is_file():
            pins[relative] = _digest(ROOT / relative)
    return pins


def tampered_pins(pinned: dict[str, str]) -> list[str]:
    return [
        path for path, expected in pinned.items()
        if not (ROOT / path).is_file() or _digest(ROOT / path) != expected
    ]


def is_red(command: str) -> tuple[bool, str]:
    """Run a test command that must fail because the behaviour doesn't exist yet."""
    if not command.strip():
        return False, "no command given"
    code, output = run(command, timeout=CHECK_TIMEOUT_S)
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


def review_block(state: BuildState, extra: str = "") -> str:
    diff_range = f"{state['slice_base']}..HEAD"
    parts = [
        card_block(state),
        slice_block(state),
        f"## Approved plan\n{state['plan']}",
        (
            f"## What to review\nThe change is `git diff {diff_range}` "
            f"(commits: `git log --oneline {diff_range}`). Review only that range."
        ),
        extra,
    ]
    return "\n\n".join(part for part in parts if part)


def format_questions(items: list[dict]) -> str:
    blocks = []
    for n, item in enumerate(items, 1):
        lines = [f"Q{n}. {item['question']}"]
        if item.get("options"):
            lines.append(f"    Options: {item['options']}")
        lines.append(f"    ➡ Recommended: {item['recommendation']}")
        blocks.append("\n".join(lines))
    return "\n\n".join(blocks)


def fix_feedback(state: BuildState) -> str:
    sections = []
    if state.get("checks_feedback"):
        sections.append(f"## Automatic checks failed\n{state['checks_feedback']}")
    for key, label in REVIEW_LABELS.items():
        if state.get(f"{key}_verdict") == "NEEDS_REWORK":
            sections.append(f"## {label}: must fix\n{state.get(f'{key}_feedback', '')}")
    if not sections:
        return ""
    return "--- FIX ROUND ---\nYour previous implementation was checked. Fix these issues:\n\n" + "\n\n".join(sections)


def cleared_reviews() -> dict:
    return {
        "checks_feedback": "",
        **{f"{key}_verdict": "" for key in REVIEW_LABELS},
        **{f"{key}_feedback": "" for key in REVIEW_LABELS},
    }


# --- planning nodes ---


async def designer(state: BuildState):
    node_start("designer")
    rounds = state.get("clarify_rounds", 0)
    parts = [card_block(state)]
    if state.get("clarify_answers"):
        parts.append(f"## Your clarifying questions, answered\n{state['clarify_answers']}")
    if rounds >= MAX_CLARIFY_ROUNDS:
        parts.append(
            "You have used every clarifying round. Don't ask more questions: decide, "
            "and list each assumption under `decisions`."
        )
    feedback = state.get("plan_feedback", "")
    previous_plan = read_text(plan_file(state))
    if feedback and previous_plan:
        parts.append(
            "--- REWORK ---\nYour previous plan (below) was sent back. Do NOT start from scratch: "
            "apply the feedback and keep everything else intact.\n\n"
            f"## Feedback\n{feedback}\n\n## Previous plan\n{previous_plan}"
        )
    elif feedback:
        parts.append(f"## Your previous plan was sent back. Feedback:\n{feedback}")

    result = await run_agent("designer", "\n\n".join(parts), DESIGNER_OUTPUT)
    out = result.output
    asking = bool(out["clarifying_questions"]) and rounds < MAX_CLARIFY_ROUNDS
    write_text(plan_file(state), out["plan"])
    slices = [] if is_bug(state) else out["slices"]
    if asking:
        note = f"asked {len(out['clarifying_questions'])} clarifying question(s)"
    else:
        note = f"{len(out['decisions'])} decision(s), {len(slices)} slice(s)"
    node_done("designer", result.cost)
    return {
        "validity": out["validity"],
        "validity_evidence": out["validity_evidence"],
        "clarify_questions": out["clarifying_questions"] if asking else [],
        "plan": out["plan"],
        "summary": out["summary"],
        "seams": out["seams"],
        "decisions": out["decisions"],
        "slices": slices,
        "plan_attempts": state.get("plan_attempts", 0) + (0 if asking else 1),
        "plan_feedback": "",
        "history": [f"• designer: {out['validity']}, {note}"],
        "cost_usd": result.cost,
    }


def clarify(state: BuildState):
    node_start("clarify")
    questions = format_questions(state["clarify_questions"])
    reply = interrupt(
        f"QUESTIONS BEFORE PLANNING\n\n{questions}\n\n"
        'Reply with your answers, e.g. "Q1: ...; Q2: ...". "go" accepts every recommendation; '
        '"stop" ends the build.'
    )
    word, rest = split_reply(reply)
    if word in STOPS:
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
    node_start("plan_critic")
    prompt = f"{card_block(state)}\n\n## Proposed plan\n{state['plan']}"
    result = await run_agent("plan_critic", prompt, CRITIC_OUTPUT)
    out = result.output
    rework = out["verdict"] == "NEEDS REWORK"
    worst = f" — {out['top_findings'][0]}" if rework and out["top_findings"] else ""
    node_done("plan_critic", result.cost)
    return {
        "plan_verdict": out["verdict"],
        "plan_findings": out["top_findings"],
        "plan_tweaks": out["tweaks"] if out["verdict"] == "SOLID WITH TWEAKS" else [],
        "plan_feedback": out["review"] if rework else "",
        "history": [mark(not rework, f"plan_critic: {out['verdict']}{worst}")],
        "cost_usd": result.cost,
    }


def plan_brief(state: BuildState) -> str:
    lines = [
        (
            f"PLAN FOR REVIEW — {state.get('card_number') or 'ad-hoc request'} "
            f"({state.get('card_type', '')}), attempt {state.get('plan_attempts', 0)}"
        ),
        "",
        f"Critic: {state.get('plan_verdict', 'not run')}",
        *[f"  - {finding}" for finding in state.get("plan_findings", [])],
        "",
        "Summary:",
        state.get("summary", "").strip(),
    ]
    if state.get("seams"):
        lines += ["", "Test points (confirm these):", *[f"  - {seam}" for seam in state["seams"]]]
    if state.get("slices"):
        lines += ["", "Built in slices, in this order:"]
        lines += [f"  {n}. {s['title']} — {s['delivers']}" for n, s in enumerate(state["slices"], 1)]
    if state.get("decisions"):
        lines += ["", "Decisions for you:", format_questions(state["decisions"])]
    if state.get("plan_tweaks"):
        lines += ["", "Critic tweaks that will be applied:", *[f"  - {t}" for t in state["plan_tweaks"]]]
    lines += [
        "",
        f"Full plan: {plan_file(state).relative_to(ROOT)} (edit it directly before replying if you like)",
        "",
        (
            'Reply "go" to approve (recommended answers), "go: Q1 <answer>; Q2 <answer>" to approve '
            'with your answers, "rework: <feedback>" to send it back, or "stop" to end the build.'
        ),
    ]
    return "\n".join(lines)


def invalid_brief(state: BuildState) -> str:
    return (
        f"CARD LOOKS INVALID — {state.get('card_number') or 'ad-hoc request'}: {state['validity']}\n\n"
        f"Evidence: {state.get('validity_evidence', '')}\n\n{state.get('summary', '').strip()}\n\n"
        'Reply "close" if the card is not needed, "rework: <why it is still needed>" to plan it '
        'anyway, or "stop" to end the build without deciding.'
    )


def _sent_back(state: BuildState, feedback: str) -> dict:
    if state.get("plan_verdict") == "NEEDS REWORK" and state.get("plan_feedback"):
        feedback += f"\n\n### The plan critic's review (still unresolved)\n{state['plan_feedback']}"
    return {
        "plan_decision": "REJECTED",
        "plan_feedback": feedback,
        "plan_attempts": 0,
        "history": [f"✗ sign_off: sent back — {first_line(feedback)}"],
    }


def sign_off(state: BuildState):
    node_start("sign_off")
    if state.get("validity", "VALID") != "VALID":
        reply = interrupt(invalid_brief(state))
        word, rest = split_reply(reply)
        if word in STOPS:
            return {"plan_decision": "STOPPED", **stopped("sign_off")}
        if word == "close":
            return {
                "plan_decision": "CLOSED",
                "outcome": "closed",
                "history": [f"• sign_off: card closed ({state['validity']})"],
            }
        return _sent_back(state, rest if word == "rework" else reply)

    reply = interrupt(plan_brief(state))
    word, rest = split_reply(reply)
    if word in STOPS:
        return {"plan_decision": "STOPPED", **stopped("sign_off")}
    if word not in APPROVALS:
        return _sent_back(state, rest if word == "rework" else reply)

    # Re-read the plan file so direct edits made during the pause count.
    sections = [read_text(plan_file(state)) or state["plan"]]
    if state.get("plan_tweaks"):
        sections.append(f"## Critic tweaks (apply these)\n{bullets(state['plan_tweaks'])}")
    if rest:
        sections.append(f"## Sign-off answers\n{rest}")
    elif state.get("decisions"):
        sections.append("## Sign-off answers\nUse the recommended answer for every decision.")
    approved = "\n\n".join(sections)
    write_text(work_dir(state) / "approved-plan.md", approved)
    return {
        "plan_decision": "APPROVED",
        "plan": approved,
        "plan_feedback": "",
        "history": [f"✓ sign_off: approved{' with answers' if rest else ''}"],
    }


def prepare_branch(state: BuildState):
    node_start("prepare_branch")
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
        else:
            git("checkout", "-b", requested)
        branch = requested
    elif not requested and branch in (base, "HEAD"):
        branch = free_branch_name(f"{commit_prefix(state)}/{state['thread_id'].lower()}")
        git("checkout", "-b", branch)
    head = git("rev-parse", "HEAD")
    node_done("prepare_branch")
    return {
        "base_branch": base,
        "branch": branch,
        "slice_base": head,
        "current_slice": 0,
        "history": [f"• branch: {branch}"],
    }


# --- test-first nodes ---


async def reproducer(state: BuildState):
    node_start("reproducer")
    parts = [card_block(state), f"## Approved plan\n{state['plan']}"]
    if state.get("escalation_answer"):
        parts.append(f"## You couldn't reproduce this before. The user says:\n{state['escalation_answer']}")
    result = await run_agent("reproducer", "\n\n".join(parts), REPRODUCER_OUTPUT)
    out = result.output
    node_done("reproducer", result.cost)
    if out["status"] == "REPRODUCED":
        red, output = is_red(out["command"])
        if red:
            return {
                "repro": f"`{out['command']}` fails on: {out['symptom']}\n\n{out['summary']}",
                "tests": out["summary"],
                "pinned": {**state.get("pinned", {}), **fingerprints(out["test_files"])},
                "escalation_answer": "",
                "history": [f"✓ reproducer: red on {first_line(out['symptom'])}"],
                "cost_usd": result.cost,
            }
        reason = (
            f"The reproducer said `{out['command']}` fails on the bug, but it passed "
            f"when the pipeline ran it:\n{tail(output, 1500)}"
        )
    else:
        reason = out["tried"]
    return {
        "escalation": f"Couldn't reproduce the bug.\n\nSymptom: {out['symptom']}\n\n{reason}",
        "escalation_source": "reproducer",
        "escalation_answer": "",
        "history": [f"✗ reproducer: couldn't reproduce — {first_line(reason)}"],
        "cost_usd": result.cost,
    }


async def test_writer(state: BuildState):
    node_start("test_writer")
    parts = [card_block(state), slice_block(state), f"## Approved plan\n{state['plan']}"]
    if state.get("seams"):
        parts.append(f"## Agreed test points (seams)\n{bullets(state['seams'])}")
    if state.get("test_feedback"):
        parts.append(f"## Your previous tests were rejected\n{state['test_feedback']}")
    if state.get("escalation_answer"):
        parts.append(f"## The user says\n{state['escalation_answer']}")
    result = await run_agent("test_writer", "\n\n".join(p for p in parts if p), TEST_WRITER_OUTPUT)
    out = result.output
    node_done("test_writer", result.cost)
    done = {"test_attempts": 0, "test_feedback": "", "escalation_answer": "", "cost_usd": result.cost}
    if not out["test_files"]:
        return {**done, "tests": out["summary"], "history": [f"• test_writer: no tests — {first_line(out['summary'])}"]}

    red, output = is_red(out["command"])
    if red:
        return {
            **done,
            "tests": out["summary"],
            "pinned": {**state.get("pinned", {}), **fingerprints(out["test_files"])},
            "history": [f"✓ test_writer: {len(out['test_files'])} failing test file(s) pinned"],
        }
    attempts = state.get("test_attempts", 0) + 1
    feedback = (
        f"`{out['command']}` didn't fail for the right reason before any implementation exists "
        f"(it passed, wasn't found, or timed out), so the tests prove nothing. Output:\n{tail(output, 1500)}"
    )
    update = {
        "test_attempts": attempts,
        "test_feedback": feedback,
        "history": [f"✗ test_writer: tests weren't red — {first_line(out['command'])}"],
        "cost_usd": result.cost,
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
    if state.get("pinned"):
        parts.append(
            "## Pinned test files (read-only: the pipeline rejects changes; ESCALATE if one is wrong)\n"
            + bullets(sorted(state["pinned"]))
        )
    parts.append(feedback)
    if state.get("escalation_answer"):
        parts.append(f"## Your escalated question, answered\n{state['escalation_answer']}")
    return "\n\n".join(part for part in parts if part)


async def implementer(state: BuildState):
    node_start("implementer")
    feedback = fix_feedback(state)
    answer = state.get("escalation_answer", "")
    news = "\n\n".join(p for p in [feedback, answer and f"## Your escalated question, answered\n{answer}"] if p)
    session = state.get("implementer_session", "")
    resumes = state.get("implementer_resumes", 0)
    # Continue the same session on fix rounds: it already knows the code it wrote.
    resume = session if session and news and resumes < MAX_SESSION_RESUMES else None
    try:
        if resume:
            result = await run_agent("implementer", news, IMPLEMENTER_OUTPUT, resume=resume)
        else:
            result = await run_agent("implementer", implementer_prompt(state, feedback), IMPLEMENTER_OUTPUT)
    except AgentError as e:
        if not resume or e.transient:
            raise
        print("  ↺ couldn't resume the previous session, starting fresh", flush=True)
        resume = None
        result = await run_agent("implementer", implementer_prompt(state, feedback), IMPLEMENTER_OUTPUT)
    out = result.output
    session_update = {
        "implementer_session": result.session_id,
        "implementer_resumes": resumes + 1 if resume else 0,
        "cost_usd": result.cost,
    }
    node_done("implementer", result.cost)
    if out["status"] == "ESCALATE":
        question = out["escalation"] or out["summary"]
        return {
            **session_update,
            "escalation": question,
            "escalation_source": "implementer",
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
    "implementer": ' "unpin: <reason>" lets it edit pinned tests.',
}


def escalation(state: BuildState):
    node_start("escalation")
    source = state.get("escalation_source", "implementer")
    reply = interrupt(
        f"DECISION NEEDED (from the {NODE_LABELS[source]})\n\n{state['escalation']}\n\n"
        f"Reply with your decision, or \"stop\" to end the build.{ESCALATION_HINTS.get(source, '')}"
    )
    word, _ = split_reply(reply)
    if word in STOPS:
        return {"escalation": "", **stopped("escalation")}
    update = {
        "escalation": "",
        "escalation_answer": reply,
        "escalation_next": source,
        "history": [f"• escalation answered: {first_line(reply)}"],
    }
    if source == "test_writer":
        update["test_attempts"] = 0
    if word == "skip" and source in SKIP_TO:
        update.update(escalation_next=SKIP_TO[source], escalation_answer="", test_feedback="")
    if word == "unpin":
        update["pinned"] = {}
    return update


def checks(state: BuildState):
    node_start("checks")
    problems = []
    tampered = tampered_pins(state.get("pinned", {}))
    if tampered:
        problems.append(
            "Pinned test files were changed or deleted. Restore them with `git checkout -- <file>`; "
            f"if one is genuinely wrong, reply with status ESCALATE instead:\n{bullets(tampered)}"
        )
    commands = check_commands()
    if not commands:
        print("  ⚠ no ```checks block in project-context.md: only pinned tests are verified", flush=True)
    for command in commands:
        code, output = run(command, timeout=CHECK_TIMEOUT_S)
        print(f"  {'✓' if code == 0 else '✗'} {command}", flush=True)
        if code != 0:
            problems.append(f"$ {command}\n{tail(output)}")
    if not problems:
        ok, output = commit_all(state, commit_message(state))
        if not ok:
            problems.append(f"git commit failed (a pre-commit hook?):\n{tail(output)}")
    failed = bool(problems) and state.get("implementation_attempts", 0) >= MAX_IMPLEMENTATION_ROUNDS
    node_done("checks")
    return {
        "checks_feedback": "\n\n".join(problems),
        "failed": failed,
        "outcome": "failed" if failed else "",
        "history": [
            mark(False, f"checks: {first_line(problems[0])}") if problems else mark(True, "checks: passed, committed")
        ],
    }


def commit_message(state: BuildState) -> str:
    slices = state.get("slices") or []
    subject = slices[state.get("current_slice", 0)]["title"] if slices else card_title(state)
    if git("rev-parse", "HEAD") != state["slice_base"]:
        subject = f"address findings on {state.get('card_number') or subject}"
    return f"{commit_prefix(state)}: {subject}"[:100]


# --- review nodes (read-only, run in parallel) ---


async def standards_critic(state: BuildState):
    node_start("standards_critic")
    result = await run_agent("standards_critic", review_block(state), STANDARDS_OUTPUT)
    out = result.output
    blocking = out["blocking"]
    node_done("standards_critic", result.cost)
    return {
        "standards_verdict": "NEEDS_REWORK" if blocking else "APPROVED",
        "standards_feedback": bullets(blocking),
        "standards_advisory": out["advisory"],
        "tech_debt": out["tech_debt"],
        "history": [mark(not blocking, f"standards: {len(blocking)} must-fix" if blocking else "standards: approved")],
        "cost_usd": result.cost,
    }


async def spec_critic(state: BuildState):
    node_start("spec_critic")
    result = await run_agent("spec_critic", review_block(state), SPEC_OUTPUT)
    out = result.output
    findings = [
        *(f"Missing: {item}" for item in out["missing"]),
        *(f"Wrong: {item}" for item in out["wrong"]),
        *(f"Not asked for: {item}" for item in out["scope_creep"]),
    ]
    node_done("spec_critic", result.cost)
    return {
        "spec_verdict": "NEEDS_REWORK" if findings else "APPROVED",
        "spec_feedback": bullets(findings),
        "history": [mark(not findings, f"spec: {first_line(findings[0])}" if findings else "spec: approved")],
        "cost_usd": result.cost,
    }


async def correctness_critic(state: BuildState):
    node_start("correctness_critic")
    result = await run_agent("correctness_critic", review_block(state), CORRECTNESS_OUTPUT)
    out = result.output
    bugs, decisions = out["blocking_bugs"], out["decisions_to_escalate"]
    feedback = []
    if bugs:
        feedback.append(bullets(bugs))
    if decisions:
        feedback.append(
            "These decisions were made without sign-off. Don't change the code for them: "
            f"reply with status ESCALATE and put them to the user:\n{bullets(decisions)}"
        )
    rework = bool(bugs or decisions)
    node_done("correctness_critic", result.cost)
    return {
        "correctness_verdict": "NEEDS_REWORK" if rework else "APPROVED",
        "correctness_feedback": "\n\n".join(feedback),
        "correctness_minor": out["minor_bugs"],
        "context_updates": out["context_updates"],
        "history": [mark(not rework, f"correctness: {len(bugs)} bug(s), {len(decisions)} unapproved decision(s)"
                         if rework else "correctness: approved")],
        "cost_usd": result.cost,
    }


async def qa(state: BuildState):
    node_start("qa")
    patch = work_dir(state) / f"qa-{state.get('current_slice', 0)}-{state.get('implementation_attempts', 0)}.patch"
    patch.parent.mkdir(parents=True, exist_ok=True)
    patch.unlink(missing_ok=True)
    extra = (
        f"## Where your tests go\nSave your test changes as a patch at `{patch}` "
        "(see 'Hand back your tests'). The pipeline applies it to the branch."
    )
    result = await run_agent("qa", review_block(state, extra), QA_OUTPUT)
    out = result.output
    bugs = out["real_bugs"]
    node_done("qa", result.cost)
    return {
        "qa_verdict": "NEEDS_REWORK" if bugs else "APPROVED",
        "qa_feedback": bullets(bugs),
        "qa_patch": str(patch) if patch.is_file() else "",
        "manual_checks": out["manual_checks"],
        "history": [mark(not bugs, f"qa: {len(bugs)} real bug(s)" if bugs else "qa: passed")],
        "cost_usd": result.cost,
    }


def fix_or_ship(state: BuildState):
    node_start("fix_or_ship")
    stray = stray_changes(state)
    if stray:
        raise BuildError(
            "Reviewers are read-only, but these files changed during review:\n"
            f"{bullets(stray)}\nInspect and discard them (e.g. `git checkout -- <file>`), then run --retry."
        )
    update, history = {"qa_patch": ""}, []
    if state.get("qa_patch"):
        applied, note = apply_test_patch(Path(state["qa_patch"]))
        history.append(note)
        if applied:
            update["pinned"] = {**state.get("pinned", {}), **fingerprints(applied)}
    needs_rework = any(state.get(f"{key}_verdict") == "NEEDS_REWORK" for key in REVIEW_LABELS)
    failed = needs_rework and state.get("implementation_attempts", 0) >= MAX_IMPLEMENTATION_ROUNDS
    node_done("fix_or_ship")
    return {**update, "failed": failed, "outcome": "failed" if failed else "", "history": history}


def next_slice(state: BuildState):
    node_start("next_slice")
    index = state.get("current_slice", 0)
    title = state["slices"][index]["title"]
    ok, output = commit_all(state, f"test: QA tests for {title}")
    if not ok:
        raise BuildError(f"Couldn't commit QA's tests before the next slice:\n{tail(output)}\nFix it, then run --retry.")
    index += 1
    node_done("next_slice")
    return {
        **cleared_reviews(),
        "current_slice": index,
        "slice_base": git("rev-parse", "HEAD"),
        "implementer_session": "",
        "implementer_resumes": 0,
        "implementation_attempts": 0,
        "tests": "",
        "test_attempts": 0,
        "test_feedback": "",
        "history": [f"• slice {index + 1}/{len(state['slices'])}: {state['slices'][index]['title']}"],
    }


# --- wrap-up nodes ---


async def retro(state: BuildState):
    node_start("retro")
    history = state.get("history", [])
    suggested = state.get("context_updates", [])
    if not any(line.startswith("✗") for line in history) and not suggested:
        node_done("retro")
        return {"retro_proposals": []}
    parts = [card_block(state), "## Build history (✗ = friction)\n" + "\n".join(history)]
    if suggested:
        parts.append(f"## Landmines the correctness reviewer suggested\n{bullets(suggested)}")
    if state.get("tech_debt"):
        parts.append("## Tech debt the standards reviewer filed\n" + bullets(t["title"] for t in state["tech_debt"]))
    result = await run_agent("retro", "\n\n".join(parts), RETRO_OUTPUT)
    out = result.output
    node_done("retro", result.cost)
    return {
        "retro_proposals": out["context_additions"],
        "lint_ideas": out["lint_ideas"],
        "history": [f"• retro: {first_line(out['notes'])}"],
        "cost_usd": result.cost,
    }


def add_to_section(text: str, section: str, line: str) -> str:
    heading = re.search(rf"^## {re.escape(section)}[ \t]*$", text, re.MULTILINE)
    if not heading:
        return f"{text.rstrip()}\n\n## {section}\n\n- {line}\n"
    following = re.search(r"^## ", text[heading.end():], re.MULTILINE)
    end = heading.end() + following.start() if following else len(text)
    before, after = text[:end].rstrip(), text[end:]
    return f"{before}\n- {line}\n" + (f"\n{after}" if after else "")


def retro_review(state: BuildState):
    node_start("retro_review")
    proposals = state["retro_proposals"]
    listing = "\n".join(f"{n}. [{p['section']}] {p['text']}" for n, p in enumerate(proposals, 1))
    reply = interrupt(
        f"RETRO PROPOSALS — additions to {PROJECT_CONTEXT_FILE.name} from what this build ran into:\n\n"
        f"{listing}\n\n"
        'Reply "go" to add them all, "go: 1,3" to add some, "skip" to add none, '
        'or "stop" to end the build without shipping.'
    )
    word, rest = split_reply(reply)
    if word in STOPS:
        return {"retro_proposals": [], **stopped("retro_review")}
    if word not in APPROVALS:
        return {"retro_proposals": [], "history": ["• retro: proposals skipped"]}
    picks = [int(n) for n in re.findall(r"\d+", rest)] or range(1, len(proposals) + 1)
    chosen = [proposals[n - 1] for n in picks if 1 <= n <= len(proposals)]
    text = read_text(PROJECT_CONTEXT_FILE)
    for proposal in chosen:
        text = add_to_section(text, proposal["section"], proposal["text"])
    PROJECT_CONTEXT_FILE.write_text(text)
    name = PROJECT_CONTEXT_FILE.name
    if run(["git", "ls-files", "--error-unmatch", name])[0] == 0:
        run(["git", "commit", "-m", "docs: update project context from build retro", "--", name])
    return {"retro_proposals": [], "history": [f"• retro: added {len(chosen)} line(s) to {name}"]}


def pr_body(state: BuildState) -> str:
    sections = [
        f"## Card\n{state.get('card_number') or 'Ad-hoc request'}\n\n{state.get('card_details', '').strip()}",
        f"## Summary\n{state.get('summary', '').strip()}",
        f"## Checks\n{bullets(f'`{c}`' for c in check_commands()) or 'None configured.'}",
        "## Review\nStandards, spec, correctness and QA reviews all approved.",
    ]
    if state.get("manual_checks"):
        sections.append("## Manual QA checklist\n" + "\n".join(f"- [ ] {c}" for c in state["manual_checks"]))
    notes = [*state.get("standards_advisory", []), *state.get("correctness_minor", [])]
    if notes:
        sections.append(f"## Non-blocking notes\n{bullets(notes)}")
    if state.get("tech_debt"):
        sections.append("## Tech debt to file\n" + bullets(f"{t['title']}: {t['problem']}" for t in state["tech_debt"]))
    return "\n\n".join(sections)


def ship(state: BuildState):
    node_start("ship")
    ok, output = commit_all(state, f"test: add QA tests for {state.get('card_number') or 'build'}")
    if not ok:
        return {"outcome": "ship_error", "pr_error": f"git commit failed:\n{tail(output)}"}
    branch, base = state["branch"], state["base_branch"]
    title = f"{commit_prefix(state)}: {card_title(state)}"[:72]
    try:
        git("push", "-u", "origin", branch)
        code, existing = run(["gh", "pr", "view", branch, "--json", "url", "-q", ".url"])
        if code == 0 and existing.strip():
            pr_url = existing.strip()
        else:
            created = subprocess.run(
                ["gh", "pr", "create", "--base", base, "--head", branch, "--title", title, "--body", pr_body(state)],
                cwd=ROOT, check=True, capture_output=True, text=True,
            )
            pr_url = created.stdout.strip().splitlines()[-1]
    except subprocess.CalledProcessError as e:
        return {"outcome": "ship_error", "pr_error": f"{' '.join(e.cmd[:3])}\n{e.stderr or e.stdout}".strip()}
    node_done("ship")
    return {"outcome": "shipped", "pr_url": pr_url, "pr_error": "", "history": [f"✓ ship: {pr_url}"]}


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
    return {"APPROVED": "prepare_branch", "CLOSED": END, "STOPPED": END}.get(
        state.get("plan_decision"), "designer"
    )


def after_clarify(state: BuildState):
    return END if state.get("outcome") == "stopped" else "designer"


def after_prepare_branch(state: BuildState):
    return "reproducer" if is_bug(state) else "test_writer"


def after_reproducer(state: BuildState):
    return "escalation" if state.get("escalation") else "implementer"


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
    return "retro" if state.get("failed") else "implementer"


def after_review(state: BuildState):
    if any(state.get(f"{key}_verdict") == "NEEDS_REWORK" for key in REVIEW_LABELS):
        return "retro" if state.get("failed") else "implementer"
    if state.get("current_slice", 0) + 1 < len(state.get("slices") or []):
        return "next_slice"
    return "retro"


def after_retro(state: BuildState):
    if state.get("retro_proposals"):
        return "retro_review"
    return END if state.get("failed") else "ship"


def after_retro_review(state: BuildState):
    return END if state.get("failed") or state.get("outcome") == "stopped" else "ship"


# --- graph ---

builder = StateGraph(BuildState)
for name, node in [
    ("designer", designer),
    ("plan_critic", plan_critic),
    ("reproducer", reproducer),
    ("test_writer", test_writer),
    ("implementer", implementer),
    ("standards_critic", standards_critic),
    ("spec_critic", spec_critic),
    ("correctness_critic", correctness_critic),
    ("qa", qa),
    ("retro", retro),
]:
    builder.add_node(name, node, retry_policy=AGENT_RETRY)
for name, node in [
    ("clarify", clarify),
    ("sign_off", sign_off),
    ("prepare_branch", prepare_branch),
    ("escalation", escalation),
    ("checks", checks),
    ("fix_or_ship", fix_or_ship),
    ("next_slice", next_slice),
    ("retro_review", retro_review),
    ("ship", ship),
]:
    builder.add_node(name, node)

builder.add_edge(START, "designer")
builder.add_edge(REVIEWERS, "fix_or_ship")
builder.add_edge("next_slice", "test_writer")
builder.add_edge("ship", END)

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
builder.add_conditional_edges("retro", after_retro)
builder.add_conditional_edges("retro_review", after_retro_review)


# --- cli ---
#
# Usage:
#   python3 build_graph.py --card WHIT-123 --type Feature --details-file card.md   → build a card
#   python3 build_graph.py "add a chat button for spending"                       → ad-hoc request
#   python3 build_graph.py --thread WHIT-123 --resume "go"                         → answer a pause
#   python3 build_graph.py --thread WHIT-123 --status                              → where is it?
#   python3 build_graph.py --thread WHIT-123 --retry                               → re-run a step that errored
#   python3 build_graph.py --thread WHIT-123 --recheck                             → after fixing a failed build by hand
#   add --restart to a new build to discard saved progress for that card
#   add --branch <name> to build on a given branch; a cloud session must pass its own
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
    action = parser.add_mutually_exclusive_group()
    action.add_argument("--resume", metavar="REPLY", help="answer the question a paused build is waiting on")
    action.add_argument("--status", action="store_true", help="show where a build is")
    action.add_argument("--retry", action="store_true", help="re-run the step that stopped with an error")
    action.add_argument("--recheck", action="store_true", help="re-run checks and reviews after fixing a failed build")
    args = parser.parse_args(argv)

    if args.details_file:
        args.details = sys.stdin.read() if args.details_file == "-" else Path(args.details_file).read_text()
    continuing = args.resume is not None or args.status or args.retry or args.recheck
    if args.request and not args.card and not continuing:
        args.thread = args.thread or hashlib.sha256(args.request.encode()).hexdigest()[:8]
    args.thread = args.thread or args.card
    if continuing:
        if not args.thread:
            parser.error("--resume, --status, --retry and --recheck need --thread (or --card)")
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


def print_status(thread: str, snapshot) -> int:
    values = snapshot.values
    if not values:
        print(f"No saved build for thread {thread}.")
        return 1
    print(f"Thread: {thread}")
    print(f"Card: {values.get('card_number') or '(ad-hoc)'} · type: {values.get('card_type', '')}")
    if snapshot.interrupts:
        print("Paused: waiting for your reply (--resume)")
    print(f"Next step: {', '.join(snapshot.next) or 'finished'}")
    print(f"Outcome: {values.get('outcome') or 'in progress'}")
    plan = BUILD_DIR / thread / "plan.md"
    if plan.is_file():
        print(f"Plan: {plan.relative_to(ROOT)}")
    for key, label in [("branch", "Branch"), ("pr_url", "PR"), ("pr_error", "PR error")]:
        if values.get(key):
            print(f"{label}: {values[key]}")
    print(f"Agent cost so far: ${values.get('cost_usd', 0):.2f}\n")
    print_history(values)
    return 0


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
            if result.get(f"{key}_verdict") == "NEEDS_REWORK":
                print(f"\n## {label}\n{result.get(f'{key}_feedback', '')}")
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
    else:
        print("Done.")
    print("=" * 60)
    if result.get("tech_debt"):
        print("\nTECH DEBT CARDS TO FILE:")
        for card in result["tech_debt"]:
            print(f"- {card['title']}: {card['problem']} → {card['fix']}")
    if result.get("lint_ideas"):
        print(f"\nCHECKS WORTH AUTOMATING:\n{bullets(result['lint_ideas'])}")
    print(f"\nAgent cost: ${result.get('cost_usd', 0):.2f}")
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
    modified = [path for status, path in git_status() if status != "??"]
    if modified:
        print(f"Commit or stash these changes before starting a build:\n{bullets(modified)}")
        return None
    if snapshot.values:
        await saver.adelete_thread(thread)
    shutil.rmtree(BUILD_DIR / thread, ignore_errors=True)
    print(f"Starting build (thread {thread})...\n")
    return await graph.ainvoke(
        {
            "thread_id": thread,
            "card_number": args.card or "",
            "card_details": args.details if args.card else args.request,
            "card_type": args.type,
            "untracked_at_start": [path for status, path in git_status() if status == "??"],
            "requested_branch": args.branch or "",
            "history": [],
            "cost_usd": 0.0,
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
    print_history(snapshot.values)
    return await graph.ainvoke(Command(resume=reply), config)


async def retry_build(graph, config, snapshot):
    if snapshot.interrupts:
        print("This build is waiting for your reply. Use --resume.")
        return None
    if snapshot.next:
        print(f"Retrying {', '.join(snapshot.next)}...\n")
        return await graph.ainvoke(None, config)
    if snapshot.values.get("outcome") == "ship_error":
        await graph.aupdate_state(config, {"outcome": "", "pr_error": ""}, as_node="retro_review")
        return await graph.ainvoke(None, config)
    print("Nothing to retry: the build isn't stopped on an error.")
    return None


async def recheck_build(graph, config, snapshot):
    values = snapshot.values
    if values.get("outcome") != "failed" or snapshot.next:
        print("Only a failed, finished build can be rechecked. Use --status to see where this one is.")
        return None
    await graph.aupdate_state(
        config,
        {
            **cleared_reviews(),
            "failed": False,
            "outcome": "",
            "implementation_attempts": 0,
            "escalation": "",
            "history": ["• recheck: re-running checks and reviews after manual fixes"],
        },
        as_node="implementer",
    )
    return await graph.ainvoke(None, config)


async def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    if not PROJECT_CONTEXT_FILE.is_file():
        print(f"Missing {PROJECT_CONTEXT_FILE.name}: copy project-context-template.md and fill it in.")
        return 1
    BUILD_DIR.mkdir(exist_ok=True)
    exclude_build_dir()
    config = {"configurable": {"thread_id": args.thread}}
    async with AsyncSqliteSaver.from_conn_string(str(DB_PATH)) as saver:
        await saver.setup()
        graph = builder.compile(checkpointer=saver)
        snapshot = await graph.aget_state(config)
        if args.status:
            return print_status(args.thread, snapshot)
        try:
            if args.resume is not None:
                result = await resume_build(graph, config, snapshot, args.resume)
            elif args.retry:
                result = await retry_build(graph, config, snapshot)
            elif args.recheck:
                result = await recheck_build(graph, config, snapshot)
            else:
                result = await start_build(graph, saver, config, snapshot, args)
        except Exception as e:  # noqa: BLE001 — every failure gets the same --retry advice
            if not isinstance(e, (BuildError, AgentError)):
                traceback.print_exc()
            stopped = await graph.aget_state(config)
            print("\n" + "=" * 60)
            print(f"BUILD STOPPED at {', '.join(stopped.next) or 'the end'}:\n{e}")
            print("=" * 60)
            print(f"\nFix the cause, then run:\n  {rerun()} --thread {args.thread} --retry")
            return 1
        if result is None:
            return 1
        return report(args.thread, result)


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
