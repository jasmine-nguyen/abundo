# Expo HAS CHANGED

Read the exact versioned docs at https://docs.expo.dev/versions/v56.0.0/ before writing any code.

# Must always run /build command when asked to implement a feature or fix a bug

When asked to look into an issue, or implement a feature, no matter how small, you must always run the `/build` command first.
This ensures you go through the process with critics criticising the changes at multiple stages.

Do not ever build or make changes without a critics reviewing your plan or changes.

# Pull request workflow

Open a pull request for every completed, meaningful unit of work — and before
the (ephemeral) container may time out — so Jasmine can review the code herself.
Always create the PR; don't wait to be asked. Keep unrelated changes on separate
branches/PRs so each one stays independently reviewable.

Write every PR description with `.github/pull_request_template.md`: Problem, Task,
Solution, Evidence and Merge danger, plus Manual checks and Follow-ups when there
are any. This applies to every agent, including when using the `pr` skill.

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

- **Each constant has one home** — API-only → `lambda_api/api_constants.py`; everything
  else → `shared/constants.py`; never both. Guarded by `test_no_shared_name_shadowing.py`.
- **The webhook repository subclasses the shared one** — `lambda/webhook_repository.py`'s
  `TransactionRepository` extends `shared/repository_transaction.py` and imports
  `handle_database_error` from `shared/repository_base.py` (WHIT-454 removed the old
  duplicated copies). CRUD/error code lives in one place; only the webhook-only
  reconcile pipeline is local. Don't reintroduce a local copy of an inherited method —
  override only to change behaviour.
- **`get_api_key()` lives once in `shared/api_key.py`** (WHIT-454), cached by SSM path
  so two callers in one process (lambda_api reads the BankSync AND Anthropic keys)
  never collide. Each lambda keeps a one-line wrapper passing its own path — don't
  re-copy the SSM fetch.

# Project context

## Board

Notion data source: `collection://d6aa9744-6cc4-4fb3-9d5d-164d82c88a0d`
Card prefix: `WHIT`
Default card type: `Task`

## Stack

- **Client:** React Native (Expo v56), TypeScript
- **Server:** Python Lambdas on AWS, shared layer staged recursively from `shared/`
- **Tests:** Jest (client — `npm test` for fast logic, `npm run test:all` for full),
  pytest (server — `python -m pytest`)
- **Typecheck:** `npx tsc --noEmit`

## Checks

The build runs these after every implementation round and once more before it
pushes, from the repo root, one per line. Any non-zero exit sends the work back
to the implementer. The build won't start without this block. They're the fast
part of CI: the Jest screen tests, the Expo exports and the coverage floors run
in CI only.

```checks
npm run typecheck
npm test
.venv/bin/python -m pytest -q
```

iOS app? Agents check screens in the Simulator with the `simulator-check` skill
(`.claude/skills/simulator-check/`, needs AXe: `brew install cameroncooke/axe/axe`).
The build's QA only drives the Simulator when Metro is running from the build's
own checkout; otherwise screen checks stay manual.

## Known landmines

Check these before changing the touched area:

- **Each constant has one home** — API-only → `lambda_api/api_constants.py`; everything
  else → `shared/constants.py`; never both. Guarded by `test_no_shared_name_shadowing.py`.
- **The webhook repository subclasses the shared one** —
  `lambda/webhook_repository.py`'s `TransactionRepository` extends
  `shared/repository_transaction.py` and imports `handle_database_error` from
  `shared/repository_base.py`. CRUD/error code lives in one place; don't
  reintroduce a local copy of an inherited method — override only to change
  behaviour.
- **`get_api_key()` lives once in `shared/api_key.py`**, cached by SSM path. Each
  lambda keeps a one-line wrapper passing its own path — don't re-copy the SSM fetch.
- **The chat's time limits are a chain** (WHIT-609, WHIT-612) — the `ai_chat_worker` timeout in
  `terraform/lambda.tf` < the app's `CHAT_MAX_WAIT_MS` (`src/chat/ChatContext.tsx`). Inside the
  worker, `run_chat` shares its remaining time across the model calls, keeping
  `CHAT_DEADLINE_MARGIN_SECONDS` back to mark the job failed. `CHAT_MESSAGE_MAX_LEN` and the
  20-message history are copied by hand into `ChatContext.tsx`. Change them together. Guarded by
  `chatLimitsSync.logic.test.ts` and the deadline tests in `test_chat_deadline.py` / `test_ai_chat.py`.
- **An answer-first chat history means "insights seed"** (WHIT-609) — `ai_chat.to_model_messages`
  puts a fixed "here's the summary" user turn in front of a history that starts with an answer.
  Any trim or filter of the history (client `chatHistory`, server `_validate_chat_messages`) must
  never leave an answer at the front.

## Coding standards

- Simpler is better. No overcomplication.
- Minimal comments — only when logic is genuinely complex.
- Consistent naming — if a variable is called `transaction` in one place, don't
  call it `txn` elsewhere.
- Keep code flat — early exits over nested if/else. Avoid ternary unless trivial.
- No overly defensive programming or unnecessary isinstance checks.
- Only manage exceptions when necessary.
- No copy-pasted code, in app code or tests. Before writing a function,
  component, setup or helper, search for one that already exists (app code:
  `src/`, `src/components/`, `src/hooks/`; tests: `src/__tests__/support/`). If
  the same code would end up in 2+ files, move it into a shared place in the
  same change and import it — never copy it from another file.
- Plans must say "use / add a shared helper" — never "copy the pattern
  from <other file>".
- Reviewers treat copied code as a must-fix, not a follow-up card.

## Hot shared files

`src/context.tsx`, Lambda handlers — flag collision risk when touching these.
