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
# policies pin the `sub` claim to "repo:<github_repo>:...", so a token minted by
# any other repo is rejected.
variable "github_repo" {
  description = "owner/name of the GitHub repo allowed to assume the CI roles"
  type        = string
  default     = "jasmine-nguyen/abundo"
}

# The GitHub Environment that gates the deploy job. The apply role's trust is
# pinned to "...:environment:<this>", so ONLY a job that declares this
# environment (and therefore passes its required-reviewer approval) can assume the
# apply role. This exact name must match the protected environment created in the
# repo settings AND the `environment:` in deploy.yml.
variable "environment_name" {
  description = "GitHub Environment that gates the apply job and the apply role's trust"
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
