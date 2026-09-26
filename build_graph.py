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
#                          /           \
#                   implementer        END
#                (NEEDS REWORK      (all good)
#                  & attempts < 2)
from claude_agent_sdk import ClaudeAgentOptions, ResultMessage, query
import sys
from typing import NotRequired, TypedDict

from langgraph.checkpoint.sqlite.aio import AsyncSqliteSaver
from langgraph.graph import END, START, StateGraph
from langchain_core.runnables import RunnableConfig
from langgraph.types import Command, interrupt


class BuildState(TypedDict):
    card_number: str
    card_details: str
    plan: NotRequired[str]
    plan_verdict: NotRequired[str]
    plan_attempts: NotRequired[int]
    plan_decision: NotRequired[str]
    plan_feedback: NotRequired[str]
    implementation_attempts: NotRequired[int]
    implementation: NotRequired[str]
    code_verdict: NotRequired[str]
    qa_verdict: NotRequired[str]
    escalation: NotRequired[str]
    escalation_source: NotRequired[str]
    escalation_answer: NotRequired[str]


# --- helpers ---

PROJECT_CONTEXT = open("project-context.md").read()


def agent_prompt(agent_file: str) -> str:
    return open(f".claude/agents/{agent_file}").read() + "\n\n" + PROJECT_CONTEXT


# --- nodes ---


async def designer(state: BuildState):
    print("designer running")
    prompt = (
        f"Card: {state.get('card_number')}, Details: {state.get('card_details', '')}"
    )
    feedback = state.get("plan_feedback", "")
    if feedback:
        prompt += f"\nPrevious plan was rejected. Feedback: {feedback}"

    options = ClaudeAgentOptions(
        system_prompt=agent_prompt("solution-designer.md"),
        allowed_tools=["Read", "Grep", "Glob", "Bash"],
    )

    async for message in query(prompt=prompt, options=options):
        if isinstance(message, ResultMessage):
            return {
                "plan": message.result,
                "plan_attempts": state.get("plan_attempts", 0) + 1,
            }


async def plan_critic(state: BuildState):
    print("plan_critic running")
    plan = state.get("plan", "")
    prompt = f"Card: {state.get('card_number')}\n\nProposed plan:\n{plan}"

    options = ClaudeAgentOptions(
        system_prompt=agent_prompt("solution-critic.md"),
        allowed_tools=["Read", "Grep", "Glob", "Bash"],
    )

    async for message in query(prompt=prompt, options=options):
        if isinstance(message, ResultMessage):
            verdict = message.result
            if "NEEDS REWORK" in verdict:
                return {"plan_verdict": "NEEDS REWORK"}
            return {"plan_verdict": "APPROVED"}


def sign_off(state: BuildState):
    print("sign_off running")
    answer = interrupt(
        f"Plan: {state.get('plan')}, Verdict: {state.get('plan_verdict')}, "
        f"Attempts: {state.get('plan_attempts', 0)}. Approve?"
    )
    if answer == "go":
        return {"plan_decision": "APPROVED", "plan_feedback": ""}
    else:
        return {
            "plan_decision": "REJECTED",
            "plan_feedback": answer,
            "plan_attempts": 0,
        }


async def implementer(state: BuildState):
    print("implementer running")
    plan = state.get("plan", "")
    prompt = f"Card: {state.get('card_number')}\n\nApproved plan:\n{plan}"

    escalation_answer = state.get("escalation_answer", "")
    if escalation_answer:
        prompt += f"\n\nYou previously escalated a decision. The answer: {escalation_answer}"

    options = ClaudeAgentOptions(
        system_prompt=agent_prompt("implementer.md"),
        allowed_tools=["Read", "Grep", "Glob", "Edit", "Write", "Bash"],
    )

    async for message in query(prompt=prompt, options=options):
        if isinstance(message, ResultMessage):
            if "ESCALATION:" in message.result:
                return {
                    "escalation": message.result,
                    "escalation_source": "implementer",
                }
            return {
                "implementation": message.result,
                "implementation_attempts": state.get("implementation_attempts", 0) + 1,
                "escalation_answer": "",
            }


async def code_critic(state: BuildState):
    print("code_critic running")
    prompt = (
        f"Card: {state.get('card_number')}\n\n"
        f"Review the implementation changes."
    )

    options = ClaudeAgentOptions(
        system_prompt=agent_prompt("code-critic.md"),
        allowed_tools=["Read", "Grep", "Glob", "Bash"],
    )

    async for message in query(prompt=prompt, options=options):
        if isinstance(message, ResultMessage):
            if "DO NOT SHIP" in message.result:
                return {"code_verdict": "NEEDS REWORK"}
            return {"code_verdict": "APPROVED"}


async def qa(state: BuildState):
    print("qa running")
    prompt = (
        f"Card: {state.get('card_number')}\n\n"
        f"Plan:\n{state.get('plan', '')}\n\n"
        f"Test the implementation changes."
    )

    options = ClaudeAgentOptions(
        system_prompt=agent_prompt("qa.md"),
        allowed_tools=["Read", "Grep", "Glob", "Bash"],
    )

    async for message in query(prompt=prompt, options=options):
        if isinstance(message, ResultMessage):
            if "real bug" in message.result.lower():
                return {"qa_verdict": "NEEDS REWORK"}
            return {"qa_verdict": "APPROVED"}


def escalation(state: BuildState):
    print("escalation running")
    answer = interrupt(state.get("escalation", ""))
    return {"escalation_answer": answer, "escalation": ""}


def fix_or_ship(state: BuildState):
    print("fix_or_ship running")
    return {}


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
    return END


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

builder.add_edge(START, "designer")
builder.add_edge("designer", "plan_critic")
builder.add_edge("code_critic", "fix_or_ship")
builder.add_edge("qa", "fix_or_ship")

builder.add_conditional_edges("plan_critic", after_critic)
builder.add_conditional_edges("sign_off", after_sign_off)
builder.add_conditional_edges("implementer", after_implementer)
builder.add_conditional_edges("escalation", after_escalation)
builder.add_conditional_edges("fix_or_ship", after_code_critic_and_qa)

# --- cli ---

card_number = sys.argv[1]
config: RunnableConfig = {"configurable": {"thread_id": card_number}}


def show_interrupt(result: dict) -> bool:
    interrupts = result.get("__interrupt__")
    if not interrupts:
        return False
    value = interrupts[0].value
    print("\n" + "=" * 60)
    print(value)
    print("=" * 60)
    return True


async def main():
    async with AsyncSqliteSaver.from_conn_string("build_graph.db") as saver:
        graph = builder.compile(checkpointer=saver)
        await saver.adelete_thread(card_number)

        print(f"Starting build for {card_number}...\n")
        result = await graph.ainvoke(
            {"card_number": card_number, "card_details": "some details"}, config
        )

        while show_interrupt(result):
            answer = input("\n> ").strip()
            if not answer:
                continue
            result = await graph.ainvoke(Command(resume=answer), config)

        print("\nDone.")


import asyncio

asyncio.run(main())
