---
description: Take one backlog card from plan to reviewed, tested code. Two sign-offs — you approve the plan (Plan Sign-off), then approve the finished change (Implementation Sign-off) before it's pushed. Never commits or pushes without your go.
---

Run the full backlog pipeline for ONE card. You are the orchestrator AND the
implementer: the subagents only plan and review (all read-only) — YOU write the
code, run the tests, and hold every write authority (edits, commits, pushes, Notion).
There is deliberately no separate "coder" agent: implementation has to hold that
authority and stop to ask you at decision points, which a fire-and-return subagent
can't do.

Two words, kept distinct:

- **Sign-off** — a human stop where YOU say go. There are exactly two: the **Plan
  Sign-off** (before any code) and the **Implementation Sign-off** (before anything
  ships). You stop at both.
- **gate** — an automated / agent quality bar that passes or fails on its own (green
  suite, coverage floor, code-critic / qa verdicts). No human click.

Board data source: `collection://d6aa9744-6cc4-4fb3-9d5d-164d82c88a0d`
Target card (optional): $ARGUMENTS

---

## Phase 1 — Plan (Plan Sign-off)

1. **Select the card.**
   - If `$ARGUMENTS` names a card (a title fragment or a priority number), use
     the Notion `query-data-sources` tool to fetch that exact card.
   - Otherwise select the next actionable card: `Type = 'Task'` and
     `Status IN ('To Do','In Progress')`, ordered by `Priority ASC`, first row.
   - Fetch the card's full page (`notion-fetch`) to get any description/body.
   - Echo back which card you picked and why before continuing.

2. **Plan (subagent).** Spawn the `solution-designer` agent with the card title +
   description. It returns a file-level plan. Don't plan it yourself — let the
   agent do it so the context stays isolated.

   - **Move the card to In Progress — you own this, not the planner.** As soon as
     the planner's `## Card validity` verdict comes back **VALID**, set the card's
     `Status` To Do → In Progress via `notion-update-page` (idempotent — skip if it's
     already In Progress). If the verdict is anything else (ALREADY DONE / DEAD CODE /
     WRONG PREMISE / ALREADY COVERED), do NOT move it — leave it in To Do and follow
     the verdict (close / retarget). Echo the board change (or why you skipped it).

3. **Critique (subagent).** Spawn the `solution-critic` agent with the card AND the
   plan. It returns an adversarial review. If it says NEEDS REWORK, send the
   problems back to a fresh `solution-designer` run and repeat once.

   **Scope check — one card, one PR.** Before presenting, gauge the plan's size: if
   shipping it cleanly would take **more than one PR** (e.g. a data layer AND a screen
   rewrite AND a file relocation + its test migration — what made WHIT-233 drag), the
   card is too big. STOP and propose splitting it into smaller tickets — one shippable
   unit each — then build those in order. One card → one PR → one review → one sign-off;
   a multi-PR card doubles every review and sign-off cycle. The only exception is a
   change that genuinely can't land in pieces without breaking `main` (a truly atomic
   swap) — call that out explicitly and say why. Slicing is not a reason to weaken the
   review agents: code-critic and qa stay full-strength on every slice.

4. **Present + PAUSE (Plan Sign-off).** First run a **plain-language pass** (AGENTS.md
   "How to communicate" + the jargon glossary): lead with an **"In plain words:"**
   summary — 2–3 sentences a non-coder gets — then swap or gloss every technical term
   in the detail. No unexplained jargon reaches Jasmine. Then show, concisely: the
   card and its "done" definition, the final approach, the exact files that would
   change, any escalation / open question needing a human call, and the test plan.
   Then ask:
   **"Approve this plan? Say go and I'll implement it."** Do not proceed until the
   user approves. Fold any changes they ask for into the plan first.

## Phase 2 — Implement (only after the Plan Sign-off)

5. **Branch.** Put the work on its own branch for this card (create it from the
   current base if not already on a card branch), so the change is reviewable in
   isolation and can become its own PR.

