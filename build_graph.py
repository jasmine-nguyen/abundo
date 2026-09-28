# START -> designer -> plan_critic
#             ^            |
#             '-- rework --'  (NEEDS REWORK & attempts < 2)
#                          |
#                     sign_off (pause)
#                    /         \
#              designer         implementer
#            (REJECTED)        /     |
#                    escalation      |  (if ESCALATION: in output)
#                      (pause)       |
#                             /        \
#                      code_critic      qa
#                             \        /
#                           fix_or_ship
#                          /     |     \
#                   implementer  |     END
#                (NEEDS REWORK   |   (failed)
#                  & attempts < 2)
#                              ship  (both passed: commit, push, open PR)
#                                |
#                               END
from claude_agent_sdk import (
    AssistantMessage,
    ClaudeAgentOptions,
    ResultMessage,
    ToolUseBlock,
    query,
)
import subprocess
import sys
from typing import NotRequired, TypedDict

from langgraph.checkpoint.sqlite.aio import AsyncSqliteSaver
from langgraph.graph import END, START, StateGraph
from langchain_core.runnables import RunnableConfig
from langgraph.types import Command, interrupt


class BuildState(TypedDict):
    card_number: str
    card_details: str
    card_type: NotRequired[str]
    plan: NotRequired[str]
    plan_verdict: NotRequired[str]
    plan_attempts: NotRequired[int]
    plan_decision: NotRequired[str]
    plan_feedback: NotRequired[str]
    implementation_attempts: NotRequired[int]
    implementation: NotRequired[str]
    code_verdict: NotRequired[str]
    code_feedback: NotRequired[str]
    qa_verdict: NotRequired[str]
    qa_feedback: NotRequired[str]
    failed: NotRequired[bool]
    escalation: NotRequired[str]
    escalation_source: NotRequired[str]
    escalation_answer: NotRequired[str]
    pr_url: NotRequired[str]
    pr_error: NotRequired[str]


# --- helpers ---

DEFAULT_MODEL = "claude-opus-5-5"
PROJECT_CONTEXT = open("project-context.md").read()


def agent_prompt(agent_file: str) -> str:
    return open(f".claude/agents/{agent_file}").read() + "\n\n" + PROJECT_CONTEXT


NODE_LABELS = {
    "designer": "Designer",
    "plan_critic": "Plan Critic",
    "sign_off": "Sign-off",
    "implementer": "Implementer",
    "code_critic": "Code Review",
    "qa": "QA",
    "escalation": "Escalation",
    "fix_or_ship": "Fix or Ship",
    "ship": "Open PR",
}


def node_start(name: str):
    print(f"\n▶ {NODE_LABELS.get(name, name)}...", flush=True)


def node_done(name: str):
    print(f"✅ {NODE_LABELS.get(name, name)} done", flush=True)


def print_progress(message):
    if isinstance(message, AssistantMessage):
        for block in message.content:
            if isinstance(block, ToolUseBlock):
                print(f"  → {block.name}", flush=True)


def print_resume_recap(state: dict):
    stages = [
        ("designer", "plan"),
        ("plan_critic", "plan_verdict"),
        ("sign_off", "plan_decision"),
        ("implementer", "implementation"),
        ("code_critic", "code_verdict"),
        ("qa", "qa_verdict"),
        ("ship", "pr_url"),
    ]
    print("Resuming — completed stages:")
    for node, key in stages:
        if state.get(key):
            print(f"  ✅ {NODE_LABELS[node]}")
    print()


# --- nodes ---


async def designer(state: BuildState):
    node_start("designer")
    prompt = (
        f"Card: {state.get('card_number')}, Details: {state.get('card_details', '')}"
    )
    feedback = state.get("plan_feedback", "")
    if feedback:
        prompt += f"\nPrevious plan was rejected. Feedback: {feedback}"

    options = ClaudeAgentOptions(
        model=DEFAULT_MODEL,
        system_prompt=agent_prompt("solution-designer.md"),
        allowed_tools=["Read", "Grep", "Glob", "Bash"],
    )

    async for message in query(prompt=prompt, options=options):
        print_progress(message)
        if isinstance(message, ResultMessage):
            node_done("designer")
            return {
                "plan": message.result,
                "plan_attempts": state.get("plan_attempts", 0) + 1,
            }


