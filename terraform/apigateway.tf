resource "aws_apigatewayv2_api" "api" {
  name          = "${var.project_name}-api"
  protocol_type = "HTTP"
}

resource "aws_apigatewayv2_stage" "default" {
  api_id      = aws_apigatewayv2_api.api.id
  name        = "$default"
  auto_deploy = true
}

# lambda api endpoint used by whittle app to retrieve data from DynamoDB
resource "aws_apigatewayv2_integration" "get_transactions_integration" {
  api_id                 = aws_apigatewayv2_api.api.id
  integration_type       = "AWS_PROXY"
  integration_uri        = aws_lambda_function.lambda_api.invoke_arn
  payload_format_version = "2.0"
}

resource "aws_apigatewayv2_route" "get_transactions_route" {
  api_id             = aws_apigatewayv2_api.api.id
  route_key          = "GET /transactions"
  target             = "integrations/${aws_apigatewayv2_integration.get_transactions_integration.id}"
  authorization_type = "JWT"
  authorizer_id      = aws_apigatewayv2_authorizer.jwt.id
}

# PATCH a single transaction's category; reuses the lambda_api integration.
# No new lambda permission needed: get_transactions_invoke_permission already
# grants apigateway invoke over ${execution_arn}/*/* (any method + route).
resource "aws_apigatewayv2_route" "patch_transaction_category_route" {
  api_id             = aws_apigatewayv2_api.api.id
  route_key          = "PATCH /transactions/{id}"
  target             = "integrations/${aws_apigatewayv2_integration.get_transactions_integration.id}"
  authorization_type = "JWT"
  authorizer_id      = aws_apigatewayv2_authorizer.jwt.id
}

# Batch PATCH: set the category on many transactions in one request (WHIT-70).
# Distinct from the {id} item route above ("/transactions" != "/transactions/{id}").
# The /*/* invoke permission already covers it.
resource "aws_apigatewayv2_route" "patch_transactions_batch_route" {
  api_id             = aws_apigatewayv2_api.api.id
  route_key          = "PATCH /transactions"
  target             = "integrations/${aws_apigatewayv2_integration.get_transactions_integration.id}"
  authorization_type = "JWT"
  authorizer_id      = aws_apigatewayv2_authorizer.jwt.id
}

# Category taxonomy CRUD (list/create); reuse the lambda_api integration.
# The /*/* invoke permission already covers these, so no new lambda permission.
resource "aws_apigatewayv2_route" "get_categories_route" {
  api_id             = aws_apigatewayv2_api.api.id
  route_key          = "GET /categories"
  target             = "integrations/${aws_apigatewayv2_integration.get_transactions_integration.id}"
  authorization_type = "JWT"
  authorizer_id      = aws_apigatewayv2_authorizer.jwt.id
}

resource "aws_apigatewayv2_route" "post_category_route" {
  api_id             = aws_apigatewayv2_api.api.id
  route_key          = "POST /categories"
  target             = "integrations/${aws_apigatewayv2_integration.get_transactions_integration.id}"
  authorization_type = "JWT"
  authorizer_id      = aws_apigatewayv2_authorizer.jwt.id
}

resource "aws_apigatewayv2_route" "patch_category_route" {
  api_id             = aws_apigatewayv2_api.api.id
  route_key          = "PATCH /categories/{id}"
  target             = "integrations/${aws_apigatewayv2_integration.get_transactions_integration.id}"
  authorization_type = "JWT"
  authorizer_id      = aws_apigatewayv2_authorizer.jwt.id
}

resource "aws_apigatewayv2_route" "delete_category_route" {
  api_id             = aws_apigatewayv2_api.api.id
  route_key          = "DELETE /categories/{id}"
  target             = "integrations/${aws_apigatewayv2_integration.get_transactions_integration.id}"
  authorization_type = "JWT"
  authorizer_id      = aws_apigatewayv2_authorizer.jwt.id
}

