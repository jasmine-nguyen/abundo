# Project Context — Abundo

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

## Known landmines

Check these before changing the touched area:

- **Each constant has one home** — API-only → `lambda_api/api_constants.py`; everything
  else → `shared/constants.py`; never both. Guarded by `test_no_shared_name_shadowing.py`.
- **The webhook repository subclasses the shared one** —
  `lambda/repository.py`'s `TransactionRepository` extends
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

## Hot shared files

`src/context.tsx`, Lambda handlers — flag collision risk when touching these.
