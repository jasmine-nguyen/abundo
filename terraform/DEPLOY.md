# Deploy runbook — one-time setup for automatic deploys

Today you deploy by running `terraform apply` on your Mac. This sets up GitHub
Actions to do it for you: **preview on every PR, deploy on merge to `main` behind
your approval.**

It ships in **two PRs, in order**. This file lands in **PR1** with the bootstrap
module (`terraform/bootstrap/`). Do PR1's steps fully before merging PR2.

> **Why two PRs?** The deploy workflow (PR2) must never reach `main` before the
> AWS roles, the approved-reviewer gate, and the migrated state all exist —
> otherwise the first automatic deploy runs against empty state and tries to
> recreate everything. Stage A below creates those; PR2 only wires the button.

You need the `aws` CLI logged in (same creds you use for `terraform apply`), the
`gh` CLI logged in, and Terraform ≥ 1.5.

---

## Stage A — after PR1 merges

### 1. Create the state store, OIDC trust, and CI roles

```bash
cd terraform/bootstrap
terraform init
terraform plan     # review: an S3 bucket, a DynamoDB table, an OIDC provider, 2 roles
terraform apply
```

- **Broad vs scoped deploy role (DECISION 1).** The apply role defaults to
  **scoped** (only the services this app uses). To give it full admin instead:
  `terraform apply -var apply_policy_scope=broad`. Scoped is recommended.
- **Durability caveat.** This module keeps its state **locally** in
  `terraform/bootstrap/terraform.tfstate` (gitignored). Keep it — back it up. If you
  lose it, nothing is destroyed, but a bare re-`apply` fails with "already exists" for
  every resource, so you'd re-import each: the state bucket (`aws_s3_bucket.tfstate`),
  the lock table (`aws_dynamodb_table.tflock`), the OIDC provider
  (`aws_iam_openid_connect_provider.github`), and both roles + their policies
  (`aws_iam_role.github_plan`, `aws_iam_role.github_apply`, and the `aws_iam_policy` /
  attachment resources).
- **Never `terraform destroy` here.** The state bucket and lock table carry
  `prevent_destroy`, so Terraform refuses — but don't try.
- **OIDC pre-check.** AWS allows only one OIDC provider per URL per account. If
  apply errors with "provider already exists", you already have one — import it
  (`terraform import aws_iam_openid_connect_provider.github <arn>`) instead of
  creating a second.

### 2. Store the role ARNs + region as GitHub **Variables** (none is sensitive)

The workflow reads these three. Read the values from `terraform output`, then:

```bash
gh variable set AWS_PLAN_ROLE_ARN  --repo jasmine-nguyen/abundo --body "$(terraform output -raw plan_role_arn)"
gh variable set AWS_APPLY_ROLE_ARN --repo jasmine-nguyen/abundo --body "$(terraform output -raw apply_role_arn)"
gh variable set AWS_REGION         --repo jasmine-nguyen/abundo --body "$(terraform output -raw aws_region)"
```

The state **bucket / lock table / key** are NOT stored as Variables — a `backend "s3"`
block can't read variables, so they go in as **literals** in PR2's backend block
(step 7). Copy them verbatim from `terraform output` (`state_bucket_name`,
`lock_table_name`, `state_key`); don't retype — a typo becomes an opaque S3
access-denied in CI.

### 3. ⚠️ Store your deploy-time inputs as GitHub **Secrets** — DO THIS BEFORE PR2

When you `terraform apply` on your Mac you pass some values as `TF_VAR_*` env
vars. Several resources are **count-gated on those values** with no protection —
so an apply that doesn't have them **deletes** the resource. CI must hold the same
values or it will wipe your login on the first deploy.

| Secret | Drives | Empty in CI → |
| --- | --- | --- |
| `TF_VAR_google_client_id` | Google sign-in (`cognito.tf`) | **deletes your Google login** |
| `TF_VAR_google_client_secret` | Google sign-in | broken Google login |
| `TF_VAR_alert_email` | CloudWatch alert email (`monitoring.tf`) | **deletes the alert email subscription** — set only if you currently deploy with it |
| `TF_VAR_apple_*` (×4) | Apple sign-in (`cognito.tf`) | today Apple is **off**, so nothing to delete — set these only if/when you turn Apple sign-in on |

Set them as **repository** secrets (so BOTH the PR preview job and the deploy job
can read them — environment-scoped secrets never reach a PR job):

