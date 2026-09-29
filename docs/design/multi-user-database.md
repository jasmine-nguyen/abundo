# Multi-user database layout (WHIT-584)

Design for Scale-Up Phase 1. The re-key, accounts list, migration and delete-user cards all build from this page.

## The problem in one picture

```
NOW                                   MULTI-USER
BUDGETS | BUDGETS                     USER#<owner_id> | BUDGETS
ACCOUNT#up-spending | TXN#123         USER#<owner_id> | ACCOUNT#<gen id>#TXN#123
RULE | RULE#r1                        USER#<owner_id> | RULE#r1
        no owner anywhere                    every row starts with WHO owns it
```

- Every row today sits under a fixed key with no owner. If two people signed up, they'd share one wallet.
- Account ids are hand-picked names (`up-spending`). They come from the BankSync id map in `shared/constants.py`.

## Decisions for Jas

### 1. Which database

| Option | Pros | Cons |
|---|---|---|
| **A) Keep DynamoDB, owner in every key (recommended)** | Keeps the working, tested server. Costs next to nothing until real traffic arrives. Scales on its own. | Questions across all users ("how many people overspent?") need a data export later. |
| B) Move to Postgres | Easy questions across all users. | Every database file and its tests get rewritten. About $40–60/month before user #1. |
| C) Supabase / Firebase | Login and database come bundled. | Throws away the whole working server. |

**Recommendation: A.** Nothing here needs cross-user questions yet, and it keeps every tested line.

### 2. What the owner id is

| Option | Pros | Cons |
|---|---|---|
| **A) The login system's own user id (the Cognito `sub`) (recommended)** | Simplest. It's already in every signed-in request. No extra lookup. | If the login user pool is ever deleted and rebuilt, every user gets a new id → every row needs re-keying. |
| B) Our own generated user id, plus a `COGNITO#<sub> → user_id` lookup row | Survives a rebuilt user pool. Only the lookup rows change. | One extra read per request (cacheable). One more row type and one more thing to migrate. |

- A second sign-in method (e.g. "Sign in with Google" linked to an existing account) keeps the original `sub` in Cognito, so that's not a reason to pick B.
- Rebuilding the user pool is rare and deliberate. If it happens, the migration script from this design re-keys everything anyway.

**Recommendation: A.** The rest of this page is written against the abstract `<owner_id>`, so switching to B later changes only how the owner id is found, not the key layout.

## 1. Key table: old → new (all 23 patterns)

`U` = `USER#<owner_id>`. The table keeps its `pk` (partition key) and `sk` (sort key) names.

### Per-user rows (owner in `pk`)

