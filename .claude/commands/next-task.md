---
description: Pick a backlog card from the Notion board, research it, and produce a reviewed implementation plan. Plan-and-pause — never writes code, commits, or pushes.
---

Run the **plan-and-pause** stage of the backlog pipeline. You orchestrate; the
work happens in subagents. You do NOT edit code, commit, or push in this
command — you stop at an approved plan.

Board data source: `collection://d6aa9744-6cc4-4fb3-9d5d-164d82c88a0d`
Target card (optional): $ARGUMENTS

## Steps

1. **Select the card.**
   - If `$ARGUMENTS` names a card (a title fragment or a priority number), use
     the Notion `query-data-sources` tool to fetch that exact card.
   - Otherwise select the next actionable card: `Type = 'Task'` and
     `Status IN ('To Do','In Progress')`, ordered by `Priority ASC`, first row.
   - Fetch the card's full page (`notion-fetch`) to get any description/body.
   - Echo back which card you picked and why before continuing.

2. **Plan (subagent).** Spawn the `backlog-planner` agent with the card title +
   description. It returns a file-level plan. Do not plan it yourself — let the
   agent do it so the context stays isolated and reusable.

3. **Critique (subagent, in parallel-ready form).** Spawn the `plan-critic`
   agent with the card AND the planner's plan. It returns an adversarial review.
   (Right now that's one critic; later you can fan out several with different
   lenses — correctness, security, test-coverage — and require a majority.)

4. **Synthesize.** Reconcile the plan with the critique:
   - If the critic says NEEDS REWORK, send the problems back to a fresh
     `backlog-planner` run and repeat once.
   - Otherwise produce a final plan folding in the accepted tweaks.

5. **STOP and present.** Show the user, concisely:
   - The card and the "done" definition.
   - The final approach + the exact list of files that would change.
   - Any open questions the critic raised that need a human decision.
   - The proposed test plan.
   Then ask: **"Approve this plan? I'll implement on the branch once you say go."**

Hard rules:
- Do NOT use Edit/Write on source files, do NOT commit, do NOT push, do NOT
  touch the Notion card's status in this command. This stage produces a plan
  only. Implementation is a separate, explicitly-approved step.
