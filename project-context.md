# Project Context — Abundo

## Stack

- **Client:** React Native (Expo v56), TypeScript
- **Server:** Python Lambdas on AWS, shared layer staged with `cp shared/*.py`
- **Tests:** Jest (client — `npm test` for fast logic, `npm run test:all` for full),
  pytest (server — `python -m pytest`)
- **Typecheck:** `npx tsc --noEmit`

## Known landmines

Check these before changing the touched area:

- **`lambda_api/constants.py` shadows the shared layer** at runtime. Any constant a
  shared `repository_*` module imports at load MUST also exist (with an equal value)
  in `lambda_api/constants.py`, or the deployed API 500s on import. Run the
  constants-sync test after touching `shared/constants.py`.
- **The webhook repository subclasses the shared one** —
  `lambda/repository.py`'s `TransactionRepository` extends
  `shared/repository_transaction.py` and imports `handle_database_error` from
  `shared/repository_base.py`. CRUD/error code lives in one place; don't
  reintroduce a local copy of an inherited method — override only to change
  behaviour.
- **`get_api_key()` lives once in `shared/api_key.py`**, cached by SSM path. Each
  lambda keeps a one-line wrapper passing its own path — don't re-copy the SSM fetch.
- **`lambda_api/` files ship from an allow-list** — a new `lambda_api/*.py` must be
  listed in BOTH `LAMBDA_API_SOURCES` (`scripts/build_terraform_artifacts.sh`) and
  `.gitignore`'s `!lambda_api/…` lines, or it is never committed or never deployed.
- **The shared layer is staged with a non-recursive `cp shared/*.py`** — a new
  shared package directory (not a flat top-level module) is silently dropped.

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
