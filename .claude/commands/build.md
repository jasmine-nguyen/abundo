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

7. **Write the first tests + self-check.** As the implementer, write tests as you
   build — the happy path + the acceptance criteria + the obvious edges. That's your
   "prove it works" half; the `qa` agent writes the independent adversarial half in
   Phase 3. Then run the suites + typecheck for anything the change touches — the
   Python suite (`python -m pytest`) for Lambda work, and the JS suite + typecheck
   (`npm test`, `npx tsc --noEmit`) for client work. Fix what you broke. Report the
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
   - `code-critic` on the branch / working-tree diff → a verdict, plus bugs,
     craft, escalations, and any tech-debt cards.
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
   - **Deferred craft / acceptable-for-scope** → collect the proposed tech-debt
     CARD blocks and qa's deferred risks; you'll offer to file them at the
     Implementation Sign-off. Do
     NOT file them yet.
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
   - **Hold onto qa's test-case checklist** — it's part of what you present and
     write to Notion at the Implementation Sign-off.

## Phase 4 — Finish (Implementation Sign-off)

10. **Green gate — the suite (with coverage floor) must pass before you present.**
    Run the suites the way CI does, so the coverage floor is enforced: client
    `npm test -- --coverage` + `npx tsc --noEmit`; server `python -m pytest --cov …
    --cov-fail-under=<gate>`. Both suites carry a coverage ratchet (a REGRESSION
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
    typecheck results, and the list of proposed tech-debt cards. Then ask:
    **"Approve this change? On go I'll commit, push, open the PR, write the QA
    checklist to Notion, file the tech-debt cards, and move the card to Done."**

12. **On go — apply side effects (only now):**
    - Commit and push the branch, then open the PR (per AGENTS.md, every meaningful
      unit of work gets a PR). The suite is already green from step 10, so CI's
      `Client tests` workflow should pass on the PR.
    - Write the `qa` test-case checklist to a NEW Notion page (one per card) under
      the **"Test Cases" folder** (page id `391ca73e-1d24-81be-aa6e-feea559067b2`,
      under "Budget Tracker App"). Title the page `<CARD-ID> · <short card name>`
      (e.g. `WHIT-9 · Pay cycle + payday window`). Keep the qa agent's
      `## Manual (UI)` / `## Automatable (UI)` split intact, and link the automated
      test files that now cover the automatable checks. Link the page from the card.
    - File the approved tech-debt cards to the board (`notion-create-pages`). Once
      the board assigns each a number, put it in the title per AGENTS.md "Filing
      cards": `<TICKET> <icon> <title>`, so the card is searchable by number.
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
- **Green before PR.** The full automated suite (`npm test`, plus `pytest` for
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
