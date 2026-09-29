---
description: Run the build graph for a card or request
---

Run the build pipeline using `build_graph.py`.

Run the script with `.venv/bin/python` when the repo has a `.venv` (a cloud
session always does: the repo's session hook creates it), otherwise with
`python3`. The commands below write `python3`; use the same one throughout.

A build runs for many minutes, far past a foreground shell command's timeout, and
a killed run loses the step it was on. So run every `build_graph.py` command except
`--status` in the background (Bash `run_in_background`), and follow its output as
it arrives.

## Plain English is critical

The user knows the app but doesn't read the code. Every message and question they
see from you must make sense without opening the repo. If they can't understand
it, they pick blind or the build stalls while you explain. Both are worse than
taking a moment to write it clearly.

- No file paths, function or variable names, config keys, test names, git terms or
  library jargon. Say what the thing does: "the list of files each test reloads",
  not `_COLLIDING`. If a technical word is truly unavoidable, define it in a few
  words the first time.
- Short sentences, one idea per bullet. Lead with what the user will notice (a
  slower test run, a behaviour change, a risk), not with how the code works.
- Every option says what happens if they pick it and what it costs, in everyday
  words. An option label is a few plain words ("Automatic", "Keep the list"), never
  a code term.
- Agents write their pause messages for the user, but some still slip into code
  talk. You're the last check: if any line of a pause needs the code to make sense,
  rewrite it in plain English before you show it or ask. Keep every option and its
  meaning. Only the wording changes.
- If the user answers with a question ("what does this mean?"), the wording failed.
  Explain it more simply, with a concrete example, and ask again.
- Words that slip through, and what to say instead:
  endpoint → "the server address the app calls" · schema → "how the data is
  stored" · migration → "a one-off change to data already saved" · cache → "a
  saved copy" · refactor → "reorganise the code, same behaviour" · regression →
  "something that worked before breaking" · edge case → "an unusual situation,
  like an empty list" · race condition → "two things happening at once and
  clashing" · null/undefined → "missing" · deploy → "release" · helper/module →
  say what it does ("the part that works out totals").

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
   description to `.build/cards/<card ID>.md` with the Write tool —
   never paste card text into a shell command, where quotes or `$(...)`
   in the card would break or run. Then run:
   `python3 build_graph.py --card <card ID> --type "<card Type>" --details-file .build/cards/<card ID>.md`

   `<card ID>` is the full ID with its prefix (e.g. `WHIT-622`, not `622`),
   even if the user typed a bare number. It names the build, the branch
   and the PR.

   **In a cloud session** (`CLAUDE_CODE_REMOTE` is `true`), add
   `--branch <your session's branch>`: the branch your session instructions
   tell you to develop on and push to. A cloud session can push only that
   branch, so the script refuses to start without it. If you don't know the
   branch, ask the user.

   `--type` sets the branch, commit and PR prefix: Story/Feature → `feat`,
   Bug/Defect → `fix`, Chore → `chore`, Refactor → `refactor`, Docs → `docs`.
   Anything else falls back to `feat`. Bug and Defect cards also take the
   bug path: the bug is reproduced with a failing test before it's fixed.

   Routine cards (small to medium, easy to undo, nothing to decide) skip plan
   sign-off. If the user asks to see the plan before anything is built, add
   `--review-plan`.

   The script refuses to start if tracked files have uncommitted changes,
   if `project-context.md` has no ```checks block (it must be able to run
   the tests), or if a build for this card already exists. Relay the message; only add
   `--restart` if the user wants to throw the old build away.

   If it says `ANTHROPIC_API_KEY` or `ANTHROPIC_AUTH_TOKEN` is set, stop and tell
   the user: with a key set, every agent is billed per token instead of using
   their Claude plan. Never add `--allow-api-billing` yourself; only the user
   can decide to pay per token.

   While it runs, keep the user posted. The script prints one plain-English
   line when each step starts (⌛) and one when it ends (✅ done, ❌ or ↩️ sent
   back, ❓ or ⏸ waiting for them). Relay those lines as they come, as written.
   Don't add commentary of your own, and don't go silent.

   **PLAN APPROVED AUTOMATICALLY** — the planners rated the card routine, so
   the build goes on without a sign-off. The script prints this block between
   `===` lines before any building starts. The moment you see it, before you
   relay anything else:
   1. Show the block in your own message, formatted as Markdown (section titles
      in bold, lines as bullets): the header line, Problem, Task, Solution, and
      the last line on how to change the plan. As with PLAN FOR REVIEW, rewrite
      any line that isn't plain English, and change nothing else.
   2. Send a push notification (the PushNotification tool, if you have it),
      since the user may have walked away: the card, "plan approved
      automatically", and the Task in one plain line, e.g. "WHIT-42: plan
      approved automatically. Building: a total at the bottom of the spending
      list".

   Don't ask anything: the build is already running.

   **The user jumps in.** At a pause, use that pause's own replies (step 4):
   `stop` ends the build, and at a plan review `rework: <feedback>` changes
   the plan. Once building has started (while it runs, or at a DECISION
   NEEDED pause), if the user wants to change the plan ("stop, make it a
   weekly total instead"), run in the background:
   `python3 build_graph.py --thread <id> --replan "<what they want changed>"`
   It stops the running build itself (so the build's own background task
   ending is expected, not an error), throws away the unfinished code, and
   sends the plan back to the designer with their feedback. They then get a
   PLAN FOR REVIEW (step 3) before anything is built again. If they want to
   end a running build instead, run `python3 build_graph.py --thread <id>
   --cancel` (step 5, BUILD CANCELLED); if it's unclear which they want, ask.
   Once the PR is open, both refuse: change the PR instead.

3. When the script pauses, it prints a block between `===` lines and
   `Paused. Resume with: ...`. The first line of the block says why:

   The user can't see the script's output, only your messages. So at every
   pause, show what the block says in your own message BEFORE you ask
   anything.

   The user may have walked away while the build ran. So at every pause, first
   send them a push notification (the PushNotification tool, if you have it):
   one plain line saying the card and what it's waiting for, e.g. "WHIT-42:
   the plan is ready for your sign-off". Do the same when the build ends (PR
   opened, failed or stopped).

   - **PLAN FOR REVIEW** — before any question, show the summary in your
     message exactly as printed, formatted as Markdown (section titles in
     bold, lines as bullets): the header line, Problem, Task and Solution,
     the "Why this needs your sign-off" line, any unresolved critic concerns,
     and the details line. Don't add to it,
     shorten it, or pull more in from the plan file. The one exception is a
     line that isn't plain English: rewrite that line (see "Plain English is
     critical"). If the user asks for the details, show them the parts they
     ask about, in plain English too.

     Then ask the decisions with AskUserQuestion instead of printing them a
     second time, recommended answer first and marked "(Recommended)", and
     offer: Approve · Rework · Stop.

     If the user chooses to **split** the card (the designer offers this when
     the plan has 3 or more slices):
     1. Read the slices from the plan file. For every slice after the first,
        create a card on the board the same way as step 1b. Title it with the
        slice's title and describe what it delivers. If project-context.md
        has a blocker relation, set this card as each new card's blocker.
     2. Resume with `rework: Split. Plan only slice 1: <title>. The other
        slices are now their own cards: <new card IDs>.` The designer replans
        just slice 1, and you'll get a new PLAN FOR REVIEW.
     3. Tell the user which cards you filed.

     If the user answers a **long-term fix** decision (the designer offers one
     when a bigger fix exists than the card needs):
     - **Card only** — approve as usual (`go: Q<n> A; …`).
     - **Include the long-term fix** — the plan doesn't cover it yet, so don't
       approve. Resume with `rework: Include the long-term fix: <what it is>.`
       and you'll get a new PLAN FOR REVIEW.
     - **Later** — create a card for the long-term fix on the board the same
       way as step 1b, then approve (`go: Q<n> C; …`) and tell the user which
       card you filed.
   - **CARD LOOKS INVALID** — show the block (why it looks unneeded, the
     problem, and what the card should become), then ask: Close the card · Plan it anyway (ask
     why it's still needed) · Stop. If the reason is that the change belongs in
     another repo (for a card about `/build` itself, the main copy of the build
     tool), say where, and offer to make the change there outside the build once
     the card is closed.
   - **QUESTIONS BEFORE PLANNING** — the card was too thin to plan. Ask the
     questions with AskUserQuestion, recommended answer first.
   - **DECISION NEEDED** — an agent hit a decision it shouldn't make alone
     (or couldn't reproduce the bug, or write failing tests). Show it in
     plain English, rewriting any line that talks code, and ask the user.
     Offer the options it lists and any hint on the last line (`skip`,
     `unpin`), each explained in everyday words.

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
     pushed and opened the PR, and it ran QA's new tests first if QA added any.
   - **BRANCH PUSHED — open the PR** — the build passed and pushed its
     branch, but this session has no working `gh` (a cloud session never
     does), so opening the PR is yours. Open it from the branch into the base
     it names, with the title it printed and the description file's text as
     the body: use a GitHub tool if you have one (e.g. a GitHub MCP "create
     pull request" tool). If you don't, give the user the "Open it here" link,
     the title, and the description in a code block to paste. Either way,
     relay the PR link once there is one.
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
     to re-run the checks and both reviews (code review and QA) on your fixes. Repeat until
     it passes.
   - **BUILD STOPPED** — a step errored (an agent ran out of turns or
     budget, returned no verdict, or files changed that shouldn't have).
     Show the user the error, fix the cause if it's yours to fix, then
     `--retry`. Don't retry blindly in a loop.
   - **BUILD PASSED but opening the PR failed** — show the error; once the
     cause is fixed (e.g. `gh auth login`), `--retry`.

6. After the run:
   - If it printed **FOLLOW-UPS THE BUILD COULDN'T DO**, tell the user each one
     in plain English, and offer to do the ones you can.
   - If it printed **MANUAL CHECKS**, list them for the user: they're what a
     person should try before merging.
   - If it printed **TECH DEBT CARDS TO FILE**, create each one on the board
     (Status 'To Do', Type 'Tech Debt' if the board has it, otherwise the
     default card type), and tell the user they were filed.
   - Once the PR is open (by the script or by you), update the card's Status to 'Done'.
