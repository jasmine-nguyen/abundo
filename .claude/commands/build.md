---
description: Run the build graph for a card or request
---

Run the build pipeline using `build_graph.py`.

Read `project-context.md` first. It contains the board data source ID,
card prefix, default card type, and card picking rules (sort field,
blocker relation, skip patterns).

## Resuming a stopped build

If the user says "resume" or "continue the build" (and `$ARGUMENTS` is
empty or says "resume"), check the conversation for the last paused build.
You'll have the thread ID and card number from the earlier run. Resume with:
`python3 build_graph.py --thread <id> --resume "go"`
Then continue from step 3 below.

## Starting a new build

1. Figure out what to build:

   **a) Card number given** — `$ARGUMENTS` looks like a card number
   (matches the card prefix from project-context.md, e.g. CAD-92, WHIT-42)
   or a bare number (e.g. 92). Look the card up by "Card ID". Fetch its
   title, description, and Type.

   If project-context.md has a blocker relation, check whether all
   blockers have Status = 'Done'. If not, warn the user, list the
   unfinished blockers, and ask whether to continue anyway.

   **b) Plain-text request** — `$ARGUMENTS` is not a card number. Create
   a new card on the board: use `notion-create-pages` with the board data
   source, Status = 'To Do', and a clear title. Set Type from the request:
   if it reports something broken or asks to look into an issue, use
   `Bug` (or `Defect` if that's the board's option); if it asks for new behaviour, use `Story`; otherwise use the
   default card type from project-context.md. Leave the sort field empty. Tell
   the user to set the sort field and blockers on the board later. Fetch
   the card to get its assigned number.

   **c) Empty** — `$ARGUMENTS` is empty. Pick the next actionable card:

   If project-context.md has a **sort field** and **blocker relation**:
   1. Query cards with Status = 'To Do' and a non-empty sort field,
      sorted by the sort field ascending. Include url, Card ID, Name,
      the sort field, and the blocker relation.
   2. Walk that list in order. For each card:
      - If project-context.md has skip patterns, skip cards whose Name
        contains any pattern.
      - Read the blocker relation. For each blocker URL, check its
        Status. A card is ready only when every blocker is Done.
        (No blockers = ready.)
   3. Pick the first ready card.
   4. If any card has Status = 'In Progress', mention it and ask
      whether to resume that instead.
   5. Echo the chosen card, its sort value, and a one-line note for
      any lower-order cards that were skipped — include which blocker
      is holding each one up.
   6. If no card is ready, say so and list the blocked cards with
      their blockers. Don't pick anything.

   If project-context.md does **not** have a sort field (fallback):
   1. Query cards with Status IN ('To Do', 'In Progress'), ordered by:
      `CASE "Priority" WHEN 'High' THEN 1 WHEN 'Medium' THEN 2 WHEN 'Low' THEN 3 ELSE 4 END ASC`
   2. If project-context.md has skip patterns, exclude cards whose Name
      contains those patterns.
   3. Take the first row. Fetch it.

   Echo which card you're building and why before continuing.

2. Run the script:
   `python3 build_graph.py --card <number> --type "<card Type>" --details "<title and description>"`

   `--type` sets the branch, commit and PR prefix: Story/Feature → `feat`,
   Bug/Defect → `fix`, Chore → `chore`, Refactor → `refactor`, Docs → `docs`.
   Anything else falls back to `feat`.

   While it runs, give the user short status updates based on the output.
   The script prints which node is running and what tools it's using. Relay
   the key milestones:
   - "Designer is planning..." (when you see `▶ Designer`)
   - "Plan critic is reviewing..." (when you see `▶ Plan Critic`)
   - "Implementer is coding..." (when you see `▶ Implementer`)
   - "Code review in progress..." (when you see `▶ Code Review`)
   - "QA testing..." (when you see `▶ QA`)
   Don't flood — one line per node is enough.

3. If the script pauses (prints "PLAN FOR REVIEW" between === lines),
   you MUST show the full plan to the user BEFORE the approval prompt.
   Format it as:
   - **Task:** what we're building (1-2 sentences, plain english)
   - **Plan:** the approach (bullet points, plain english, no jargon)
   - **Risks:** anything to watch out for (or "None" if clean)

   The plan is printed by the script between the === lines — read it
   and present it clearly. Do NOT skip this or collapse it into one
   sentence. The user needs to review the plan before deciding.

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

   When both code review and QA pass, the script commits, pushes, and
   opens the PR itself — don't ask the user for confirmation. Relay the
   "PR opened: <url>" line. If it prints "opening the PR failed", show
   the error and stop.

6. Once done, update the card's Status to 'Done' on the board.
