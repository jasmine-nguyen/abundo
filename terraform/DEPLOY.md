# Deploy runbook — one-time setup for GitHub Actions deploys

Today you deploy by running `terraform apply` on your Mac. This sets up GitHub
Actions to do it for you: **preview on every PR, and deploy with a manual button
(Run workflow) whenever you're ready.**

> **Why a manual button, not deploy-on-merge?** GitHub's "require a reviewer to
> approve a deploy" is an *environment protection rule*, and those are only
> available for **private** repos on **GitHub Enterprise**. This repo is private and
> not on Enterprise, so that gate can't exist here. Instead the deploy job runs only
> when you click **Run workflow** — that click is the gate. Merging to `main` deploys
> nothing on its own.

It ships in **two PRs, in order**. This file lands in **PR1** with the bootstrap
module (`terraform/bootstrap/`). Do PR1's steps fully before merging PR2.

> **Why two PRs?** The deploy workflow (PR2) must never reach `main` before the
> AWS roles and the migrated state exist. Merging PR2 deploys nothing by itself, but
> your **first manual deploy** must run against your real migrated state — if you ran
> it against empty state it would try to recreate everything. Stage A creates the
> roles; Stage B migrates the state before you ever press the button.

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
- **Immutable OIDC subject (numeric ids).** GitHub now mints the login "subject"
  for newer repos in an *immutable* form carrying numeric owner/repo ids
  (`repo:owner@<owner_id>/name@<repo_id>:...`) instead of the plain name
  (`repo:owner/name:...`). The CI role trust accepts **both** forms, so the login
  works either way. The ids live in `github_owner_id` / `github_repo_id`
  (`bootstrap/variables.tf`); the committed defaults are this repo's. For a
  different repo, read them with `gh api users/<owner> -q .id` and
  `gh api repos/<owner>/<repo> -q .id`.
