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

# How to communicate with Jasmine

When explaining, presenting ideas, or writing to Notion:

- Short sentences. To the point.
- Bullet points, not paragraphs. Avoid walls of text.
- Conditionals as: if X → then Y.
- Use arrows (→) to show flow / what happens.
- Draw a diagram when it helps (ASCII or mermaid).
- Plain language — no unexplained jargon. If a term is technical (UI/code/infra,
  e.g. "hero", "optimistic update", "idempotent"), explain it in everyday words
  or name the actual thing on screen (e.g. "the big 'days left' number").
- Applies to chat AND Notion writes.

# Presenting a decision

When you surface a choice for Jasmine (a gate escalation, an open question, a
fork), use this structure — the communication style above still applies:

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
  + the webhook `lambda/repository.py`; `shared/repository_transaction.py` methods
  are duplicated in `lambda/repository.py`. Until the WHIT-88 dedup lands, change
  both copies in lockstep.
- **The shared layer is staged with a non-recursive `cp shared/*.py`** — a new
  shared *package directory* (not a flat top-level module) is silently dropped.
