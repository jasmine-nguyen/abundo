locals {
  # The key the MAIN module's S3 backend will use for its state object. Defined
  # here so the CI roles' state-access policy grants exactly this key. PR2's
  # `backend "s3"` block must use the same value (see DEPLOY.md).
  state_key = "${var.project_name}/terraform.tfstate"

  # OIDC subject prefixes the CI roles trust. GitHub mints two forms depending on
  # the repo: the legacy name-only form and the newer immutable form carrying the
  # numeric owner/repo ids. Both are derived from var.github_repo (single source of
  # owner/name), so only the ids live separately. github_repo must stay "owner/name".
  github_repo_parts    = split("/", var.github_repo)
  sub_prefix_legacy    = "repo:${var.github_repo}"
  sub_prefix_immutable = "repo:${local.github_repo_parts[0]}@${var.github_owner_id}/${local.github_repo_parts[1]}@${var.github_repo_id}"
}

# --- Remote state backend infra ----------------------------------------------

# Holds the MAIN module's terraform state. Account-id suffix makes the name
# globally unique. Versioned so a bad write can be rolled back.
resource "aws_s3_bucket" "tfstate" {
  bucket = "${var.project_name}-tfstate-${data.aws_caller_identity.current.account_id}"

  # Losing this bucket loses the record of everything deployed. Block a destroy.
  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_s3_bucket_versioning" "tfstate" {
  bucket = aws_s3_bucket.tfstate.id
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "tfstate" {
  bucket = aws_s3_bucket.tfstate.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_public_access_block" "tfstate" {
  bucket                  = aws_s3_bucket.tfstate.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

# State keeps every version forever otherwise; reap old versions after 90 days.
resource "aws_s3_bucket_lifecycle_configuration" "tfstate" {
  # Noncurrent-version expiry presumes versioning is already on.
  depends_on = [aws_s3_bucket_versioning.tfstate]
  bucket     = aws_s3_bucket.tfstate.id
  rule {
    id     = "expire-noncurrent-state"
    status = "Enabled"
    filter {}
    noncurrent_version_expiration {
      noncurrent_days = 90
    }
  }
}

# State lock: Terraform writes a LockID item here for the duration of a
# plan/apply so two runs can't corrupt state by writing at once.
resource "aws_dynamodb_table" "tflock" {
  name         = "${var.project_name}-tfstate-lock"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "LockID"

  attribute {
    name = "LockID"
    type = "S"
  }

  # The lock guards against two concurrent writes corrupting state; don't destroy it.
  lifecycle {
    prevent_destroy = true
  }
}

# --- GitHub OIDC trust -------------------------------------------------------

# Lets GitHub Actions exchange its signed OIDC token for short-lived AWS
# credentials — no long-lived access key is ever stored in GitHub.
# thumbprint_list is omitted on purpose: current AWS provider versions validate
# GitHub's OIDC endpoint against IAM's trusted CA store, so a hard-coded
# thumbprint is unnecessary and would rot when GitHub rotates its certificate.
# Only one provider per URL per account may exist — DEPLOY.md has a pre-check.
resource "aws_iam_openid_connect_provider" "github" {
  url            = "https://token.actions.githubusercontent.com"
  client_id_list = ["sts.amazonaws.com"]
}

# State access is split by role. `plan` only READS the state object (and takes the
# lock); only `apply` WRITES it. Keeping PutObject off the plan role matters because
# the plan role is assumed by `pull_request` runs, whose workflow a PR can edit — so
# it must never be able to overwrite state. Neither role needs s3:DeleteObject (an
# S3+DynamoDB backend never deletes the versioned state object).
resource "aws_iam_policy" "tfstate_plan" {
  name        = "${var.project_name}-tfstate-plan"
  description = "Read the Terraform state and take the lock — plan only, no state writes"
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid      = "ListStateBucket"
        Effect   = "Allow"
        Action   = "s3:ListBucket"
        Resource = aws_s3_bucket.tfstate.arn
      },
      {
        Sid      = "ReadStateObject"
        Effect   = "Allow"
        Action   = "s3:GetObject"
        Resource = "${aws_s3_bucket.tfstate.arn}/${local.state_key}"
      },
      {
        Sid      = "TakeStateLock"
        Effect   = "Allow"
        Action   = ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:DeleteItem"]
        Resource = aws_dynamodb_table.tflock.arn
      },
    ]
  })
}