# Budget targets: read all (GET /budgets) + set one (PUT /budgets/{category}).
# Reuse the lambda_api integration; the /*/* invoke permission already covers
# these, so no new integration or lambda permission is needed.
resource "aws_apigatewayv2_route" "get_budgets_route" {
  api_id             = aws_apigatewayv2_api.api.id
  route_key          = "GET /budgets"
  target             = "integrations/${aws_apigatewayv2_integration.get_transactions_integration.id}"
  authorization_type = "JWT"
  authorizer_id      = aws_apigatewayv2_authorizer.jwt.id
}

resource "aws_apigatewayv2_route" "put_budget_route" {
  api_id             = aws_apigatewayv2_api.api.id
  route_key          = "PUT /budgets/{category}"
  target             = "integrations/${aws_apigatewayv2_integration.get_transactions_integration.id}"
  authorization_type = "JWT"
  authorizer_id      = aws_apigatewayv2_authorizer.jwt.id
}

# Category breakdown (WHIT-23): spend by category for the current cycle. Reuse the
# lambda_api integration; the /*/* invoke permission already covers it, so no new
# integration or lambda permission is needed.
resource "aws_apigatewayv2_route" "get_breakdown_route" {
  api_id             = aws_apigatewayv2_api.api.id
  route_key          = "GET /breakdown"
  target             = "integrations/${aws_apigatewayv2_integration.get_transactions_integration.id}"
  authorization_type = "JWT"
  authorizer_id      = aws_apigatewayv2_authorizer.jwt.id
}

# Home-loan balance (WHIT-8): the live mortgage balance the poller stores. Reuse
# the lambda_api integration; the /*/* invoke permission already covers it, so no
# new integration or lambda permission is needed.
resource "aws_apigatewayv2_route" "get_homeloan_route" {
  api_id             = aws_apigatewayv2_api.api.id
  route_key          = "GET /homeloan"
  target             = "integrations/${aws_apigatewayv2_integration.get_transactions_integration.id}"
  authorization_type = "JWT"
  authorizer_id      = aws_apigatewayv2_authorizer.jwt.id
}

# Last home-loan repayment (WHIT-115): the most recent repayment derived from the
# up-homeloan transaction history. Reuse the lambda_api integration; the /*/*
# invoke permission already covers it, so no new integration or permission.
resource "aws_apigatewayv2_route" "get_repayment_route" {
  api_id             = aws_apigatewayv2_api.api.id
  route_key          = "GET /repayment"
  target             = "integrations/${aws_apigatewayv2_integration.get_transactions_integration.id}"
  authorization_type = "JWT"
  authorizer_id      = aws_apigatewayv2_authorizer.jwt.id
}

# Loan facts: read (GET /loanfacts) + save (PUT /loanfacts) the user-entered
# home-loan inputs. Reuse the lambda_api integration; the /*/* invoke permission
# already covers these, so no new integration or lambda permission is needed.
resource "aws_apigatewayv2_route" "get_loanfacts_route" {
  api_id             = aws_apigatewayv2_api.api.id
  route_key          = "GET /loanfacts"
  target             = "integrations/${aws_apigatewayv2_integration.get_transactions_integration.id}"
  authorization_type = "JWT"
  authorizer_id      = aws_apigatewayv2_authorizer.jwt.id
}

resource "aws_apigatewayv2_route" "put_loanfacts_route" {
  api_id             = aws_apigatewayv2_api.api.id
  route_key          = "PUT /loanfacts"
  target             = "integrations/${aws_apigatewayv2_integration.get_transactions_integration.id}"
  authorization_type = "JWT"
  authorizer_id      = aws_apigatewayv2_authorizer.jwt.id
}