```bash
gh secret set TF_VAR_google_client_id     --repo jasmine-nguyen/abundo
gh secret set TF_VAR_google_client_secret --repo jasmine-nguyen/abundo
# only if you deploy with an alert email today:
gh secret set TF_VAR_alert_email          --repo jasmine-nguyen/abundo
```

**Your AWS parameter-store secrets are NOT in this list.** The BankSync /
Anthropic / Expo / Up values in SSM use `ignore_changes = [value]`, so CI never
overwrites them. Leave them alone.

> If you're unsure which `TF_VAR_*` you actually set, run
> `env | grep TF_VAR_` on your Mac in the shell you deploy from.

### 4. Create the protected `production` environment — THIS is the approval gate

The gate is the **required reviewer**, not the trust policy. GitHub silently creates
an **unprotected** environment the first time a workflow names one, so create it
protected first — and verify it stuck.

**UI (recommended — the CLI reviewer syntax is fiddly):** repo → Settings →
Environments → **New environment** → name it exactly `production` → enable
**Required reviewers**, add yourself → under **Deployment branches and tags**, choose
**Selected branches** and add `main` only.

**CLI alternative** (use a JSON body via `--input`; `-f "reviewers[][type]=..."` does
not reliably encode an array of objects and can leave the reviewer unset):

```bash
gh api --method PUT repos/jasmine-nguyen/abundo/environments/production --input - <<JSON
{ "reviewers": [ { "type": "User", "id": $(gh api user -q .id) } ],
  "deployment_branch_policy": { "protected_branches": false, "custom_branch_policies": true } }
JSON
gh api --method POST repos/jasmine-nguyen/abundo/environments/production/deployment-branch-policies -f name='main'
```

**Verify it actually protected — do NOT skip:**

```bash
gh api repos/jasmine-nguyen/abundo/environments/production -q '.protection_rules[].type'
# must include "required_reviewers" — if empty, the gate is OFF; fix before PR2.
```

Two things must both be true, or the gate is bypassable:

- **Required reviewer = you** — this is the approval prompt itself.
- **Deployment branches = `main` only** — the apply role's trust is pinned to
  `environment:production` but NOT to a branch, so without this a job on any branch
  that declares `environment: production` could deploy non-`main` code after an
  accidental approval.

The name must be exactly `production` (pinned in the apply role's trust and `deploy.yml`).

### 5. Generate the provider lock files for CI (multi-platform)

CI runs on Linux; your Mac is not. A lock file generated only on macOS makes CI's
`terraform init` fail. Generate both platforms and commit the results in PR2:

```bash
cd terraform          && terraform providers lock -platform=linux_amd64 -platform=darwin_amd64 -platform=darwin_arm64
cd ../terraform/bootstrap && terraform providers lock -platform=linux_amd64 -platform=darwin_amd64 -platform=darwin_arm64
```

---

## Stage B — PR2 (the deploy button)

PR2 adds the `backend "s3"` block to `terraform/providers.tf` (bucket / key / region /
lock table as literals from step 2), the committed lock files from step 5, the
`.gitignore` change that un-ignores them, and `.github/workflows/deploy.yml`.

### 6. Migrate state — on your Mac, BEFORE you push/open PR2

Do this on PR2's branch **locally, before pushing it**. Opening the PR fires a CI
preview that would otherwise race your migration for the state lock:

```bash
cd terraform
terraform init -migrate-state   # answer "yes" to copy local state up to S3
terraform plan                  # MUST say "No changes" — proves state moved intact
aws s3 ls "s3://$(cd bootstrap && terraform output -raw state_bucket_name)/abundo/"
# ^ confirm the object exists at abundo/terraform.tfstate (the key CI is scoped to)
```

If `plan` shows changes — especially any **destroy** — stop; a `TF_VAR_*` from step 3
is missing locally. Only push PR2 once this is a clean no-op.

### 7. Read the CI preview, THEN merge — the real destroy-guard

Your local `plan` above used **your Mac's** secrets. The one check that proves *CI*
has them is the **preview plan comment** the workflow posts after you push PR2:

- It MUST show **No changes** — specifically **zero** destroys of
  `aws_cognito_identity_provider.google` or `aws_sns_topic_subscription.alerts_email`.
- A destroy there means a **repository secret** from step 3 is missing in CI. Fix it,
  push again. **Do not merge until the comment is clean.**

### 8. Merge PR2

From now on:
- Open a PR touching `terraform/`, `lambda*/`, or `shared/` → the workflow posts a
  **preview** (plan) as a comment. Nothing is deployed.
- Merge to `main` → the deploy job **waits for your approval** (the `production`
  gate), then runs `terraform apply`. Done.

You never run `terraform apply` by hand again.
