variable "aws_region" {
  description = "AWS region to deploy into"
  type        = string
  default     = "ap-southeast-2"
}

variable "project_name" {
  description = "Prefix used for naming all resources"
  type        = string
  default     = "whittle"
}

# Emails permitted to sign in (WHIT-162). The Cognito Pre-Sign-Up trigger rejects
# any federated (Google/Apple) account whose email isn't in this list at account
# creation — the single-user gate. Supplied to the Lambda via the ALLOWED_EMAILS
# env var. Add a backup address here + re-apply if your login method ever changes.
variable "allowed_login_emails" {
  description = "Emails allowed to sign in via Cognito (single-user allowlist)"
  type        = list(string)
  default     = ["me.jasminenguyen@gmail.com"]
}

# Cadence for the self-hosted BankSync sync. Default is hourly (24x/day) to keep
# transactions fresh, bypassing BankSync's daily UI cap. Assumes no per-call rate
# quota beyond that cap. Accepts any EventBridge Scheduler expression, e.g.
# "rate(6 hours)" or "cron(0 */3 * * ? *)".
variable "sync_schedule_expression" {
  description = "EventBridge Scheduler expression controlling how often BankSync feeds are synced"
  type        = string
  default     = "rate(1 hour)"
}

# Cadence for the home-loan balance poll (WHIT-8). Daily is plenty — a mortgage
# balance changes at most once a day (a repayment or interest posting). Accepts
# any EventBridge Scheduler expression.
variable "balance_poll_schedule_expression" {
  description = "EventBridge Scheduler expression controlling how often the home-loan balance is polled"
  type        = string
  default     = "rate(1 day)"
}

# Cadence for the Expo push-receipts sweep (WHIT-139). Every 30 min: Expo retains
# receipts only ~24h, and prompt detection of a silently-failed alert is the point of
# the sweep — cost is negligible at single-user volume. Accepts any EventBridge Scheduler
# expression.
variable "push_receipts_schedule_expression" {
  description = "EventBridge Scheduler expression controlling how often Expo push receipts are swept"
  type        = string
  default     = "rate(30 minutes)"
}

# Cadence for the stale-pending age-out sweep (WHIT-79). Daily is plenty — a pending
# only becomes reapable once it's >10 days old, so nothing is gained by sweeping more
# often. Accepts any EventBridge Scheduler expression.
variable "age_out_schedule_expression" {
  description = "EventBridge Scheduler expression controlling how often stale pending transactions are aged out"
  type        = string
  default     = "rate(1 day)"
}

# Email subscribed to the shared CloudWatch alerts SNS topic (WHIT-79). The topic + alarms
# are always created; leave this empty to skip the email subscription, or set it (in a
# gitignored tfvars) to receive alerts. AWS sends a one-time confirmation email that must
# be accepted before any alert is delivered.
variable "alert_email" {
  description = "Email address subscribed to the CloudWatch alerts SNS topic (empty = no email subscription)"
  type        = string
  default     = ""
}

# --- Cognito auth (WHIT-97) --------------------------------------------------

# OAuth redirect URIs for the Cognito app client. `acme` matches the Expo app
# scheme (app.json). WHIT-160 finalises these once the client login flow is
# built; Cognito callback URLs are an in-place update, no resource replacement.
variable "auth_callback_urls" {
  description = "OAuth redirect URIs (callback) for the Cognito app client"
  type        = list(string)
  default     = ["acme://oauthredirect"]
}

variable "auth_logout_urls" {
  description = "Post-logout redirect URIs for the Cognito app client"
  type        = list(string)
  default     = ["acme://signout"]
}

# Globally-unique prefix for the Hosted UI domain
# (<prefix>.auth.<region>.amazoncognito.com). Change if the prefix is taken.
variable "cognito_domain_prefix" {
  description = "Prefix for the Cognito Hosted UI domain (must be globally unique across all AWS accounts)"
  type        = string
  default     = "whittle-auth"
}

# Google/Apple federated IdP credentials. Each IdP is count-gated on its id being
# non-empty, so `apply` succeeds with the empty defaults (IdP simply skipped)
# before you have the credentials. Supply via TF_VAR_* env vars — NOT a
# committed *.tfvars file (which would leak the Google secret / Apple key).
variable "google_client_id" {
  description = "Google OAuth client ID (empty = Google sign-in not configured)"
  type        = string
  sensitive   = true
  default     = ""
}

variable "google_client_secret" {
  description = "Google OAuth client secret"
  type        = string
  sensitive   = true
  default     = ""
}

variable "apple_services_id" {
  description = "Apple Sign In Services ID / client_id (empty = Apple sign-in not configured)"
  type        = string
  sensitive   = true
  default     = ""
}

variable "apple_team_id" {
  description = "Apple Developer Team ID"
  type        = string
  sensitive   = true
  default     = ""
}

variable "apple_key_id" {
  description = "Apple Sign In private key ID"
  type        = string
  sensitive   = true
  default     = ""
}

variable "apple_private_key" {
  description = "Apple Sign In private key (.p8 file contents)"
  type        = string
  sensitive   = true
  default     = ""
}