| # | Old `pk` \| `sk` | New `pk` \| `sk` | Written by |
|---|---|---|---|
| 1 | `BUDGETS` \| `BUDGETS` | `U` \| `BUDGETS` | `repository_budget.py` |
| 2 | `CATEGORIES` \| `CATEGORIES` | `U` \| `CATEGORIES` | `repository_category.py` |
| 3 | `GOALS` \| `GOALS` | `U` \| `GOALS` | `repository_goals.py` |
| 4 | `PAYCYCLE` \| `PAYCYCLE` | `U` \| `PAYCYCLE` | `repository_paycycle.py` |
| 5 | `LOANFACTS` \| `LOANFACTS` | `U` \| `LOANFACTS` | `repository_loanfacts.py` |
| 6 | `DEVICES` \| `DEVICES` | `U` \| `DEVICES` | `repository_device.py` |
| 7 | `ACCOUNT#<name>` \| `TXN#<t>` | `U` \| `ACCOUNT#<gen id>#TXN#<t>` | `repository_transaction.py` |
| 8 | `RULE` \| `RULE#<id>` | `U` \| `RULE#<id>` | `repository_rule.py` |
| 9 | `JOB` \| `JOB#<id>` | `U` \| `JOB#<id>` | `repository_job.py` |
| 10 | `INSIGHT` \| `<cycle_start>` | `U` \| `INSIGHT#<cycle_start>` | `repository_insight.py` |
| 11 | `MILESTONES` \| `<scope>` | `U` \| `MILESTONES` | `repository_milestone.py` |
| 12 | `BALANCE#<a>` \| `BALANCE` | `U` \| `BALANCE#<a>` | `repository_balance.py` |
| 13 | `ACCTBAL#<a>` \| `BALANCE` | `U` \| `ACCTBAL#<a>` | `repository_balance.py` |
| 14 | `ACCTBAL#REFRESH` \| `MARKER` | `U` \| `ACCTBAL#REFRESH` | `repository_balance.py` |
| 15 | `FEEDWATCH#<a>` \| `MARKER` | `U` \| `FEEDWATCH#<a>` | `repository_balance.py` |
| 16 | `NOTIFY#<last_pay>#<len>` \| `FIRED` | `U` \| `NOTIFY#<last_pay>#<len>` | `repository_notify.py` |
| 17 | `NOTIFY#REPAYMENT` \| `FIRED` | `U` \| `NOTIFY#REPAYMENT` | `repository_notify.py` |
| 18 | `NOTIFY#MILESTONE` \| `FIRED` or `<scope>` | `U` \| `NOTIFY#MILESTONE` | `repository_notify.py` |
| 19 | `NOTIFY#GOALCHECKPOINT` \| `FIRED` or `<scope>` | `U` \| `NOTIFY#GOALCHECKPOINT` | `repository_notify.py`, `goal_nudge.py` (its markers live in this row's fired set) |
| 20 | `NOTIFY#REPAYPUSH` \| `FIRED` | `U` \| `NOTIFY#REPAYPUSH` | `repository_notify.py` |

- The `SHARED` / `FIRED` / `None` scope in the sort key goes away. The owner is now in `pk`, so a scope adds nothing. This also removes the `"SHARED"` ↔ `None` bridge in `lambda_api/handler.py` (`_notify_scope`).
- `U | ACCOUNT#<a>#TXN#<t>` lets one query read one account's transactions (`begins_with ACCOUNT#<a>#TXN#`) or all of the user's transactions (`begins_with ACCOUNT#`).
- Rows 12–15: `<a>` is the generated account id, never a name.

### New per-user row: the accounts list

| New `pk` \| `sk` | Holds |
|---|---|
| `U` \| `ACCTINFO#<gen id>` | `name`, `bank`, `kind` (e.g. `homeloan`, `spending`, `credit`), `banksync_account_id`, `banksync_bank_id`, `banksync_feed_id`, `up_account_id` (Up's own UUID, if the account is at Up), `feed_stall_watch` (bool) |

- Sort-key prefix is `ACCTINFO#`, not `ACCOUNT#`. Otherwise "list my accounts" (`begins_with ACCOUNT#`) would also return every transaction.
- This row replaces the name-based constants: `ACCOUNT_ID_MAP`, `HOMELOAN_ACCOUNT_ID` (→ `kind = homeloan`), `SYNC_FEED_IDS`, `BALANCE_SOURCES`, `HOMELOAN_BALANCE_SOURCE`, `FEED_STALL_ACCOUNT_IDS` (→ `feed_stall_watch`), and the Up webhook's `UP_HOMELOAN_ACCOUNT_ID`.
- Generated account ids: `acc_` + 16 hex chars from a random UUID. Never derived from the bank or the name.

### App-wide rows (no owner in `pk`)

These are looked up before the owner is known, or they are an ops queue across all users.

| # | Old `pk` \| `sk` | New `pk` \| `sk` | Owner link |
|---|---|---|---|
| 21 | `FAILED` \| `<sk>` | unchanged | `owner` attribute when known. A row dead-lettered because the bank account is unknown has no owner. Already expires via `expires_at`. |
| 22 | `EVENT#<envelope>` \| `EVENT` | unchanged | No owner, no personal data (only the envelope id). **New:** written with `expires_at` = now + 30 days. |
| 23 | `PUSHRECEIPT#PENDING` \| `<receipt_id>` | unchanged | `owner` attribute. |
| new | — | `BANKACCT#<provider>#<provider_account_id>` \| `BANKACCT` | `{owner, account_id}`. `provider` is `banksync` or `up`. |
| new | — | `USERS` \| `USER#<owner_id>` | The registry scheduled jobs loop over. `{created_at}`. |

- EVENT rows today have no `expires_at` (`lambda/repository.py:255-257`), so they live forever. Dedup only needs to cover BankSync's retry window (hours to a few days). 30 days is a safe margin. Old EVENT rows get `expires_at` in the migration.

## 2. Lookup indexes (GSIs, the side-tables that find rows by another key)

| Old | New | Key | Projection |
|---|---|---|---|
| `transaction-id-index` (hash `transaction_id`) | `owner-txn-index` | hash `owner_txn` = `U#TXN#<t>` | KEYS_ONLY |
| `date-index` (hash `account_id`, range `date`) | `owner-account-date-index` | hash `owner_account` = `U#ACCOUNT#<a>`, range `date` | ALL |
| — | `owner-index` (new, sparse) | hash `owner` | KEYS_ONLY |

- Both old indexes would let one user's lookup match another user's rows (same transaction id, or same account id). The new ones always include the owner.
- Transaction rows keep a plain `account_id` attribute. The app still reads it.
- `owner-index` is sparse: only the app-wide rows that carry an `owner` attribute (FAILED, PUSHRECEIPT) appear in it. Per-user rows don't set `owner` — their owner is in `pk`. Used only by delete-user.
- **Rollout order** (DynamoDB allows one GSI change per apply): add `owner-txn-index` → add `owner-account-date-index` → add `owner-index` → backfill attributes (migration) → switch reads → drop `transaction-id-index` → drop `date-index`.

## 3. Key-builder API (`shared/keys.py`, built in the re-key card)

The only place a key string is formed. If a method forgets the owner → it can't build a key → it fails loudly instead of reading someone else's money.

```python
class MissingOwnerError(Exception): ...

class OwnerKeys:
    def __init__(self, owner_id: str):  # raises MissingOwnerError on None / "" / whitespace
    # singletons → {"pk", "sk"}
    def budgets(self); def categories(self); def goals(self); def paycycle(self)
    def loanfacts(self); def devices(self); def milestones(self)
    # transactions
    def transaction(self, account_id, txn_id)        # {"pk", "sk"}
    def account_txn_prefix(self, account_id)         # sk prefix for begins_with
    # collections
    def rule(self, rule_id); def rules_prefix(self)
    def job(self, job_id); def jobs_prefix(self)
    def insight(self, cycle_start)
    # per-account markers
    def balance(self, account_id); def account_balance(self, account_id)
    def refresh_marker(self); def feedwatch(self, account_id)
    # notify markers: kind in {"CYCLE", "REPAYMENT", "MILESTONE", "GOALCHECKPOINT", "REPAYPUSH"}
    def notify(self, kind, last_pay_date=None, length=None)
    # accounts list
    def account(self, account_id); def accounts_prefix(self)
    # GSI attribute values, set on every transaction write
    def gsi_owner_txn(self, txn_id); def gsi_owner_account(self, account_id)
    # delete-user
    def everything(self)                             # KeyConditionExpression for pk = U

# app-wide helpers (no owner needed)
def bank_account(provider, provider_account_id)
def users_row(owner_id)
def event(envelope_id)
def failed(sk)
def pending_receipt(receipt_id)
```

- Repositories take `OwnerKeys` (or the owner id) in their constructor. No repository method writes its own key string.
- **Guard test** (repo-wide, like `test_no_shared_name_shadowing.py`): no `"pk"` dict literal or `Key("pk")` outside `shared/keys.py`. Exempt: tests and `scripts/migrations/` (historical one-off scripts).
- IAM: the rule-delete grant pins `dynamodb:LeadingKeys = ["RULE"]` (`terraform/iam.tf:130`). After re-keying, rule rows live under `USER#…`, so this condition must become `USER#*` (StringLike) in the re-key card. Delete-user also needs DeleteItem / BatchWriteItem across a user's partition.

## 4. Owner resolution: every entry point

| Entry point | How it gets the owner |
|---|---|
| `lambda_api` (all HTTP routes) | `current_scope(event)` returns `claims.sub` from the signed-in token. It is the **one** source of truth → feeds `OwnerKeys`. No second function. Raises (→ 401) if there's no `sub`. |
| `lambda_api` async workers (`apply_rules_worker`, `ai_chat` worker) | The owner is written into the job row / invoke payload by the API call that started them. |
| BankSync webhook (`lambda/handler.py`) | For each transaction: `BANKACCT#banksync#<accountId>` → `{owner, account_id}`. Unknown account → FAILED row with no owner. |
| Up webhook (`lambda/up_webhook.py`) | Reads Up's own account UUID (`relationships.account.data.id`) → `BANKACCT#up#<uuid>` → owner. Checks that owner's `ACCTINFO` row has `kind = homeloan` (replaces `UP_HOMELOAN_ACCOUNT_ID`). Then reads **that owner's** `DEVICES` (today it calls `DeviceRepository().list_tokens()` with no owner). |
| `lambda/reprocess.py` | Each FAILED row → re-resolve via `BANKACCT#`. |
| `lambda/age_out.py` | Loops over `USERS`, runs per owner. |
| `lambda_balance_poller`, `lambda_goal_nudge`, `lambda_sync_trigger` | Loop over `USERS`. Per owner, read the `ACCTINFO#` rows to know which accounts / feeds / balances to fetch. |
| `lambda_push_receipts` | Reads `PUSHRECEIPT#PENDING` (app-wide). Each row's `owner` → which user's `DEVICES` to prune. |

**What writes `USERS | USER#<owner_id>`**

- **Recommended:** the API writes it on the first signed-in call, as a conditional put ("only if missing" — safe to run twice). Remembered per warm Lambda so it isn't a write per request. No new Lambda.
- Alternative: a Cognito Post-Confirmation trigger (a small Lambda run once when a user confirms sign-up). Cleaner timing, but one more Lambda to deploy and test.
- The pre-signup Lambda (`lambda_presignup`) only gates the single-user allowlist. It doesn't write rows. Lifting that allowlist is a later card.

**Feed cursor** (`lambda_api/handler.py` ~824-829, the "load more" resume key)

- Today the cursor sent to the app carries `pk`, `sk`, `account_id`, `date`. After re-keying it would expose `USER#<owner_id>` and `owner_account`, and a tampered cursor could point at another user's partition.
- Rule: the server rebuilds `pk` and `owner_account` from the **caller's** owner. It takes only `account_id`, `date` and the transaction id from the client, and never trusts a client-sent `pk`. (Alternative: opaque-encode the cursor. Rebuilding is simpler and safe on its own.)

## 5. Delete everything for a user

1. Query `pk = U` (paged) → batch-delete every row. Covers budgets, categories, goals, transactions, rules, jobs, insights, milestones, balances, markers, notify rows, devices, `ACCTINFO` rows.
   - Read the `ACCTINFO#` rows first — step 2 needs their provider ids.
2. Delete each `BANKACCT#<provider>#<id>` row listed on those `ACCTINFO` rows.
3. Query `owner-index` for `owner = <owner_id>` → delete those app-wide rows (FAILED, PUSHRECEIPT). No table scan.
4. EVENT rows: not touched. They hold no personal data and expire after 30 days.
5. Delete `USERS | USER#<owner_id>`.
6. Delete the Cognito user **last**, so a failure part-way can be retried while the user still exists.

Safe to run twice: every step deletes whatever is still there.

## 6. Migration map (one-time, Jas's data)

| Old account name | New account id | `kind` |
|---|---|---|
| `up-spending` | `acc_<generated>` | spending |
| `up-homeloan` | `acc_<generated>` | homeloan |
| `anz-rewards-black-visa` | `acc_<generated>` | credit |
| `westpac-altitude-qantas-black` | `acc_<generated>` | credit |

Steps:
1. Generate the 4 account ids once and save them to a mapping file, so a re-run reuses them.
2. Write the 4 `ACCTINFO#` rows (from `ACCOUNT_ID_MAP`, `BALANCE_SOURCES`, `SYNC_FEED_IDS`, `UP_HOMELOAN_ACCOUNT_ID`, `FEED_STALL_ACCOUNT_IDS`) and their `BANKACCT#banksync#…` / `BANKACCT#up#…` rows.
3. Write `USERS | USER#<Jas owner_id>`.
4. Copy every row in patterns 1–20 to its new key. Transactions: rewrite `account_id` to the new id, and set `owner_txn` / `owner_account`.
5. Scopes: `MILESTONES | SHARED` → `U | MILESTONES`. `NOTIFY#MILESTONE | FIRED` and `NOTIFY#GOALCHECKPOINT | FIRED` → `U | NOTIFY#…`, **keeping the fired markers** (otherwise old milestone / goal pushes fire again).
6. FAILED and PUSHRECEIPT rows: add `owner`. EVENT rows: add `expires_at`.
7. Delete old rows only after reads are switched and checked.

Rules:
- Safe to run twice: puts are "copy if missing", ids come from the mapping file.
- `--dry-run` prints counts per pattern (old vs would-write). A real run ends with the same count check and fails if they don't match.

## 7. Follow-on cards

1. **Re-key**: `shared/keys.py`, repositories take the owner, `current_scope` returns `sub`, guard test, IAM `LeadingKeys` update, feed-cursor rebuild.
2. **Accounts list**: `ACCTINFO#` / `BANKACCT#` rows, `kind`, replace the name constants, owner lookup in both webhooks and the scheduled jobs.
3. **Migration + GSI swap**: add GSIs, migrate, switch reads, drop old GSIs.
4. **Delete user**: the path in section 5, plus the `owner-index` GSI.

## Out of scope

- **Per-user bank credentials.** The BankSync API key (`BANKSYNC_API_KEY_PATH`) and the Up personal access token (`/abundo/up-personal-access-token`) are single app-wide SSM parameters (stored secrets) today. A second real user needs their own bank link → separate card, and a prerequisite before user #2.
- Lifting the single-user sign-up allowlist (`lambda_presignup`).
- Questions across all users (reporting) → a data export later.

## Assumptions

- The owner id is the Cognito `sub` (decision 2, option A).
- The BankSync webhook carries no user field. The owner comes only from the bank account id → `BANKACCT#` lookup. No BankSync spec in the repo confirms this.