async def plan_critic(state: BuildState):
    node_start("plan_critic")
    plan = state.get("plan", "")
    prompt = f"Card: {state.get('card_number')}\n\nProposed plan:\n{plan}"

    options = ClaudeAgentOptions(
        model=DEFAULT_MODEL,
        system_prompt=agent_prompt("solution-critic.md"),
        allowed_tools=["Read", "Grep", "Glob", "Bash"],
    )

    async for message in query(prompt=prompt, options=options):
        print_progress(message)
        if isinstance(message, ResultMessage):
            verdict = message.result
            node_done("plan_critic")
            if "NEEDS REWORK" in verdict:
                return {"plan_verdict": "NEEDS REWORK"}
            return {"plan_verdict": "APPROVED"}


def sign_off(state: BuildState):
    node_start("sign_off")
    plan = state.get("plan", "")
    verdict = state.get("plan_verdict", "")
    attempts = state.get("plan_attempts", 0)
    print(f"\n{'=' * 60}", flush=True)
    print("PLAN FOR REVIEW", flush=True)
    print(f"Critic verdict: {verdict} (attempt {attempts})", flush=True)
    print(f"{'=' * 60}", flush=True)
    print(plan, flush=True)
    print(f"{'=' * 60}\n", flush=True)
    answer = interrupt("Approve the plan above?")
    normalized = answer.strip().lower()
    if normalized in ("go", "approve", "approved", "yes", "y", "lgtm", "ok"):
        return {"plan_decision": "APPROVED", "plan_feedback": ""}
    else:
        return {
            "plan_decision": "REJECTED",
            "plan_feedback": answer,
            "plan_attempts": 0,
        }


async def implementer(state: BuildState):
    node_start("implementer")
    plan = state.get("plan", "")
    prompt = f"Card: {state.get('card_number')}\n\nApproved plan:\n{plan}"

    code_feedback = state.get("code_feedback", "")
    qa_feedback = state.get("qa_feedback", "")
    if code_feedback or qa_feedback:
        prompt += "\n\n--- FIX ROUND ---\nYour previous implementation was reviewed. Fix these issues:\n"
        if code_feedback:
            prompt += f"\n## Code review findings:\n{code_feedback}\n"
        if qa_feedback:
            prompt += f"\n## QA findings:\n{qa_feedback}\n"

    escalation_answer = state.get("escalation_answer", "")
    if escalation_answer:
        prompt += f"\n\nYou previously escalated a decision. The answer: {escalation_answer}"

    options = ClaudeAgentOptions(
        model=DEFAULT_MODEL,
        system_prompt=agent_prompt("implementer.md"),
        allowed_tools=["Read", "Grep", "Glob", "Edit", "Write", "Bash"],
    )

    async for message in query(prompt=prompt, options=options):
        print_progress(message)
        if isinstance(message, ResultMessage):
            node_done("implementer")
            if "ESCALATION:" in message.result:
                return {
                    "escalation": message.result,
                    "escalation_source": "implementer",
                }
            return {
                "implementation": message.result,
                "implementation_attempts": state.get("implementation_attempts", 0) + 1,
                "escalation_answer": "",
                "code_feedback": "",
                "qa_feedback": "",
            }


async def code_critic(state: BuildState):
    node_start("code_critic")
    prompt = (
        f"Card: {state.get('card_number')}\n\n"
        f"Review the implementation changes."
    )

    options = ClaudeAgentOptions(
        model=DEFAULT_MODEL,
        system_prompt=agent_prompt("code-critic.md"),
        allowed_tools=["Read", "Grep", "Glob", "Bash"],
    )

    async for message in query(prompt=prompt, options=options):
        print_progress(message)
        if isinstance(message, ResultMessage):
            node_done("code_critic")
            if "DO NOT SHIP" in message.result:
                return {"code_verdict": "NEEDS REWORK", "code_feedback": message.result}
            return {"code_verdict": "APPROVED", "code_feedback": ""}


async def qa(state: BuildState):
    node_start("qa")
    prompt = (
        f"Card: {state.get('card_number')}\n\n"
        f"Plan:\n{state.get('plan', '')}\n\n"
        f"Test the implementation changes."
    )

    options = ClaudeAgentOptions(
        model=DEFAULT_MODEL,
        system_prompt=agent_prompt("qa.md"),
        allowed_tools=["Read", "Grep", "Glob", "Bash"],
    )

    async for message in query(prompt=prompt, options=options):
        print_progress(message)
        if isinstance(message, ResultMessage):
            node_done("qa")
            if "VERDICT: FAIL" in message.result:
                return {"qa_verdict": "NEEDS REWORK", "qa_feedback": message.result}
            return {"qa_verdict": "APPROVED", "qa_feedback": ""}


def escalation(state: BuildState):
    node_start("escalation")
    answer = interrupt(state.get("escalation", ""))
    return {"escalation_answer": answer, "escalation": ""}