6. **Build it** per the approved plan. Make the smallest change that satisfies
   the "done" definition. Match the surrounding code's conventions.
   - **Name things specifically.** Variables, functions, resources — a name should
     say what the thing is. Avoid meaningless short forms (`t` for a transaction,
     `r` for a repo) unless the full name is genuinely too long for a tight scope.
     If a thing's purpose has changed, RENAME it to match — don't leave a name that
     lies about what it now does.
   - **If the card turns out stale/dead-code mid-build** (the planner should have
     caught it, but you're closer to the code now), STOP and tell the user — the
     right move may be to close/retarget the card or delete dead code, not build.
   - **Escalate, don't guess.** If you hit an architecturally significant or
     hard-to-reverse decision the plan didn't settle (new table/schema, sync vs
     async, a new dependency, a public API/auth choice), STOP and ask the user
     — a short multiple-choice question (AGENTS.md "Presenting a decision" format)
     — then continue. Never resolve such a decision silently mid-implementation.
7. **Coding standards**
   - Simpler is better. Do not overcomplicate code.
   - Keep READMEs short.
   - Keep comments short and concise, use plain language. Only comment when necessary.
   - Follow a standard/convention for naming functions, variables. For example, if a variable is
     called transaction at one place, do not call it txn at another place.
   - Keep code flat and readable, do not nest multiple if/else or try/catch together. Use early exits to avoid nesting.
   - Readability is important, unless the logic is very simple, avoid ternary, as
     it is very hard for people without context to understand the code.
   - Avoid overly defensive programming.
   - Avoid isinstance checks, unless the code is public facing and needs to be defensive.
   - Only manage exceptions when neccessary, avoid try/except blocks unless necessary.
8. **Write the first tests + self-check.** As the implementer, write tests as you
   build — the happy path + the acceptance criteria + the obvious edges. That's your
   "prove it works" half; the `qa` agent writes the independent adversarial half in
   Phase 3. Then run the suites + typecheck for anything the change touches — the
   Python suite (`python -m pytest`) for Lambda work, and the JS suite + typecheck
   (`npm test` for fast logic while iterating, `npm run test:all` for the full run,
   `npx tsc --noEmit`) for client work. Fix what you broke. Report the
   results. Do not proceed to review with a red test suite unless the user says to.
   - **Fail-on-revert your own new tests** — revert the fix (edit it back / git
     stash), confirm the new test goes RED, restore. A test that still passes with
     the fix reverted is worthless; don't wait for code-critic to catch it.
   - **Deletion safety** — if the change deletes code, first prove nothing uses it:
     grep every caller, test, re-export, and dynamic (`getattr`/string-dispatch)
     reference across ALL lambdas that import it. Confirm the full suite is green
     with it gone.

## Phase 3 — Verify (the gates that code-critic AND qa enforce)

