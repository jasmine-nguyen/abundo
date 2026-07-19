# Abundo backend rename — apply runbook (WHIT-302)

**Status:** code is ready on branch `claude/abundo-infra-rename`. This doc is the
**apply** half — the live AWS steps. Run it deliberately; it destroys and recreates
production resources.

**Merge order:** merge the front-end PR (#248) **first**, then this one. This branch
is stacked on #248, so it already contains the front-end Abundo changes.

**Decisions already made (Jas):**
- ✅ Rename the login server (Cognito pool) too — **every existing user must
  re-register.** Accepted.
- ✅ App **data is preserved** — the table is keyed by `ACCOUNT#<bank-account-id>`,
  not by the user's login id, so it survives the pool wipe and is worth keeping.
  (If you'd rather start 100% fresh, skip step 3 and let the table recreate empty.)

---

## What the code change does

Two Terraform variables drive almost the whole rename:

```
project_name          : whittle       → abundo      (variables.tf:10)
cognito_domain_prefix : whittle-auth   → abundo-auth (variables.tf:99)
```

`project_name` names → the database table, the login pool + app client, every
Lambda, every IAM role, the API gateway, all log groups, and the 4 secret paths
`/whittle/*` → `/abundo/*`. The app-side code (Python literals, `eas.json` login
URL, `app.json` bundle id) was updated to match. So a plain `terraform apply` will
show **destroy + recreate on nearly everything.** That's expected — but two pieces
hold state and need care: the **database table** (step 3) and the **secrets**
(step 4).

---

## Prerequisites
- AWS credentials for the target account + `terraform` and `aws` CLI installed.
- The **4 real secret values** (Terraform only seeds `"placeholder"` and ignores
  changes, so they live outside the repo):
  - `/abundo/banksync-api-key`
  - `/abundo/banksync-webhook-secret`
  - `/abundo/anthropic-api-key`
  - `/abundo/expo-access-token`
  - → grab the current values from the OLD paths first:
    `aws ssm get-parameter --name /whittle/banksync-api-key --with-decryption`
    (repeat for the other three).

---

## Steps

### 1. Snapshot / plan
- `terraform plan` on the renamed config. Read it: confirm it's renaming the things
  you expect and nothing surprising.
- Note anything with `-> destroy` that you didn't intend.

### 2. Take a database backup (safety net)
```
aws dynamodb create-backup \
  --table-name whittle-dynamodb-table \
  --backup-name abundo-migration-pre-cutover
```

### 3. Move the data to the new table (preserve mode)
The new table name is `abundo-dynamodb-table`. Create it **from the backup** so it
comes up already populated, then let Terraform adopt it (so a later apply doesn't
try to recreate it empty):
```
# restore old data into the new table name
aws dynamodb restore-table-from-backup \
  --target-table-name abundo-dynamodb-table \
  --backup-arn <arn from step 2>

# wait until ACTIVE, then have Terraform adopt it instead of creating a new one
terraform import aws_dynamodb_table.dynamodb_table abundo-dynamodb-table
```
- After import, `terraform plan` should show the table as **no-change** (or a
  harmless in-place tweak). If it wants to *replace* it, stop — the restored table's
  indexes/TTL don't match config; reconcile before continuing.
- **Skip this whole step** if you chose the clean-slate option — the apply will just
  create an empty `abundo-dynamodb-table`.

### 4. Apply the rest
- `terraform apply`.
- This creates all the `abundo-*` resources and **destroys the old `whittle-*`
  ones**, including the old Cognito pool (users gone — accepted) and the old SSM
  secret params.

### 5. Re-store the 4 secrets at the new paths
The new params come up holding `"placeholder"`. Put the real values back:
```
aws ssm put-parameter --overwrite --type SecureString \
  --name /abundo/banksync-api-key        --value '<real>'
aws ssm put-parameter --overwrite --type SecureString \
  --name /abundo/banksync-webhook-secret --value '<real>'
aws ssm put-parameter --overwrite --type SecureString \
  --name /abundo/anthropic-api-key       --value '<real>'
aws ssm put-parameter --overwrite --type SecureString \
  --name /abundo/expo-access-token       --value '<real>'
```

### 6. Re-point the bank feed (BankSync)
- The webhook now lands on the renamed ingest Lambda / API. Confirm the BankSync
  webhook is still pointing at the right URL, and that the outbound `User-Agent`
  (now `abundo-app-api` / `abundo-transaction-trigger` / `abundo-homeloan-request`)
  is **not allow-listed** on their side. If it is, tell them the new value before
  going live, or the feed drops.

### 7. Rebuild + ship the app
- Bundle id / package changed to `com.jasminenguyen.abundo` → this is a **new app
  identity** in the App Store / Play Store (new listing; existing TestFlight/installs
  won't update in place). Set up the new listing / EAS project as needed.
- `eas.json` now builds against `abundo-auth.auth.<region>.amazoncognito.com`.
  Confirm the new Cognito app client's callback/logout URLs match
  `acme://oauthredirect` / `acme://signout` (the url scheme `acme` is unchanged).
- Cut a fresh build and submit.

### 8. Verify (happy path — the normal, nothing-goes-wrong case)
- Register a new account → log in.
- Link a bank account → a sync lands → transactions show (proves feed + table +
  secrets).
- Open AI insights (proves Anthropic key + `abundo-app-api`).
- Trigger a push (proves Expo token).
- Home-loan balance loads (proves `abundo-homeloan-request`).

### 9. Clean up
- Once verified and soaked, delete the leftover old table backup and confirm no
  `whittle-*` resources remain: `aws resourcegroupstaggingapi get-resources`
  filtered on the old `App=whittle` tag.

---

## Rollback
- Before step 4 (apply): nothing changed live — just `git checkout` the branch away
  and discard the plan.
- After apply, to go back to `whittle`: revert the branch and re-apply — but the old
  Cognito pool is already gone, so users would still need to re-register. Rollback is
  cheap for everything **except** the login pool. Treat the Cognito recreation in
  step 4 as the point of no return.