def fix_or_ship(state: BuildState):
    node_start("fix_or_ship")
    still_failing = (
        state.get("code_verdict") == "NEEDS REWORK"
        or state.get("qa_verdict") == "NEEDS REWORK"
    )
    out_of_attempts = state.get("implementation_attempts", 0) >= 2
    if still_failing and out_of_attempts:
        node_done("fix_or_ship")
        return {"failed": True}
    node_done("fix_or_ship")
    return {"failed": False}


def git(*cmd: str) -> str:
    return subprocess.run(
        cmd, check=True, capture_output=True, text=True
    ).stdout.strip()


def default_branch() -> str:
    try:
        ref = git("git", "symbolic-ref", "--short", "refs/remotes/origin/HEAD")
        return ref.removeprefix("origin/")
    except subprocess.CalledProcessError:
        return "main"


# Card type (board "Type" field) -> conventional commit prefix.
TYPE_PREFIXES = {
    "story": "feat",
    "feature": "feat",
    "feat": "feat",
    "bug": "fix",
    "defect": "fix",
    "fix": "fix",
    "chore": "chore",
    "refactor": "refactor",
    "docs": "docs",
}


def change_prefix(card_type: str) -> str:
    return TYPE_PREFIXES.get(card_type.strip().lower(), "feat")


def ship(state: BuildState, config: RunnableConfig):
    node_start("ship")
    card = state.get("card_number", "")
    details = state.get("card_details", "").strip()
    first_line = details.splitlines()[0] if details else "build"
    title = f"{card} {first_line}".strip()[:72]
    prefix = change_prefix(state.get("card_type", ""))
    thread_id = config["configurable"]["thread_id"]

    try:
        base = default_branch()
        branch = git("git", "rev-parse", "--abbrev-ref", "HEAD")
        if branch in (base, "HEAD"):
            branch = f"{prefix}/{thread_id.lower()}"
            git("git", "checkout", "-B", branch)

        # Keep the checkpoint DB out of the commit.
        git("git", "add", "-A", "--", ".", ":(exclude)build_graph.db*")
        if git("git", "diff", "--cached", "--name-only"):
            git("git", "commit", "-m", f"{prefix}: {title}")
        git("git", "push", "-u", "origin", branch)

        body = (
            f"{details}\n\n"
            f"## Implementation\n{state.get('implementation', '')}\n\n"
            "Code review: passed · QA: passed"
        )
        existing = subprocess.run(
            ["gh", "pr", "view", branch, "--json", "url", "-q", ".url"],
            capture_output=True, text=True,
        )
        if existing.returncode == 0 and existing.stdout.strip():
            pr_url = existing.stdout.strip()
        else:
            pr_url = git(
                "gh", "pr", "create",
                "--base", base, "--head", branch,
                "--title", f"{prefix}: {title}", "--body", body,
            ).splitlines()[-1]
    except subprocess.CalledProcessError as e:
        node_done("ship")
        return {"pr_error": f"{' '.join(e.cmd)}\n{e.stderr or e.stdout}".strip()}

    node_done("ship")
    return {"pr_url": pr_url, "pr_error": ""}


# --- routing ---


def after_critic(state: BuildState):
    if (
        state.get("plan_verdict") == "NEEDS REWORK"
        and state.get("plan_attempts", 0) < 2
    ):
        return "designer"
    return "sign_off"


def after_sign_off(state: BuildState):
    if state.get("plan_decision") == "APPROVED":
        return "implementer"
    return "designer"


def after_implementer(state: BuildState):
    if state.get("escalation"):
        return "escalation"
    return ["code_critic", "qa"]


def after_escalation(state: BuildState):
    return state.get("escalation_source", "implementer")


def after_code_critic_and_qa(state: BuildState):
    if (
        state.get("code_verdict") == "NEEDS REWORK"
        and state.get("implementation_attempts", 0) < 2
    ):
        return "implementer"

    if (
        state.get("qa_verdict") == "NEEDS REWORK"
        and state.get("implementation_attempts", 0) < 2
    ):
        return "implementer"

    if state.get("failed"):
        return END
    return "ship"


# --- graph ---

builder = StateGraph(BuildState)
builder.add_node("designer", designer)
builder.add_node("plan_critic", plan_critic)
builder.add_node("sign_off", sign_off)
builder.add_node("implementer", implementer)
builder.add_node("code_critic", code_critic)
builder.add_node("qa", qa)
builder.add_node("escalation", escalation)
builder.add_node("fix_or_ship", fix_or_ship)
builder.add_node("ship", ship)

builder.add_edge(START, "designer")
builder.add_edge("designer", "plan_critic")
builder.add_edge("code_critic", "fix_or_ship")
builder.add_edge("qa", "fix_or_ship")
builder.add_edge("ship", END)