8. **Review + QA (subagents, in parallel).** On the built change, spawn BOTH:
   - `code-critic` on the branch / working-tree diff → a verdict, plus bugs, craft
     and escalations. Tell it that craft findings are expected to be FIXED IN THIS
     PR, not carded, so it should size and prioritise them for folding in — and
     flag only the ones that genuinely cannot be (step 9's four exceptions).
   - `qa` on the same change (feed it the card's "done" definition + the diff) →
     (1) a tickable MANUAL test-case checklist for the user to run by hand,
     (2) the ACTUAL automated test code (Jest for client, pytest for server) for the
     GAPS the implementer's tests don't already cover — adversarial edges, error/offline
     paths, regressions — explicitly NOT duplicating what's already tested, and (3) an
     adversarial edge-case critique with `file:line` citations, ranked worst-first and
     each labelled real-bug vs acceptable-for-scope.

   Spawn them together so their contexts stay isolated and they run concurrently.

9. **Resolve both verdicts — bounded.**
   - **Decisions to escalate** (from either agent) → surface to the user and
     pause; don't decide for them.
   - **Bugs + fix-now craft** — code-critic's SHIP AFTER FIXES / DO NOT SHIP
     items, PLUS every qa finding labelled **real bug** → fix them, re-run the
     self-check, then re-run BOTH agents. Cap this at **2 review rounds**: if it
     still isn't clean after two, STOP and hand the user the remaining findings
     rather than looping forever.
   - **Craft + acceptable-for-scope findings → FIX THEM IN THIS PR. That is the
     default, not the exception.** A card is a promise to do the work later, and
     later never comes — the board fills up with debt nobody clears. If you are
     already in the file with the tests green, fixing it now is cheaper than
     writing the card, let alone doing it in some future PR. So: fix it, re-run
     the self-check, and list it under "also fixed" at the Implementation Sign-off.

     **File a card ONLY if one of these is true** — say WHICH one when you propose it:
     1. **It needs Jasmine's decision.** Not a craft call you can make yourself —
        a product question, a promise to users, or a hard-to-reverse choice.
     2. **It is genuinely big**: it reshapes a shared signature or data model,
        re-opens a proof/property suite the current change relies on, needs its own
        migration, or spreads well past the files this change already touches.
     3. **Folding it in would blow the scope check** (step 3) — i.e. the PR would
        stop being one reviewable unit. Note this is the same test as "one card,
        one PR", pointing the other way: a fix that is small enough to review
        alongside the change belongs IN the change.
     4. **It is blocked** on something outside this change.

     "It is unrelated to the card" is NOT a reason to file — if you are in the code
     and it is small, fix it. Cosmetic-but-cheap wins get folded in too.

     If you file a card anyway, it must say why it was not just fixed, naming which
     of the four applies. A card whose reason is "deferred craft" is a card that
     should have been a fix.
   - **Commit qa's automated tests into the suite** — write the test files qa
     authored into `src/__tests__/` (client) or `tests/` (server), doing any
     production extraction it flagged as a prerequisite first, and **drop any that
     duplicate a case the implementer already locked**. Then run the suite + typecheck.
     Every test must pass. If a qa test fails, that's either a real bug (fix it) or a
     wrong test (fix the test) — resolve it within the 2-round cap.
   - **Re-critique qa's tests (close the loop).** The tests qa authored are the one
     piece of committed code that neither the implementer nor code-critic wrote — so
     the FINAL code-critic pass (in the green gate below) must review them too, applying
     the fail-on-revert check (a test that still passes with the fix reverted is worthless).
     Never let an agent be the sole reviewer of its own tests.

## Phase 4 — Finish (Implementation Sign-off)

10. **Green gate — the suite (with coverage floor) must pass before you present.**
    Run the suites the way CI does, so the coverage floor is enforced: client
    `npm run coverage:local` + `npx tsc --noEmit` (`coverage:local` shards the tests,
    merges the per-shard coverage, and enforces the floor — the same mechanism CI runs;
    do NOT use `npm run test:all -- --coverage`, the un-sharded coverage run OOMs/hangs
    on the heavy `screen` suites, which is why WHIT-243 moved the floor to the merge
    step). Plain `npm test` runs only the fast `logic` project and does NOT gate
    coverage. Server `python -m pytest --cov … --cov-fail-under=<gate>`. Both suites carry a coverage ratchet (a REGRESSION
    backstop, not a quality signal — the real quality gate is fail-on-revert, which
    code-critic checks). ALL tests green, coverage floor met, typecheck clean is the
    precondition for the Implementation Sign-off. If anything is red, you are not done — fix it (or take it
    back through Phase 3). Never raise a PR on a red suite.

11. **Present + PAUSE (Implementation Sign-off).** First run a **plain-language pass**
    (AGENTS.md "How to communicate" + the jargon glossary): lead with an **"In plain
    words:"** summary a non-coder gets, then gloss every technical term below. No
    unexplained jargon reaches Jasmine. Then show: what you built, the final diff
    summary, the `code-critic` verdict (should be SHIP), the `qa` edge-case
    findings, its test-case checklist, the new automated tests + their green run,
    and typecheck results. Then two short lists:
    - **"Also fixed in this PR"** — every craft / acceptable-for-scope finding you
      folded in. This list should be the long one.
    - **"Proposed cards"** — ideally EMPTY. Anything here must name which of the four
      exceptions in step 9 it meets, in one line. If the list is empty, say so
      explicitly ("no new cards") — a clear board is the goal, so it is worth stating.

    Then ask: **"Approve this change? On go I'll commit, push, open the PR"** — adding
    *"file the N cards above"* only if there are any — **"and move the card to Done."**

12. **On go — apply side effects (only now):**
    - Commit and push the branch, then open the PR (per AGENTS.md, every meaningful
      unit of work gets a PR). The suite is already green from step 10, so CI's
      `Client tests` workflow should pass on the PR..
    - File any approved cards to the board (`notion-create-pages`) — usually none.
      Once the board assigns each a number, put it in the title per AGENTS.md
      "Filing cards": `<TICKET> <icon> <title>`, so the card is searchable by number.
    - Update the worked card's `Status` (In Progress → Done, or as the user
      directs).

## Hard rules

- **Never rush to a conclusion. Read the code first.** Whether you're diagnosing a
  bug, answering a "why does X happen" question, or planning a change, do NOT
  theorise from memory, guess, or reason from the symptom alone. Read the actual
  code paths, trace the data flow, and check the git history (`git blame` / `git
show` the commits that touched the area) until you can point to the exact line
  and the exact reason. Only propose a fix once the evidence — not a hunch —
  supports it. A confident-sounding guess that turns out wrong wastes the user's
  trust; "let me read it and get back to you with proof" is always the right move.
  If you catch yourself hedging ("probably", "most likely", "it might be") without
  having read the relevant code, STOP and go read it.
- Two hard stops: never implement before the Plan Sign-off; never commit, push, or
  write to Notion before the Implementation Sign-off. **One carve-out:** advancing the
  card's `Status` To Do → In Progress on a VALID plan (Phase 1, step 2) is the sole
  allowed pre-sign-off board write — it reflects work starting, nothing else.
- **One card, one PR.** If a plan needs more than one PR to ship safely, split the
  card into smaller tickets BEFORE building — don't run a multi-PR card through the
  pipeline (it doubles every review + sign-off cycle, which is what made WHIT-233 drag).
  The only exception is a change that genuinely can't land in pieces without breaking
  `main`; call that out explicitly. This is a scoping fix, never a reason to weaken the
  review agents.
- **Fix it, don't card it.** Craft findings, small bugs and acceptable-for-scope issues
  found during review get FIXED IN THE SAME PR by default. File a card only when it
  needs Jasmine's decision, is genuinely big, would blow the scope check above, or is
  blocked — and say which. The board is for work that needs planning, not a parking lot
  for things you were already looking at. A build that ships zero new cards is the
  normal, good outcome. (Note this pulls against "one card, one PR" — the scope check
  is the referee: fold in what stays reviewable, card what doesn't.)
- **Green before PR.** The full automated suite (`npm run test:all`, plus `pytest` for
  Lambda work) and typecheck must pass before a PR is raised. No red suite ships.
- Every feature ships with the automated tests for its automatable scenarios.
  **Testing model: two authors, one independent critic.** The implementer writes the
  first tests (happy path + acceptance); `qa` independently writes the adversarial
  gap tests (edges/errors/regressions) WITHOUT duplicating them; `code-critic` — which
  wrote neither — is the critic of ALL tests. The hard test gate is **fail-on-revert**:
  a test that still passes with the fix reverted is worthless. Coverage floors (Python
  `--cov-fail-under`, Jest `coverageThreshold`) are a regression backstop, not proof of
  quality. A feature with automatable behaviour and no new tests is not done.
- code-critic's gate is real: don't push a change it marked SHIP AFTER FIXES /
  DO NOT SHIP with the must-fix items unresolved. qa's real-bug findings are a
  gate too: fix them (or get an explicit user waiver) before pushing.
- Escalate architectural / hard-to-reverse decisions instead of guessing, at
  whatever phase they surface.
- **Plain language is a hard rule, not a nicety.** Every Sign-off presentation and
  every escalation leads with an "In plain words:" summary and carries no unexplained
  jargon — gloss or rename per the AGENTS.md glossary. If you catch a bare technical
  term as you draft, fix it before sending.
