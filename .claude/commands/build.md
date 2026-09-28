---
description: Run the build graph for a card or request
---

Run the build pipeline using `build_graph.py`.

Run the script with `.venv/bin/python` when the repo has a `.venv` (a cloud
session always does: the repo's session hook creates it), otherwise with
`python3`. The commands below write `python3`; use the same one throughout.

Read `project-context.md` first. It contains the board data source ID,
card prefix, default card type, card picking rules (sort field,
blocker relation, skip patterns), and the check commands the pipeline runs.

## Resuming a stopped build

If the user says "resume" or "continue the build" (and `$ARGUMENTS` is
empty or says "resume"), find the thread ID from the conversation (it's
the card number for card builds) and check where it is:
`python3 build_graph.py --thread <id> --status`
- "Paused: waiting for your reply" → go to step 3 and handle the pause.
- A next step but no pause → it stopped on an error: `--retry`.
- Finished with outcome `failed` → step 5, BUILD FAILED.

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

2. Set the card's Status to 'In Progress'. Write the card's title and
   description to `.build/cards/<card number>.md` with the Write tool —
   never paste card text into a shell command, where quotes or `$(...)`
   in the card would break or run. Then run:
   `python3 build_graph.py --card <number> --type "<card Type>" --details-file .build/cards/<number>.md`

   **In a cloud session** (`CLAUDE_CODE_REMOTE` is `true`), add
   `--branch <your session's branch>`: the branch your session instructions
   tell you to develop on and push to. A cloud session can push only that
   branch, so the script refuses to start without it. If you don't know the
   branch, ask the user.

   `--type` sets the branch, commit and PR prefix: Story/Feature → `feat`,
   Bug/Defect → `fix`, Chore → `chore`, Refactor → `refactor`, Docs → `docs`.
   Anything else falls back to `feat`. Bug and Defect cards also take the
   bug path: the bug is reproduced with a failing test before it's fixed.

   The script refuses to start if tracked files have uncommitted changes,
   or if a build for this card already exists. Relay the message; only add
   `--restart` if the user wants to throw the old build away.

   While it runs, give the user short status updates based on the output.
   The script prints which step is running and what tools it's using.
   Relay the key milestones, one line per step:
   - "Designer is planning..." (`▶ Designer`)
   - "Plan critic is reviewing..." (`▶ Plan Critic`)
   - "Reproducing the bug..." (`▶ Reproducer`)
   - "Writing the acceptance tests..." (`▶ Test Writer`)
   - "Implementer is coding..." (`▶ Implementer`)
   - "Running typecheck, lint and tests..." (`▶ Checks`)
   - "Four reviewers are checking the change..." (`▶ Standards Review` etc.)
   - "Opening the PR..." (`▶ Ship`)
   Don't flood, and don't go silent.

3. When the script pauses, it prints a block between `===` lines and
   `Paused. Resume with: ...`. The first line of the block says why:

   - **PLAN FOR REVIEW** — show the user the block: the critic's verdict
     and findings, the summary, the test points, any slices, and the
     plan file path (they can edit that file directly before approving).
     If it lists decisions (Q1, Q2, ...), ask them with AskUserQuestion,
     putting the recommended answer first and marking it "(Recommended)".
     Then offer: Approve · Rework · Stop.
   - **CARD LOOKS INVALID** — show the evidence and ask: Close the card ·
     Plan it anyway (ask why it's still needed) · Stop.
   - **QUESTIONS BEFORE PLANNING** — the card was too thin to plan. Ask the
     questions with AskUserQuestion, recommended answer first.
   - **DECISION NEEDED** — an agent hit a decision it shouldn't make alone
     (or couldn't reproduce the bug, or write failing tests). Show it and
     ask the user; offer the options it lists and any hint on the last
     line (`skip`, `unpin`).
   - **RETRO PROPOSALS** — lines to add to project-context.md, learned from
     this build's friction. Ask which to add (all, some, or none).

   Every pause also accepts **Stop**: it ends the build there and nothing
   ships.

   Never answer a pause yourself: every one of them is the user's call.

4. Resume with the user's reply:
   `python3 build_graph.py --thread <id> --resume "<reply>"`

   Any pause: `stop` ends the build.

   | Pause | Reply |
   |---|---|
   | PLAN FOR REVIEW | `go` (recommended answers) · `go: Q1 <answer>; Q2 <answer>` · `rework: <feedback>` |
   | CARD LOOKS INVALID | `close` · `rework: <why it's still needed>` |
   | QUESTIONS BEFORE PLANNING | `go` (recommendations) or `Q1: <answer>; Q2: <answer>` |
   | DECISION NEEDED | the decision in plain words · `skip` · `unpin: <reason>` |
   | RETRO PROPOSALS | `go` · `go: 1,3` · `skip` |

   If the reply contains quotes, backticks or `$`, pass it through a
   quoted heredoc so the shell doesn't touch it:
   ```
   python3 build_graph.py --thread <id> --resume "$(cat <<'EOF'
   <reply>
   EOF
   )"
   ```
   If the user chose Stop, resume with `stop`: the build is closed out
   properly instead of left hanging, and nothing more runs.

   While the resumed script runs, relay progress the same way as step 2.

5. Repeat steps 3–4 until the script ends with one of these:

   - **PR opened: <url>** — relay the link. The script already committed,
     pushed and opened the PR.
   - **BUILD CANCELLED** — the user stopped it. Set the card's Status back
     to 'To Do', and mention the branch if the script printed one.
   - **CARD CLOSED** — the user agreed the card isn't needed. Set its Status
     to 'Done' (or the board's won't-do option) and add a comment with the
     evidence.
   - **BUILD FAILED** — the automatic loop ran out of rounds. Don't ask the
     user what to do: read the findings below the line, fix them yourself
     in the codebase (don't edit pinned test files; if one is wrong, ask the
     user), then run
     `python3 build_graph.py --thread <id> --recheck`
     to re-run the checks and all four reviews on your fixes. Repeat until
     it passes.
   - **BUILD STOPPED** — a step errored (an agent ran out of turns or
     budget, returned no verdict, or files changed that shouldn't have).
     Show the user the error, fix the cause if it's yours to fix, then
     `--retry`. Don't retry blindly in a loop.
   - **BUILD PASSED but opening the PR failed** — show the error; once the
     cause is fixed (e.g. `gh auth login`), `--retry`.

6. After the run:
   - If it printed **TECH DEBT CARDS TO FILE**, create each one on the board
     (Status 'To Do', Type 'Tech Debt' if the board has it, otherwise the
     default card type), and tell the user they were filed.
   - If it printed **CHECKS WORTH AUTOMATING**, pass the ideas on to the user
     in one short list; don't implement them unasked.
   - Once the PR is open, update the card's Status to 'Done'.
