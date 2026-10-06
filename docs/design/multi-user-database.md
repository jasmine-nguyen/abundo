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
| 8 | `RULE` \| `RULE#<id>` | `U#RULES` \| `RULE#<id>` (own partition, see "Delete permission" in section 3) | `repository_rule.py` |
| 9 | `JOB` \| `JOB#<id>` | `U` \| `JOB#<id>` | `repository_job.py` |
| 10 | `INSIGHT` \| `<cycle_start>` | `U` \| `INSIGHT#<cycle_start>` | `repository_insight.py` |
| 11 | `MILESTONES` \| `<scope>` | `U` \| `MILESTONES` | `repository_milestone.py` |
| 12 | `ACCTBAL#<a>` \| `BALANCE` | `U` \| `ACCTBAL#<a>` | `repository_balance.py` |
| 13 | `ACCTBAL#REFRESH` \| `MARKER` | `U` \| `ACCTBAL#REFRESH` | `repository_balance.py` |
| 14 | `FEEDWATCH#<a>` \| `MARKER` | `U` \| `FEEDWATCH#<a>` | `repository_balance.py` |
| 15 | `NOTIFY#<last_pay>#<len>` \| `FIRED` | `U` \| `NOTIFY#<last_pay>#<len>` | `repository_notify.py` |
| 16 | `NOTIFY#REPAYMENT` \| `FIRED` | `U` \| `NOTIFY#REPAYMENT` | `repository_notify.py` |
| 17 | `NOTIFY#MILESTONE` \| `FIRED` or `<scope>` | `U` \| `NOTIFY#MILESTONE` | `repository_notify.py` |
| 18 | `NOTIFY#GOALCHECKPOINT` \| `FIRED` or `<scope>` | `U` \| `NOTIFY#GOALCHECKPOINT` | `repository_notify.py`, `goal_nudge.py` (its markers live in this row's fired set) |
| 19 | `NOTIFY#REPAYPUSH` \| `FIRED` | `U` \| `NOTIFY#REPAYPUSH` | `repository_notify.py` |

- The `SHARED` / `FIRED` / `None` scope in the sort key goes away. The owner is now in `pk`, so a scope adds nothing. This also removes the `"SHARED"` ↔ `None` bridge in `lambda_api/handler.py` (`_notify_scope`).
- `U | ACCOUNT#<a>#TXN#<t>` lets one query read one account's transactions (`begins_with ACCOUNT#<a>#TXN#`) or all of the user's transactions (`begins_with ACCOUNT#`).
- Rows 12–14: `<a>` is the generated account id, never a name.
- Row 8 is the one exception to "owner is the whole `pk`": rules sit in a second per-user partition `USER#<owner_id>#RULES`. That keeps the API's delete permission limited to rules (section 3).

### New per-user row: the accounts list

| New `pk` \| `sk` | Holds |
|---|---|
| `U` \| `ACCTINFO#<gen id>` | `name`, `bank`, `kind` (e.g. `homeloan`, `spending`, `credit`), `banksync_account_id`, `banksync_bank_id`, `banksync_feed_id`, `up_account_id` (Up's own UUID, if the account is at Up), `feed_stall_watch` (bool) |

- Sort-key prefix is `ACCTINFO#`, not `ACCOUNT#`. Otherwise "list my accounts" (`begins_with ACCOUNT#`) would also return every transaction.
- This row replaces the name-based constants: `ACCOUNT_ID_MAP`, `HOMELOAN_ACCOUNT_ID` (→ `kind = homeloan`), `SYNC_FEED_IDS`, `BALANCE_SOURCES`, `FEED_STALL_ACCOUNT_IDS` (→ `feed_stall_watch`), and the Up webhook's `UP_HOMELOAN_ACCOUNT_ID`.
- Generated account ids: `acc_` + 16 hex chars from a random UUID. Never derived from the bank or the name.

### App-wide rows (no owner in `pk`)

These are looked up before the owner is known, or they are an ops queue across all users.

| # | Old `pk` \| `sk` | New `pk` \| `sk` | Owner link |
|---|---|---|---|
| 20 | `FAILED` \| `<sk>` | unchanged | `owner` attribute when known. A row dead-lettered because the bank account is unknown has no owner. Already expires via `expires_at`. |
| 21 | `EVENT#<envelope>` \| `EVENT` | unchanged | No owner, no personal data (only the envelope id). **New:** written with `expires_at` = now + 30 days. |
| 22 | `PUSHRECEIPT#PENDING` \| `<receipt_id>` | unchanged | `owner` attribute. |
| new | — | `BANKACCT#<provider>#<provider_account_id>` \| `BANKACCT` | `{owner, account_id}`. `provider` is `banksync` or `up`. |
| new | — | `USERS` \| `USER#<owner_id>` | The registry scheduled jobs loop over. `{created_at}`. |

- EVENT rows today have no `expires_at` (`lambda/webhook_repository.py:256-258`), so they live forever. Dedup only needs to cover BankSync's retry window (hours to a few days). 30 days is a safe margin. Old EVENT rows get `expires_at` in the migration.

## 2. Lookup indexes (GSIs, the side-tables that find rows by another key)

| Old | New | Key | Projection |
|---|---|---|---|
| `transaction-id-index` (hash `transaction_id`) | `owner-txn-index` | hash `owner_txn` = `U#TXN#<t>` | KEYS_ONLY |
| `date-index` (hash `account_id`, range `date`) | `owner-account-date-index` | hash `owner_account` = `U#ACCOUNT#<a>`, range `date` | ALL |
| — | `owner-index` (new, sparse) | hash `owner` | KEYS_ONLY |

- Both old indexes would let one user's lookup match another user's rows (same transaction id, or same account id). The new ones always include the owner.
- Transaction rows keep a plain `account_id` attribute. The app still reads it.
- `owner-index` is sparse: only the app-wide rows that carry an `owner` attribute (FAILED, PUSHRECEIPT) appear in it. Per-user rows don't set `owner` — their owner is in `pk`. Used only by delete-user.
- **Rollout order** (DynamoDB allows one GSI change per apply): add `owner-txn-index` → add `owner-account-date-index` → add `owner-index` → backfill attributes (migration) → switch reads (the key layout switch, section 8) → drop `transaction-id-index` → drop `date-index`.

## 3. Key-builder API (`shared/keys.py`, built in the re-key card)

The only place a key string is formed. If a method forgets the owner → it can't build a key → it fails loudly instead of reading someone else's money.

```python
class MissingOwnerError(Exception): ...

class OwnerKeys:
    def __init__(self, owner_id: str):  # raises MissingOwnerError on None / "" / whitespace;
                                        # ValueError if owner_id contains "#"
    # singletons → {"pk", "sk"}
    def budgets(self); def categories(self); def goals(self); def paycycle(self)
    def loanfacts(self); def devices(self); def milestones(self)
    # transactions
    def transaction(self, account_id, txn_id)        # {"pk", "sk"}
    def account_txn_prefix(self, account_id)         # sk prefix for begins_with
    # collections
    def rule(self, rule_id); def rules_partition(self)   # pk = U#RULES
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
    # GSI lookups → (index name, hash attribute, value); follow the key layout switch (section 8)
    def txn_lookup(self, txn_id); def account_date_lookup(self, account_id)
    # delete-user
    def everything(self)                             # the two partitions: pk = U and pk = U#RULES

# app-wide helpers (no owner needed)
def bank_account(provider, provider_account_id)
def users_row(owner_id)
def event(envelope_id)
def failed(sk)
def pending_receipt(receipt_id)
```

- Repositories take `OwnerKeys` (or the owner id) in their constructor. No repository method writes its own key string.
- **Guard test** (repo-wide, like `test_no_shared_name_shadowing.py`): no `"pk"` dict literal or `Key("pk")` outside `shared/keys.py`. Exempt: tests and `scripts/migrations/` (historical one-off scripts).
**Delete permission (IAM)**

- Today the API may delete rule rows only: `dynamodb:LeadingKeys = ["RULE"]` (`terraform/iam.tf:117-131`, WHIT-528). That check only looks at `pk`.
- If rules moved to `U | RULE#<id>`, the check would have to allow `USER#*` → the API could delete **any** row of **any** user (budgets, transactions, devices). Not acceptable.
- So rules get their own partition `USER#<owner_id>#RULES`. The condition becomes `ForAllValues:StringLike` = `["USER#*#RULES"]` → delete stays limited to rule rows.
  - While the old layout is still live (section 8), the list is `["RULE", "USER#*#RULES"]`. `"RULE"` is removed when the old rows are deleted.
  - No other per-user `pk` may ever end in `#RULES`. `OwnerKeys` refuses owner ids containing `#`, so an owner id can't fake the suffix.
- Delete-user needs delete across a whole user. It runs in its **own** Lambda with its own role. The API role never gets that wider permission.

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

Runs in its own Lambda and role (section 3). The API can't do this.

1. Query `pk = U` and `pk = U#RULES` (paged) → batch-delete every row. Covers budgets, categories, goals, transactions, rules, jobs, insights, milestones, balances, markers, notify rows, devices, `ACCTINFO` rows.
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
2. Check that the accounts-list card already wrote the 4 `ACCTINFO#` rows (from `ACCOUNT_ID_MAP`, `BALANCE_SOURCES`, `SYNC_FEED_IDS`, `UP_HOMELOAN_ACCOUNT_ID`, `FEED_STALL_ACCOUNT_IDS`), their `BANKACCT#banksync#…` / `BANKACCT#up#…` rows, and `USERS | USER#<Jas owner_id>`. Stop if any is missing.
3. Rules: `RULE | RULE#<id>` → `U#RULES | RULE#<id>`.
4. Copy every row in patterns 1–19 to its new key. Transactions: rewrite `account_id` to the new id, and set `owner_txn` / `owner_account`. Re-key the `ACCTINFO#<name>` rows to `ACCTINFO#<gen id>` and point the `BANKACCT#` rows at the new ids (the accounts-list card created them with the old name ids).
   - Any other row that stores an account id inside its contents (goals, loan facts, markers) gets the old name swapped for the new id. The dry run lists every hit.
5. Scopes: `MILESTONES | SHARED` → `U | MILESTONES`. `NOTIFY#MILESTONE | FIRED` and `NOTIFY#GOALCHECKPOINT | FIRED` → `U | NOTIFY#…`, **keeping the fired markers** (otherwise old milestone / goal pushes fire again).
6. FAILED and PUSHRECEIPT rows: add `owner`. EVENT rows: add `expires_at`.
7. Delete old rows only after the switch (section 8) has been live and checked for a week.

Rules:
- Safe to run twice. The mapping file keeps the ids stable. The script has two modes: `--copy` (copy if missing, used ahead of time) and `--final` (overwrite, used only inside the freeze).
- `--dry-run` prints counts per pattern (old vs would-write). A real run ends with the same count check and fails if they don't match.

## 8. Cutover: switching from the old keys to the new ones

The risk: if code that reads the new keys ships before the data has been copied → the app shows empty budgets and transactions. And bank writes made during the copy land in one key set but not the other.

**The switch lives in one place: the key-builder.**

- `shared/keys.py` has a key-layout setting: `legacy` or `owner` (one Lambda environment variable, same value in every Lambda).
- `legacy` → `OwnerKeys` still demands an owner, but returns today's keys (`BUDGETS | BUDGETS`, `ACCOUNT#<a> | TXN#<t>`, `RULE | RULE#<id>`…) and the old GSIs. Same data, same behaviour.
- `owner` → returns the new keys and the new GSIs from this page.
- New row types (`ACCTINFO#`, `BANKACCT#`, `USERS`) have no old version. They use their new keys in both modes.
- Repositories never see the setting. Only `keys.py` reads it.

```
re-key card        accounts-list card       migration card                        later
[legacy] ────────→ [legacy] ──────────────→ copy → freeze → final copy → [owner] → delete old rows
 no data change     writes ACCTINFO/          (old rows untouched until "later")    drop old GSIs
                    BANKACCT/USERS rows                                             drop "RULE" from IAM
```

**Freeze and switch (in the migration card, a few minutes, Jas is the only user)**

1. Ahead of time, app live: add the 3 GSIs. Run `--copy` and the dry-run count check.
2. Turn the freeze on (a setting read by every Lambda):
   - BankSync webhook → dead-letters every incoming transaction to `FAILED` (the existing path). Nothing is lost.
   - Up webhook → skips (worst case: one missed repayment push).
   - Scheduled jobs → exit early.
   - API → rejects writes with "try again in a few minutes". Reads keep working.
3. Run `--final` (overwrite) → every change since step 1 is copied. Count check must pass.
4. One deploy: key layout → `owner`, freeze → off.
5. Run reprocess → the `FAILED` rows from the freeze are filed under the new keys.
6. Check the app: budgets, transactions, goals, rules, milestones.

**Going back**

- If step 6 fails → set the key layout back to `legacy`. The old rows are untouched, so the app works again at once.
- Cost: writes made after step 4 exist only under the new keys → re-run `--final` before trying again. The old rows are kept a week for this reason.

**Owner before the switch**

- In `legacy` mode the API already passes `claims.sub` (it's ignored by the keys, but proves every path has an owner).
- Background jobs and webhooks have no signed-in user. Until the accounts-list card adds the `BANKACCT#` / `USERS` lookups, the re-key card gives them one configured owner id (Jas's `sub`, one setting). The accounts-list card replaces it.

## 9. Follow-on cards

1. **Re-key** (ships in `legacy` mode, no visible change): `shared/keys.py` with the key-layout setting, repositories take the owner, `current_scope` returns `sub`, one configured owner for background jobs, guard test, feed-cursor rebuild. IAM condition → `["RULE", "USER#*#RULES"]`.
2. **Accounts list** (still `legacy`): `ACCTINFO#` / `BANKACCT#` / `USERS` rows (with today's name ids), `kind`, the app gets account names from the list instead of the id (today it turns `up-homeloan` into "Up Homeloan"), replace the name constants and the configured owner with lookups in both webhooks and the scheduled jobs.
3. **Migration + switch**: add GSIs, the migration script (section 6), the freeze setting, the cutover in section 8. A week later: delete old rows, drop old GSIs, drop `"RULE"` from the IAM condition, delete the `legacy` mode from `keys.py`.
4. **Delete user**: the path in section 5, its own Lambda and role, plus the `owner-index` GSI (if not already added in card 3).

## Out of scope

- **Per-user bank credentials.** The BankSync API key (`BANKSYNC_API_KEY_PATH`) and the Up personal access token (`/abundo/up-personal-access-token`) are single app-wide SSM parameters (stored secrets) today. A second real user needs their own bank link → separate card, and a prerequisite before user #2.
- Lifting the single-user sign-up allowlist (`lambda_presignup`).
- Questions across all users (reporting) → a data export later.

## Assumptions

- The owner id is the Cognito `sub` (decision 2, option A).
- The BankSync webhook carries no user field. The owner comes only from the bank account id → `BANKACCT#` lookup. No BankSync spec in the repo confirms this.
