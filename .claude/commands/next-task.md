---
description: Take one backlog card from plan to reviewed, tested code. Two gates — you approve the plan, then approve the finished change before it's pushed. Never commits or pushes without your go.
---

Run the full backlog pipeline for ONE card. You are the orchestrator: subagents
plan and review; you implement and hold all authority (edits, commits, pushes,
Notion writes). There are TWO human gates — the plan, and the finished change —
and you stop at both.

Board data source: `collection://d6aa9744-6cc4-4fb3-9d5d-164d82c88a0d`
Target card (optional): $ARGUMENTS

---

## Phase 1 — Plan (gate 1)

1. **Select the card.**
   - If `$ARGUMENTS` names a card (a title fragment or a priority number), use
     the Notion `query-data-sources` tool to fetch that exact card.
   - Otherwise select the next actionable card: `Type = 'Task'` and
     `Status IN ('To Do','In Progress')`, ordered by `Priority ASC`, first row.
   - Fetch the card's full page (`notion-fetch`) to get any description/body.
   - Echo back which card you picked and why before continuing.

2. **Plan (subagent).** Spawn the `backlog-planner` agent with the card title +
   description. It returns a file-level plan. Don't plan it yourself — let the
   agent do it so the context stays isolated.

3. **Critique (subagent).** Spawn the `plan-critic` agent with the card AND the
   plan. It returns an adversarial review. If it says NEEDS REWORK, send the
   problems back to a fresh `backlog-planner` run and repeat once.

4. **Present + PAUSE (gate 1).** Show the user, concisely: the card and its
   "done" definition, the final approach, the exact files that would change, any
   escalation / open questions needing a human call, and the test plan. Then ask:
   **"Approve this plan? Say go and I'll implement it."** Do not proceed until the
   user approves. Fold any changes they ask for into the plan first.

## Phase 2 — Implement (only after gate 1 approval)

5. **Branch.** Put the work on its own branch for this card (create it from the
   current base if not already on a card branch), so the change is reviewable in
   isolation and can become its own PR.

6. **Build it** per the approved plan. Make the smallest change that satisfies
   the "done" definition. Match the surrounding code's conventions.
   - **Escalate, don't guess.** If you hit an architecturally significant or
     hard-to-reverse decision the plan didn't settle (new table/schema, sync vs
     async, a new dependency, a public API/auth choice), STOP and ask the user
     — a short multiple-choice question — then continue. Never resolve such a
     fork silently mid-implementation.

7. **Self-check.** Run the project's tests and typecheck for anything the change
   touches (e.g. `python -m pytest`, `npx tsc --noEmit`). Fix what you broke.
   Report the results. Do not proceed to review with a red test suite unless the
   user explicitly says to.

## Phase 3 — Verify (the gate that code-critic enforces)

8. **Review (subagent).** Spawn the `code-critic` agent on the change (the branch
   / working-tree diff). It returns a verdict, plus bugs, craft, escalations, and
   any tech-debt cards.

9. **Resolve the verdict — bounded.**
   - **Decisions to escalate** → surface to the user and pause; don't decide for
     them.
   - **Bugs + fix-now craft** (SHIP AFTER FIXES / DO NOT SHIP) → fix them, re-run
     the self-check, then re-run `code-critic`. Cap this at **2 review rounds**:
     if it still isn't SHIP after two, STOP and hand the user the remaining
     findings rather than looping forever.
   - **Deferred craft** → collect the proposed tech-debt CARD blocks; you'll
     offer to file them at gate 2. Do NOT file them yet.

## Phase 4 — Finish (gate 2)

10. **Present + PAUSE (gate 2).** Show the user: what you built, the final diff
    summary, the `code-critic` verdict (should be SHIP), test/typecheck results,
    and the list of proposed tech-debt cards. Then ask:
    **"Approve this change? On go I'll commit, push, file the tech-debt cards,
    and move the card to Done."**

11. **On go — apply side effects (only now):**
    - Commit and push the branch.
    - File the approved tech-debt cards to the board (`notion-create-pages`).
    - Update the worked card's `Status` (In Progress → Done, or as the user
      directs).
    - Do NOT open a PR unless the user asks.

## Hard rules
- Two hard stops: never implement before gate-1 approval; never commit, push, or
  write to Notion before gate-2 approval.
- code-critic's gate is real: don't push a change it marked SHIP AFTER FIXES /
  DO NOT SHIP with the must-fix items unresolved.
- Escalate architectural / hard-to-reverse decisions instead of guessing, at
  whatever phase they surface.
