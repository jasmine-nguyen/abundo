---
description: Run the build graph for a card or request
---

Run the build pipeline using `build_graph.py`.

Read `project-context.md` first. It contains the board data source ID,
card prefix, default card type, and any skip patterns.

## Resuming a stopped build

If the user says "resume" or "continue the build" (and `$ARGUMENTS` is
empty or says "resume"), check the conversation for the last paused build.
You'll have the thread ID and card number from the earlier run. Resume with:
`python3 build_graph.py --thread <id> --resume "go"`
Then continue from step 3 below.

## Starting a new build

1. Figure out what to build:
   - If `$ARGUMENTS` looks like a card number (matches the card prefix from
     project-context.md, e.g. CAD-38, WHIT-123), fetch the card's title and
     description from Notion first.
   - If `$ARGUMENTS` is a plain-text request (not a card number), create a
     new card on the board first: use `notion-create-pages` with the board
     data source, set Type to the default card type from project-context.md,
     Status = 'To Do', and a clear title. Once created, fetch the card to
     get its assigned number.
   - If `$ARGUMENTS` is empty, pick the next actionable card from the board:
     query the data source for Status IN ('To Do', 'In Progress'), ordered
     by priority using:
     `CASE "Priority" WHEN 'High' THEN 1 WHEN 'Medium' THEN 2 WHEN 'Low' THEN 3 ELSE 4 END ASC`
     If project-context.md lists skip patterns, add a WHERE clause to
     exclude cards whose title contains those patterns. Take the first row.
     Fetch it.
   - Echo which card you're building and why before continuing.

2. Run the script:
   `python3 build_graph.py --card <number> --details "<title and description>"`

   While it runs, give the user short status updates based on the output.
   The script prints which node is running and what tools it's using. Relay
   the key milestones:
   - "Designer is planning..." (when you see `▶ Designer`)
   - "Plan critic is reviewing..." (when you see `▶ Plan Critic`)
   - "Implementer is coding..." (when you see `▶ Implementer`)
   - "Code review in progress..." (when you see `▶ Code Review`)
   - "QA testing..." (when you see `▶ QA`)
   Don't flood — one line per node is enough.

3. If the script pauses (prints "Paused. Resume with:"), summarise the
   plan for the user before asking. Show:
   - **Task:** what we're building (1-2 sentences, plain english)
   - **Plan:** the approach (bullet points, plain english, no jargon)
   - **Risks:** anything to watch out for (or "None" if clean)

   Then present options using AskUserQuestion:
   - "Approve" — resume with "go"
   - "Rework" — ask for feedback, then resume with that feedback
   - "Stop" — end the build, don't resume

4. Based on the user's choice, run the resume command shown in the output
   (e.g. `python3 build_graph.py --thread <id> --resume "go"`)

   While the resumed script runs, relay progress the same way as step 2:
   one short status line per node ("Implementer is coding...",
   "Code review in progress...", etc.). Don't go silent — the user needs
   to see the build is alive and which stage it's at.

5. Repeat steps 3-4 until the script prints "Done."

6. Once done, update the card's Status to 'Done' on the board.
