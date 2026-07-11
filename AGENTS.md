# Expo HAS CHANGED

Read the exact versioned docs at https://docs.expo.dev/versions/v56.0.0/ before writing any code.

# Build state

Current state, decisions, and open work live in the Notion **Build Note**
(page "Build Note" under "Budget Tracker App") and the **Board**
(`collection://d6aa9744-6cc4-4fb3-9d5d-164d82c88a0d`). At the start of a build
session, read the latest Session Log in the Build Note before acting.

# Pull request workflow

Open a pull request for every completed, meaningful unit of work — and before
the (ephemeral) container may time out — so Jasmine can review the code herself.
Always create the PR; don't wait to be asked. Keep unrelated changes on separate
branches/PRs so each one stays independently reviewable.

# How to communicate with Jas

When explaining, presenting ideas, or writing to Notion:

- Short sentences. To the point.
- Bullet points, not paragraphs. Avoid walls of text.
- Conditionals as: if X → then Y.
- Use arrows (→) to show flow / what happens.
- Draw a diagram when it helps (ASCII or mermaid).
- Plain language — **no unexplained jargon reaches Jas.** Before you send or
  post anything, scan it for technical terms (UI / code / infra). For each one,
  either name the actual thing on screen (e.g. "the big 'days left' number") or add
  a plain gloss in parentheses. Use the glossary below for the recurring ones; any
  term not listed still gets a gloss.
- Applies to chat AND Notion writes.

## Jargon → say instead

Swap these on sight. If you must keep the term, follow it with the plain version in
parentheses. Not exhaustive — gloss ANY technical term that isn't here.

| Jargon                     | Say instead                                                                |
| -------------------------- | -------------------------------------------------------------------------- |
| idempotent                 | safe to run twice — doing it again changes nothing                         |
| optimistic update          | the screen updates instantly, before the server confirms                   |
| hydrate                    | fill the screen with its saved data when it loads                          |
| memoize / memoized         | remember a result so it isn't recalculated every redraw                    |
| re-render                  | the screen redraws itself                                                  |
| selector                   | a function that reads one value out of the app's data                      |
| mapper                     | code that converts data from one shape to another                          |
| stale closure              | old data captured earlier that never updated                               |
| debounce                   | wait until you stop typing/tapping before acting                           |
| hero                       | the big headline element at the top of a screen                            |
| state                      | the app's current in-memory data                                           |
| webhook                    | the bank's server pings ours when something changes                        |
| Lambda                     | a small piece of server code that runs on demand (AWS)                     |
| handler                    | the entry-point function a Lambda runs                                     |
| repository / repo layer    | the code that reads and writes the database                                |
| shared layer               | common code bundled into every server function                             |
| schema                     | the shape the data must follow                                             |
| migration                  | a one-time change to the database's structure                              |
| 4xx / 5xx                  | error responses (4xx = the request was wrong; 5xx = our server broke)      |
| race condition             | two things happen at once and the order decides the result                 |
| idempotency key            | a tag that stops the same action running twice                             |
| coverage floor / ratchet   | the minimum share of code the tests must touch                             |
| fail-on-revert             | a test that breaks if you undo the fix — proves it really checks something |
| blast radius               | how much other code a change could affect                                  |
| regression                 | an old, working feature a change accidentally breaks                       |
| happy path                 | the normal case where nothing goes wrong                                   |
| edge case                  | an unusual input or situation (empty, zero, huge, offline)                 |
| optimistic vs server state | what the screen shows now vs what the server has actually saved            |

# Presenting a decision

When you surface a choice for Jasmine (an escalation, an open question, a decision
the plan didn't settle), use this structure — the communication style above still
applies:

- **Problem** — one or two lines: what's undecided and why it matters.
- **Options** — each with its pros and cons. Name the **recommended** one and why.
- Keep it short and plain, no unexplained jargon. Give a concrete example or a
  small ASCII/mermaid diagram where it clarifies.

# Filing cards

Every card title follows `<TICKET> <icon> <title>` — e.g.
`WHIT-82 🏗️ Paginate get_pending_transactions_for_account`. The ticket number in
the title keeps it searchable; a card you can't find by number gets re-filed as a
duplicate. When you file a card the board assigns a number to, put that number in
the title. Icons: 🧪 test · 🚀 feature · 🐞 bug · 🏗️ tech debt · 🔬 spike ·
🗑️ no-longer-needed.

# Known landmines

Recurring traps — check these before changing the touched area:

- **`lambda_api/constants.py` shadows the shared layer** at runtime. Any constant a
  shared `repository_*` module imports at load MUST also exist (with an equal value)
  in `lambda_api/constants.py`, or the deployed API 500s on import. Guarded by the
  WHIT-136 constants-sync test — run it after touching `shared/constants.py`.
- **Two `handle_database_error` / repository copies** — `shared/repository_base.py`
  - the webhook `lambda/repository.py`; `shared/repository_transaction.py` methods
    are duplicated in `lambda/repository.py`. Until the WHIT-88 dedup lands, change
    both copies in lockstep.
- **The shared layer is staged with a non-recursive `cp shared/*.py`** — a new
  shared _package directory_ (not a flat top-level module) is silently dropped.
