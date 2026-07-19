# Cognito single-user login (WHIT-97) — card 1 of the auth epic.
#
# This adds the identity infrastructure only: a user pool, a public PKCE app
# client, a Hosted UI domain, and (optionally) Google/Apple federated IdPs. The
# API Gateway JWT authorizer that consumes this pool lives in apigateway.tf and
# now guards every app route (cutover done in WHIT-162; the legacy shared-secret
# authorizer was removed in WHIT-173).
#
# SINGLE-USER GATE — IMPORTANT: `allow_admin_create_user_only` below only blocks
# self-service username/password signup. Federated login (Google/Apple) still
# auto-provisions a Cognito user for ANY account that completes the Hosted UI
# flow. That is harmless while no route uses the JWT authorizer, but WHIT-162
# MUST NOT cut routes over to JWT until a Pre-Sign-Up allowlist Lambda rejects
# non-allowlisted emails. Tracked as a hard blocker on WHIT-162.

locals {
  # Single source of truth for the pool's OIDC issuer. The JWT authorizer
  # validates tokens against this and the client (WHIT-160) trusts the exported
  # copy — they MUST stay byte-identical, so build the string once.
  cognito_issuer_url = "https://cognito-idp.${var.aws_region}.amazonaws.com/${aws_cognito_user_pool.pool.id}"
}

resource "aws_cognito_user_pool" "pool" {
  name                     = "${var.project_name}-user-pool"
  username_attributes      = ["email"]
  auto_verified_attributes = ["email"]

  # Single-user: only an admin (you, via console/CLI) creates the one user. No
  # public self-service signup. (Does not gate federated login — see note above.)
  admin_create_user_config {
    allow_admin_create_user_only = true
  }

  password_policy {
    minimum_length    = 12
    require_lowercase = true
    require_uppercase = true
    require_numbers   = true
    require_symbols   = true
  }

  # This pool holds the account's only login — guard against an accidental
  # `terraform destroy` wiping it.
  deletion_protection = "ACTIVE"

  # WHIT-162: single-user allowlist. The Pre-Sign-Up trigger rejects any email not
  # in var.allowed_login_emails, so federated (Google/Apple) sign-up can't
  # provision arbitrary users — the gate that admin-create-only can't provide.
  lambda_config {
    pre_sign_up = aws_lambda_function.auth_presignup.arn
  }
}

# --- Federated identity providers -------------------------------------------
# Both are count-gated on their credential variable: with the default empty
# value the IdP is skipped entirely, so `terraform apply` succeeds before you
# have the external credentials. Supply them via TF_VAR_* env vars (NOT a
# committed *.tfvars — see terraform/.gitignore) and re-apply to light them up.

resource "aws_cognito_identity_provider" "google" {
  count         = var.google_client_id != "" ? 1 : 0
  user_pool_id  = aws_cognito_user_pool.pool.id
  provider_name = "Google"
  provider_type = "Google"

  provider_details = {
    client_id        = var.google_client_id
    client_secret    = var.google_client_secret
    authorize_scopes = "openid email profile"
  }

  # email_verified is mapped (WHIT-173) so the Pre-Sign-Up trigger can require a
  # verified email for federated sign-ups. Google asserts it (boolean true) on its
  # OIDC claims. Without this mapping the attribute is absent at Pre-Sign-Up and the
  # verified-email gate would reject the real user — so this line and the handler
  # check must land together.
  attribute_mapping = {
    email          = "email"
    email_verified = "email_verified"
  }

  # The count-gate keys off google_client_id alone; Google also needs the
  # secret. Fail at plan with a clear message instead of an opaque AWS 400
  # mid-apply if only the id was supplied.
  lifecycle {
    precondition {
      condition     = var.google_client_secret != ""
      error_message = "google_client_id is set but google_client_secret is empty — Google sign-in needs both."
    }
    ignore_changes = [
      provider_details["attributes_url"],
      provider_details["attributes_url_add_attributes"],
      provider_details["authorize_url"],
      provider_details["oidc_issuer"],
      provider_details["token_request_method"],
      provider_details["token_url"],
      attribute_mapping["username"],
    ]
  }
}
resource "aws_cognito_identity_provider" "apple" {
  count         = var.apple_services_id != "" ? 1 : 0
  user_pool_id  = aws_cognito_user_pool.pool.id
  provider_name = "SignInWithApple"
  provider_type = "SignInWithApple"

  provider_details = {
    client_id        = var.apple_services_id
    team_id          = var.apple_team_id
    key_id           = var.apple_key_id
    private_key      = var.apple_private_key
    authorize_scopes = "email name"
  }

  # NOTE (WHIT-173): Apple is NOT configured today (count-gated on apple_services_id,
  # which is empty), so email_verified is deliberately NOT mapped here — the scope was
  # Google-only. If Apple sign-in is ever turned on, add `email_verified =
  # "email_verified"` below, or the Pre-Sign-Up verified-email gate
  # (lambda_presignup/handler.py) will reject every Apple login (the attribute would be
  # absent). Verify Apple's value arrives as the string "true" — the handler check is
  # already tolerant of both "true" and boolean True.
  attribute_mapping = {
    email = "email"
  }

  # The count-gate keys off apple_services_id alone; Apple also needs team_id,
  # key_id and the .p8 private key. Fail at plan with a clear message instead of
  # an opaque AWS 400 mid-apply if the set is incomplete.
  lifecycle {
    precondition {
      condition     = var.apple_team_id != "" && var.apple_key_id != "" && var.apple_private_key != ""
      error_message = "apple_services_id is set but apple_team_id, apple_key_id or apple_private_key is empty — Apple sign-in needs all four."
    }
  }
}

