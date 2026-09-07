variable "project_name" {
  description = "Prefix used for naming all resources (matches the main module)"
  type        = string
  default     = "abundo"
}

variable "aws_region" {
  description = "AWS region to deploy into (matches the main module)"
  type        = string
  default     = "ap-southeast-2"
}

# Only GitHub Actions runs in this repo may assume the CI roles. The OIDC trust
# policies pin the `sub` claim to this repo, so a token minted by any other repo
# is rejected. GitHub now mints the "immutable" subject form that carries numeric
# owner/repo ids (repo:owner@<owner_id>/name@<repo_id>:...) instead of the legacy
# name-only form (repo:owner/name:...); the trust accepts BOTH (see main.tf).
variable "github_repo" {
  description = "owner/name of the GitHub repo allowed to assume the CI roles"
  type        = string
  default     = "jasmine-nguyen/abundo"

  # The immutable subject is built by split("/", ...) on this, so it must be
  # exactly "owner/name". Catch a bare name or an extra slash at plan time
  # rather than shipping a silently-wrong subject that only fails in CI.
  validation {
    condition     = can(regex("^[^/]+/[^/]+$", var.github_repo))
    error_message = "github_repo must be exactly \"owner/name\" (a single slash)."
  }
}

# Numeric ids GitHub embeds in the immutable OIDC subject. They stay constant even
# if the repo is renamed or transferred (that is the point of the immutable form),
# so they are safe defaults. Find them with:
#   gh api users/jasmine-nguyen -q .id      (owner id)
#   gh api repos/jasmine-nguyen/abundo -q .id  (repo id)
# A brand-new repo (different owner/name) needs its own ids here.
variable "github_owner_id" {
  description = "GitHub numeric account id of the repo owner (immutable OIDC subject)"
  type        = string
  default     = "14210106"

  # Digits only. A non-numeric or whitespace typo would apply cleanly but build a
  # wrong subject that only fails at CI login time — catch it here instead.
  validation {
    condition     = can(regex("^[0-9]+$", var.github_owner_id))
    error_message = "github_owner_id must be the numeric GitHub account id (digits only)."
  }
}

variable "github_repo_id" {
  description = "GitHub numeric repository id (immutable OIDC subject)"
  type        = string
  default     = "1278895259"

  validation {
    condition     = can(regex("^[0-9]+$", var.github_repo_id))
    error_message = "github_repo_id must be the numeric GitHub repository id (digits only)."
  }
}

# The GitHub Environment the deploy job declares. The apply role's trust is pinned
# to "...:environment:<this>", so ONLY a job that declares this environment can
# assume the apply role. (Required-reviewer protection is Enterprise-only for private
# repos, so the actual deploy gate is deploy.yml's manual workflow_dispatch trigger,
# not this environment.) This exact name must match the environment created in the
# repo settings AND the `environment:` in deploy.yml.
variable "environment_name" {
  description = "GitHub Environment the apply job declares; the apply role's trust is pinned to it"
  type        = string
  default     = "production"
}

# Breadth of the CI deploy (apply) role. "scoped" limits it to the services this
# stack actually manages; "broad" gives it AdministratorAccess. Flip with a single
# -var, no code edit. See DECISION 1 in DEPLOY.md.
variable "apply_policy_scope" {
  description = "Deploy-role permission breadth: \"scoped\" (only this stack's services) or \"broad\" (AdministratorAccess)"
  type        = string
  default     = "scoped"

  validation {
    condition     = contains(["scoped", "broad"], var.apply_policy_scope)
    error_message = "apply_policy_scope must be \"scoped\" or \"broad\"."
  }
}
