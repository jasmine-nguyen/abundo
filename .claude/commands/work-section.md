---
description: Take the next N (default 2) actionable Task cards from ONE Phase and run each through the /next-task pipeline. Bounded batch — never exceeds N, never more than 3.
---

Run a **bounded batch** of the backlog pipeline over a single Phase. You are the
orchestrator: you select the cards, then run the existing per-card flow for each.
You do NOT invent a new pipeline here — you reuse `/next-task`'s stages and keep
every one of its gates.

Board data source: `collection://d6aa9744-6cc4-4fb3-9d5d-164d82c88a0d`
Input ($ARGUMENTS): a Phase name, optionally followed by a count. e.g.
`/work-section Phase 3 — Budget Engine 2`. Default count = 2. HARD max = 3.

## 1. Parse input
- Read the Phase from $ARGUMENTS. It must match one of the board's Phase values
  exactly (Phase 1 — Data & Persistence … Phase 5 — Notifications). If no Phase
  is given, or it doesn't match, STOP and ask which Phase — never guess.
- Read the count. Default to 2 if absent. If it exceeds the hard max of 3, clamp
  to 3 and tell me you did.

## 2. Select the cards — ONCE, up front
Query the data source a single time:
    Type = 'Task'
    AND Phase = <the parsed Phase>
    AND Status IN ('To Do','In Progress')
    ORDER BY Priority ASC
    LIMIT <count>

Capture that list of cards NOW and work only from it for the rest of the run.
Do NOT re-query between cards: step 3 changes card Status to In Progress, and a
re-query would re-pick or skip cards (selection drift). Select once, iterate over
the captured list.

Then branch on how many came back:
- **0 cards** → STOP. Report: "Phase <X> has no actionable Task cards
  (nothing in To Do / In Progress). Section is clear." This is a SUCCESS, not an
  error — do not proceed, do not fabricate work, do not widen the query.
- **fewer than count** → say so ("asked for N, found M"), then proceed with the M
  you have.
- **count or more** → take exactly the first <count>. (LIMIT already enforces this.)

Echo the selected cards (name + priority) back to me before doing any work.

## 3. Work each card — bounded loop, gates intact
For each card in the captured list, in Priority order (lowest first):
- Run the per-card pipeline exactly as `/next-task` does it: select is already
  done, so proceed to plan (`backlog-planner`) → adversarial review
  (`plan-critic`) → present the reconciled plan → PAUSE for my approval.
- Every gate stays. A batch of N is N independent, fully-gated runs — never one
  run that fast-paths past my approval to "save time."
- Announce which card (e.g. "Card 1 of 2: <name>") before starting each.

## 4. On rejection or failure — STOP the batch
If I reject a card's plan, or a stage fails, STOP the whole batch there. Do not
silently roll on to the next card. Report which cards were completed, which was
in flight, and which remain untouched, so the state is unambiguous. (Safe default;
if I explicitly say "skip and continue" you may move to the next card instead.)

## Hard rules
- Never work more than <count> cards, and never more than 3, in a single run.
- Never touch a card outside the named Phase.
- Never change a card's Status or push anything without my go — this command
  inherits `/next-task`'s plan-and-pause posture; it does not add new authority.