# --- Public PKCE app client --------------------------------------------------
resource "aws_cognito_user_pool_client" "app" {
  name         = "${var.project_name}-app-client"
  user_pool_id = aws_cognito_user_pool.pool.id

  # Public client: no secret, authorization-code flow with PKCE (WHIT-160).
  generate_secret                      = false
  allowed_oauth_flows_user_pool_client = true
  allowed_oauth_flows                  = ["code"]
  allowed_oauth_scopes                 = ["openid", "email", "profile"]

  # WHIT-177: native (non-Hosted-UI) auth. USER_SRP_AUTH lets the app's own login
  # form authenticate email/password directly via SRP — the password never leaves
  # the device in the clear — so we can retire the Hosted UI page. REFRESH_TOKEN_AUTH
  # keeps sessions alive. The Hosted UI OAuth flows above are KEPT: federated Google
  # (WHIT-179) still redirects through them. In-place update — the client id is
  # unchanged, so the app's EXPO_PUBLIC_COGNITO_APP_CLIENT_ID and the API Gateway
  # JWT authorizer audience stay valid.
  explicit_auth_flows = ["ALLOW_USER_SRP_AUTH", "ALLOW_REFRESH_TOKEN_AUTH"]

  # WHIT-178: return a generic "incorrect username or password" for a bad login
  # instead of distinguishing UserNotFound from NotAuthorized — so the native login
  # form can't be used to probe which emails are registered. In-place update.
  prevent_user_existence_errors = "ENABLED"

  callback_urls = var.auth_callback_urls
  logout_urls   = var.auth_logout_urls

  # Only advertise IdPs that were actually created (COGNITO always; Google/Apple
  # only when their credentials were supplied). Keeps the client valid whether
  # or not the federated IdPs exist yet.
  supported_identity_providers = concat(
    ["COGNITO"],
    var.google_client_id != "" ? ["Google"] : [],
    var.apple_services_id != "" ? ["SignInWithApple"] : [],
  )

  # The client lists Google/Apple in supported_identity_providers, so it must be
  # created after those IdPs exist. depends_on on a count=0 resource is a no-op.
  depends_on = [
    aws_cognito_identity_provider.google,
    aws_cognito_identity_provider.apple,
  ]
}

# --- Hosted UI domain --------------------------------------------------------
# Prefix domain (<prefix>.auth.<region>.amazoncognito.com). No ACM cert / custom
# domain needed — the JWT authorizer keys off the pool's issuer URL, not this
# domain. NOTE: the prefix must be globally unique across ALL AWS accounts; if
# `abundo-auth` is taken, `apply` errors — change var.cognito_domain_prefix.
resource "aws_cognito_user_pool_domain" "hosted_ui" {
  domain       = var.cognito_domain_prefix
  user_pool_id = aws_cognito_user_pool.pool.id
}