resource "aws_iam_policy" "tfstate_apply" {
  name        = "${var.project_name}-tfstate-apply"
  description = "Read/write the Terraform state object and take the lock — apply"
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid      = "ListStateBucket"
        Effect   = "Allow"
        Action   = "s3:ListBucket"
        Resource = aws_s3_bucket.tfstate.arn
      },
      {
        Sid      = "ReadWriteStateObject"
        Effect   = "Allow"
        Action   = ["s3:GetObject", "s3:PutObject"]
        Resource = "${aws_s3_bucket.tfstate.arn}/${local.state_key}"
      },
      {
        Sid      = "TakeStateLock"
        Effect   = "Allow"
        Action   = ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:DeleteItem"]
        Resource = aws_dynamodb_table.tflock.arn
      },
    ]
  })
}

# --- Plan role: assumed by PR (pull_request) runs, read-only + state ----------

# Trust is pinned to the `pull_request` subject only, so this role can be assumed
# from a PR run but never from a push to a branch. Both the legacy and immutable
# subject forms are accepted (a list under StringEquals is an OR) so the login
# works whichever form GitHub mints for this repo.
resource "aws_iam_role" "github_plan" {
  name = "${var.project_name}-github-plan"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Federated = aws_iam_openid_connect_provider.github.arn }
      Action    = "sts:AssumeRoleWithWebIdentity"
      Condition = {
        StringEquals = {
          "token.actions.githubusercontent.com:aud" = "sts.amazonaws.com"
          "token.actions.githubusercontent.com:sub" = [
            "${local.sub_prefix_legacy}:pull_request",
            "${local.sub_prefix_immutable}:pull_request",
          ]
        }
      }
    }]
  })
}

resource "aws_iam_role_policy_attachment" "plan_readonly" {
  role       = aws_iam_role.github_plan.name
  policy_arn = "arn:aws:iam::aws:policy/ReadOnlyAccess"
}

resource "aws_iam_role_policy_attachment" "plan_state" {
  role       = aws_iam_role.github_plan.name
  policy_arn = aws_iam_policy.tfstate_plan.arn
}

# --- Apply role: assumed only by the gated `production` deploy job -------------

# Trust is pinned to the `environment:<environment_name>` subject, so this role
# can ONLY be assumed by a job that declares that environment — which means the
# job has already passed the environment's required-reviewer approval. A PR run
# (subject `pull_request`) can never assume it. Both the legacy and immutable
# subject forms are accepted (a list under StringEquals is an OR).
resource "aws_iam_role" "github_apply" {
  name = "${var.project_name}-github-apply"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Federated = aws_iam_openid_connect_provider.github.arn }
      Action    = "sts:AssumeRoleWithWebIdentity"
      Condition = {
        StringEquals = {
          "token.actions.githubusercontent.com:aud" = "sts.amazonaws.com"
          "token.actions.githubusercontent.com:sub" = [
            "${local.sub_prefix_legacy}:environment:${var.environment_name}",
            "${local.sub_prefix_immutable}:environment:${var.environment_name}",
          ]
        }
      }
    }]
  })
}

resource "aws_iam_role_policy_attachment" "apply_state" {
  role       = aws_iam_role.github_apply.name
  policy_arn = aws_iam_policy.tfstate_apply.arn
}

# "broad" → AdministratorAccess. Simple, never blocks a new resource type, but an
# admin token in the apply job could rewrite its own trust via a raw AWS call
# (residual risk noted in DEPLOY.md). Off by default.
resource "aws_iam_role_policy_attachment" "apply_admin" {
  count      = var.apply_policy_scope == "broad" ? 1 : 0
  role       = aws_iam_role.github_apply.name
  policy_arn = "arn:aws:iam::aws:policy/AdministratorAccess"
}

# "scoped" (default) → only the services this stack manages. Note this is
# service-scoped, not resource-scoped: iam:* is required because the stack
# creates/updates the lambdas' execution roles, so the apply role can still
# manage IAM broadly. It cannot touch services outside this list (EC2, RDS, ...).
resource "aws_iam_role_policy" "apply_scoped" {
  count = var.apply_policy_scope == "scoped" ? 1 : 0
  name  = "${var.project_name}-github-apply-scoped"
  role  = aws_iam_role.github_apply.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect = "Allow"
      Action = [
        "lambda:*",
        "iam:*",
        "dynamodb:*",
        "cognito-idp:*",
        "cognito-identity:*",
        "apigateway:*",
        "execute-api:*",
        "ssm:*",
        "scheduler:*",
        "events:*",
        "sns:*",
        "logs:*",
        "cloudwatch:*",
        "s3:*",
        "resource-groups:*",
        "tag:*",
      ]
      Resource = "*"
    }]
  })
}