- **⚠️ Already applied the bootstrap before this trust change? Re-apply it.** The
  bootstrap module runs only from your Mac (CI never touches it), so editing the
  trust changes nothing in AWS until you re-run it: `cd terraform/bootstrap &&
  terraform plan && terraform apply`. Expect **exactly 2 in-place role updates
  (0 add, 0 destroy)** — `aws_iam_role.github_plan` and `github_apply`. Until you
  do, the CI plan job stays red with `Not authorized to perform
  sts:AssumeRoleWithWebIdentity`. The plan role is proven by the next PR preview;
  the apply role's immutable subject is inferred (same repo prefix +
  `:environment:production`) — confirm it on your first manual deploy (the
  apply job logs in without `AccessDenied`, or check the CloudTrail
  `AssumeRoleWithWebIdentity` event's `userName`).

### 2. Store the role ARNs, region + state bucket as GitHub **Variables** (none is sensitive)

The workflow reads these. Read the values from `terraform output`, then:

```bash
gh variable set AWS_PLAN_ROLE_ARN  --repo jasmine-nguyen/abundo --body "$(terraform output -raw plan_role_arn)"
gh variable set AWS_APPLY_ROLE_ARN --repo jasmine-nguyen/abundo --body "$(terraform output -raw apply_role_arn)"
gh variable set AWS_REGION         --repo jasmine-nguyen/abundo --body "$(terraform output -raw aws_region)"
gh variable set TF_STATE_BUCKET    --repo jasmine-nguyen/abundo --body "$(terraform output -raw state_bucket_name)"
```

The state **bucket name** carries your account id, and a `backend "s3"` block can't
read variables — so the workflow (and your local migrate step) pass it to
`terraform init` via `-backend-config="bucket=$TF_STATE_BUCKET"`. The **key**
(`abundo/terraform.tfstate`), **region** (`ap-southeast-2`), and **lock table**
(`abundo-tfstate-lock`) have no account-specific part, so they're literals in the
backend block, not Variables (`TF_LOCK_TABLE` is intentionally not needed).

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

### 4. Create the `production` environment (unprotected) — needed for the login

This is **not** the gate (the manual Run-workflow button is — see step 8). The
environment must still exist for a different reason: the apply role's trust is pinned
to the OIDC subject `...:environment:production`, and GitHub only puts that
`:environment:production` segment in the token **when the apply job declares this
environment**. No environment → wrong subject → the deploy can't log in.

> **Why not a required reviewer?** Environment protection rules (required reviewers,
> branch policies) are **Enterprise-only for private repos**. This repo can't have
> them, which is exactly why the deploy is a manual button instead.

Create it (unprotected is expected and fine):

```bash
gh api --method PUT repos/jasmine-nguyen/abundo/environments/production
# (GitHub also auto-creates it the first time the apply job names it; this is just explicit.)
```

**Verify it exists — and expect NO protection rules:**

```bash
gh api repos/jasmine-nguyen/abundo/environments/production -q '.protection_rules[].type'
# Empty output is EXPECTED (no reviewer rule available on this plan). The gate is the
# manual button in step 8, plus: only you (with Actions write access) can press it.
```

- **`main` only is by convention.** Branch-restriction is part of the same
  Enterprise-only protection feature, so we can't enforce it. The apply role's trust
  is pinned to `environment:production` but not to a branch → the Run-workflow menu
  lets you pick any branch. **Always run it from `main`.**
- The name must be exactly `production` (pinned in the apply role's trust and `deploy.yml`).

### 5. Generate + commit the provider lock files (multi-platform) — MANDATORY

The deploy runs non-interactively (no prompt to pin a version mid-run), so provider
versions must be **pinned** (not re-resolved from `~> 6.0` every run). CI runs on Linux
and your Mac isn't, so generate the lock for
both platforms. **The PR2 branch the assistant pushes does NOT contain these lock
files — you generate them here and commit them onto the PR2 branch before merge**
(the assistant's sandbox can't reach the provider registry). CI's first `init` works
without them; committing them pins every run after.

```bash
cd terraform             && terraform providers lock -platform=linux_amd64 -platform=darwin_amd64 -platform=darwin_arm64
cd ../terraform/bootstrap && terraform providers lock -platform=linux_amd64 -platform=darwin_amd64 -platform=darwin_arm64
# then commit BOTH terraform/.terraform.lock.hcl and terraform/bootstrap/.terraform.lock.hcl onto the PR2 branch
```

(You'll actually run this during step 6, once you've checked out the PR2 branch.)

---

## Stage B — PR2 (the deploy button)

PR2 adds the `backend "s3"` block to `terraform/providers.tf` (key/region/lock table
as literals; **bucket** supplied at init via `-backend-config` from the
`TF_STATE_BUCKET` Variable), `.github/workflows/deploy.yml`, the `.gitignore` change
that stops ignoring the lock files, and `scripts/build_terraform_artifacts.sh` — the
one recipe the workflow runs to rebuild the gitignored lambda/layer bundles before
Terraform (CI can't rely on Terraform's own build steps re-firing against remote
state). You add the committed lock files (step 5) onto the branch.

### 6. Migrate state onto the PR2 branch (on your Mac)

The assistant opens PR2 for you. Its **first** CI preview runs before your state is
migrated, so it plans "create everything" against the still-empty remote state —
**ignore that first preview**; it's superseded once you migrate. Then, on your Mac:

```bash
git fetch && git checkout claude/westpac-feed-transactions-5qhd4d
cd terraform
terraform init -migrate-state \
  -backend-config="bucket=$(cd bootstrap && terraform output -raw state_bucket_name)"   # answer "yes" to copy local state up
terraform plan
aws s3 ls "s3://$(cd bootstrap && terraform output -raw state_bucket_name)/abundo/"
# ^ confirm the object exists at abundo/terraform.tfstate (the key CI is scoped to)
```

**What that `plan` should show:** the three `null_resource.prepare_*` appear as
**replaced** — this PR moved their build into `scripts/build_terraform_artifacts.sh`,
which changes their triggers; they rebuild byte-identical bundles, so it's benign.
What must be true: **zero destroys**, and **zero changes to real AWS resources**
(`aws_lambda_function.*`, `aws_cognito_*`, `aws_sns_*`, …). A destroy — especially of
`aws_cognito_identity_provider.google` or `aws_sns_topic_subscription.alerts_email` —
means a `TF_VAR_*` from step 3 is missing locally; stop and fix it.

Then generate + commit the lock files (step 5) and push the branch.

### 7. Read the CI preview before you merge — the real destroy-guard

Merging no longer deploys anything, but the preview is still what proves **CI** holds
the secrets before your first manual deploy. Your local `plan` used **your Mac's**
secrets; the **preview plan comment** the workflow posts after your migrate + lock
push is the one that used CI's:

- Expected: the three `null_resource.prepare_*` replaced (benign, as above), and
  **zero destroys** of `aws_cognito_identity_provider.google` /
  `aws_sns_topic_subscription.alerts_email`, and no real-resource changes you didn't
  intend.
- If a repository secret from step 3 is missing, that resource plans a destroy — and
  because it carries `prevent_destroy`, the **plan step goes red** (a hard check
  failure), not just a line in the comment. Fix the secret, push again.
- **Do not merge until the preview is clean.**

### 8. Merge PR2, then deploy with the button

From now on:
- Open a PR touching `terraform/`, `lambda*/`, or `shared/` → the workflow posts a
  **preview** (plan) as a comment. Nothing is deployed.
- Merge to `main` → **nothing deploys.** The merge just makes the change live in the
  repo.
- **To deploy:** GitHub → **Actions → "Deploy (Terraform)" → Run workflow →** pick
  branch **`main`** → Run. That runs `terraform apply`. Clicking Run **is** the gate.
- **The gate is your click, not the tests.** The test suites run on PRs, but nothing
  blocks the button — glance at the checks before you Run.

Two things to know about the button:
- It only appears **after this workflow file is on `main`** (i.e. after PR2 merges) —
  before that, there's no Run-workflow button to find.
- A second Run **from `main`** queues behind an in-flight one (it never cancels a
  running apply) — apply is never interrupted midway. (Queueing is per-branch, so this
  holds as long as you always Run from `main`, which you should.)

You never run `terraform apply` from your Mac again — you press the button instead.

---

## Security note (accepted for a single-user private repo)

A preview (`plan`) on a PR **from this repo** runs with the real `TF_VAR_*` secrets
so the preview is accurate. That's bounded: it needs repo write access, the plan role
is read-only, and the secrets are `sensitive` so they're masked in plan output/logs.
PRs from **forks** are skipped entirely (they get no token or secrets). Accepted for a
one-owner private repo; revisit if collaborators are ever added.