builder.add_conditional_edges("plan_critic", after_critic)
builder.add_conditional_edges("sign_off", after_sign_off)
builder.add_conditional_edges("implementer", after_implementer)
builder.add_conditional_edges("escalation", after_escalation)
builder.add_conditional_edges("fix_or_ship", after_code_critic_and_qa)

# --- cli ---
#
# Usage:
#   python3 build_graph.py --card WHIT-123 --type Bug          → existing card
#   python3 build_graph.py "add a chat button for spending"    → ad-hoc request
#   python3 build_graph.py --thread abc123 --resume "go"       → resume
#   python3 build_graph.py --thread abc123 --status            → show pause point
#
# If no --card, the request text is the card. A short thread ID is
# generated from a hash so the checkpoint has a clean key.

import argparse
import asyncio
import hashlib

parser = argparse.ArgumentParser()
parser.add_argument("request", nargs="?", default=None)
parser.add_argument("--card", default=None)
parser.add_argument("--details", default=None)
parser.add_argument("--type", default="", help="card type, e.g. Story or Bug")
parser.add_argument("--thread", default=None)
parser.add_argument("--resume", default=None)
parser.add_argument("--status", action="store_true")
args = parser.parse_args()

if args.resume and not args.thread:
    parser.error("--resume requires --thread")

if args.status and not args.thread:
    parser.error("--status requires --thread")

if args.card:
    card_number = args.card
    card_details = args.details or ""
    if not card_details:
        parser.error(f"--card {args.card} requires --details (fetch from Notion first)")
    thread_id = args.card
elif args.request:
    card_number = ""
    card_details = args.request
    thread_id = hashlib.sha256(args.request.encode()).hexdigest()[:8]
elif not args.resume:
    parser.error("provide a request or --card")

if args.thread:
    thread_id = args.thread

config: RunnableConfig = {"configurable": {"thread_id": thread_id}}


async def main():
    async with AsyncSqliteSaver.from_conn_string("build_graph.db") as saver:
        await saver.setup()
        graph = builder.compile(checkpointer=saver)

        if args.status:
            state = await graph.aget_state(config)
            if not state or not state.values:
                print(f"No saved build found for thread {thread_id}.")
                return
            values = state.values
            print(f"Thread: {thread_id}")
            print(f"Card: {values.get('card_number', '?')}")
            print(f"Next node: {state.next}")
            if values.get("plan"):
                print(f"Plan: present ({len(values['plan'])} chars)")
            print(f"Plan verdict: {values.get('plan_verdict', 'pending')}")
            print(f"Plan decision: {values.get('plan_decision', 'pending')}")
            if values.get("implementation"):
                print(f"Implementation: present ({len(values['implementation'])} chars)")
            print(f"Code verdict: {values.get('code_verdict', 'pending')}")
            print(f"QA verdict: {values.get('qa_verdict', 'pending')}")
            if values.get("pr_url"):
                print(f"PR: {values['pr_url']}")
            if values.get("escalation"):
                print(f"Escalation: {values['escalation'][:100]}...")
            return

        if args.resume is not None:
            prior = await graph.aget_state(config)
            if prior and prior.values:
                print_resume_recap(prior.values)
            result = await graph.ainvoke(Command(resume=args.resume), config)
        else:
            await saver.adelete_thread(thread_id)
            print(f"Starting build (thread {thread_id})...\n")
            result = await graph.ainvoke(
                {
                    "card_number": card_number,
                    "card_details": card_details,
                    "card_type": args.type,
                },
                config,
            )

        interrupts = result.get("__interrupt__")
        if interrupts:
            print("\n" + "=" * 60)
            print(interrupts[0].value)
            print("=" * 60)
            print(f"\nPaused. Resume with:")
            print(f'  python3 build_graph.py --thread {thread_id} --resume "your answer"')
        elif result.get("failed"):
            print("\n" + "=" * 60)
            print("BUILD FAILED — unresolved issues after max fix attempts:")
            if result.get("code_feedback"):
                print(f"\n## Code review:\n{result['code_feedback']}")
            if result.get("qa_feedback"):
                print(f"\n## QA:\n{result['qa_feedback']}")
            print("=" * 60)
        elif result.get("pr_error"):
            print("\n" + "=" * 60)
            print("BUILD PASSED but opening the PR failed:")
            print(result["pr_error"])
            print("=" * 60)
        else:
            if result.get("pr_url"):
                print(f"\nPR opened: {result['pr_url']}")
            print("\nDone.")


asyncio.run(main())