# Pay cycle: read current (GET /paycycle) + set length + last pay date (PUT
# /paycycle). Reuse the lambda_api integration; the /*/* invoke permission
# already covers these, so no new integration or lambda permission is needed.
resource "aws_apigatewayv2_route" "get_paycycle_route" {
  api_id             = aws_apigatewayv2_api.api.id
  route_key          = "GET /paycycle"
  target             = "integrations/${aws_apigatewayv2_integration.get_transactions_integration.id}"
  authorization_type = "JWT"
  authorizer_id      = aws_apigatewayv2_authorizer.jwt.id
}

resource "aws_apigatewayv2_route" "put_paycycle_route" {
  api_id             = aws_apigatewayv2_api.api.id
  route_key          = "PUT /paycycle"
  target             = "integrations/${aws_apigatewayv2_integration.get_transactions_integration.id}"
  authorization_type = "JWT"
  authorizer_id      = aws_apigatewayv2_authorizer.jwt.id
}

resource "aws_lambda_permission" "get_transactions_invoke_permission" {
  statement_id  = "AllowAPIGatewayInvokeGetTransactions"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.lambda_api.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.api.execution_arn}/*/*"
}

# Shared-secret authorizer (WHIT-52/WHIT-110). AS OF WHIT-162 it guards NO route —
# every app route now uses the Cognito JWT authorizer below. It is KEPT here,
# orphaned-but-present, ONLY as the instant rollback path: a one-block `git revert`
# of the route `authorizer_id`s + `terraform apply` restores shared-secret auth
# without recreating this resource. It is torn down in the WHIT-162 follow-up
# (PR-B) once JWT auth is verified end-to-end on-device.
resource "aws_apigatewayv2_authorizer" "authorizer" {
  api_id                            = aws_apigatewayv2_api.api.id
  authorizer_type                   = "REQUEST"
  authorizer_uri                    = aws_lambda_function.authorizer.invoke_arn
  identity_sources                  = ["$request.header.Authorization"]
  name                              = "${var.project_name}-api-authorizer"
  authorizer_payload_format_version = "2.0"
  enable_simple_responses           = true
}

# Renamed from "enrichments" -> "authorizer" when WHIT-110 extended this authorizer
# from just /enrichments to every app route. `moved` makes `terraform apply` treat it
# as a state rename, NOT a destroy+recreate of the live authorizer (which would briefly
# drop auth on every route). The `name` change ("-enrichments-authorizer" ->
# "-api-authorizer") is an in-place UpdateAuthorizer, not a replacement.
moved {
  from = aws_apigatewayv2_authorizer.enrichments
  to   = aws_apigatewayv2_authorizer.authorizer
}

resource "aws_lambda_permission" "authorizer_invoke_permission" {
  statement_id  = "AllowAPIGatewayInvokeAuthorizer"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.authorizer.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.api.execution_arn}/authorizers/${aws_apigatewayv2_authorizer.authorizer.id}"
}

# Native Cognito JWT authorizer (WHIT-97; attached to every app route by WHIT-162).
# API Gateway validates the Bearer token natively — no aws_lambda_permission needed.
#
# `audience` = the app client id, which matches Cognito ID tokens (whose `aud`
# claim is the client id). Cognito ACCESS tokens carry `client_id` instead of
# `aud` and would be rejected — so the client sends the ID token
# (src/auth.ts getAuthToken). Combined with the Pre-Sign-Up allowlist (cognito.tf
# lambda_config), only an allowlisted user's ID token authorizes these routes.
resource "aws_apigatewayv2_authorizer" "jwt" {
  api_id           = aws_apigatewayv2_api.api.id
  authorizer_type  = "JWT"
  identity_sources = ["$request.header.Authorization"]
  name             = "${var.project_name}-jwt-authorizer"

  jwt_configuration {
    audience = [aws_cognito_user_pool_client.app.id]
    issuer   = local.cognito_issuer_url
  }
}

# Enrichments (BankSync categorisation rules): list/create/delete. Reuse the
# lambda_api integration (its /*/* invoke permission already covers these), gated
# behind the Cognito JWT authorizer like every other app route.
resource "aws_apigatewayv2_route" "get_enrichments_route" {
  api_id             = aws_apigatewayv2_api.api.id
  route_key          = "GET /enrichments"
  target             = "integrations/${aws_apigatewayv2_integration.get_transactions_integration.id}"
  authorization_type = "JWT"
  authorizer_id      = aws_apigatewayv2_authorizer.jwt.id
}

resource "aws_apigatewayv2_route" "post_enrichment_route" {
  api_id             = aws_apigatewayv2_api.api.id
  route_key          = "POST /enrichments"
  target             = "integrations/${aws_apigatewayv2_integration.get_transactions_integration.id}"
  authorization_type = "JWT"
  authorizer_id      = aws_apigatewayv2_authorizer.jwt.id
}

resource "aws_apigatewayv2_route" "put_enrichment_route" {
  api_id             = aws_apigatewayv2_api.api.id
  route_key          = "PUT /enrichments/{id}"
  target             = "integrations/${aws_apigatewayv2_integration.get_transactions_integration.id}"
  authorization_type = "JWT"
  authorizer_id      = aws_apigatewayv2_authorizer.jwt.id
}

resource "aws_apigatewayv2_route" "delete_enrichment_route" {
  api_id             = aws_apigatewayv2_api.api.id
  route_key          = "DELETE /enrichments/{id}"
  target             = "integrations/${aws_apigatewayv2_integration.get_transactions_integration.id}"
  authorization_type = "JWT"
  authorizer_id      = aws_apigatewayv2_authorizer.jwt.id
}

# Device push-token registration (POST /devices). Reuse the lambda_api
# integration (its /*/* invoke permission already covers it), gated behind the
# Cognito JWT authorizer like every other app route.
resource "aws_apigatewayv2_route" "post_device_route" {
  api_id             = aws_apigatewayv2_api.api.id
  route_key          = "POST /devices"
  target             = "integrations/${aws_apigatewayv2_integration.get_transactions_integration.id}"
  authorization_type = "JWT"
  authorizer_id      = aws_apigatewayv2_authorizer.jwt.id
}

# AI spending insights (WHIT-104): GET reads the per-cycle cache, POST generates
# (the paid Anthropic call). Reuse the lambda_api integration; gated behind the
# Cognito JWT authorizer like every app route (a call also costs money).
resource "aws_apigatewayv2_route" "get_insights_ai_route" {
  api_id             = aws_apigatewayv2_api.api.id
  route_key          = "GET /insights/ai"
  target             = "integrations/${aws_apigatewayv2_integration.get_transactions_integration.id}"
  authorization_type = "JWT"
  authorizer_id      = aws_apigatewayv2_authorizer.jwt.id
}

resource "aws_apigatewayv2_route" "post_insights_ai_route" {
  api_id             = aws_apigatewayv2_api.api.id
  route_key          = "POST /insights/ai"
  target             = "integrations/${aws_apigatewayv2_integration.get_transactions_integration.id}"
  authorization_type = "JWT"
  authorizer_id      = aws_apigatewayv2_authorizer.jwt.id
}

# banksync webhook endpoint used by banksync to push transaction data
resource "aws_apigatewayv2_integration" "banksync_webhook_integration" {
  api_id                 = aws_apigatewayv2_api.api.id
  integration_type       = "AWS_PROXY"
  integration_uri        = aws_lambda_function.lambda.invoke_arn
  payload_format_version = "2.0"
}

resource "aws_apigatewayv2_route" "banksync_webhook_route" {
  api_id    = aws_apigatewayv2_api.api.id
  route_key = "POST /webhook/banksync"
  target    = "integrations/${aws_apigatewayv2_integration.banksync_webhook_integration.id}"
}

resource "aws_lambda_permission" "api_invoke_lambda" {
  statement_id  = "AllowAPIGatewayInvokeBankSync"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.lambda.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.api.execution_arn}/*/*"
}
