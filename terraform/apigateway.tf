resource "aws_apigatewayv2_api" "api" {
  name          = "${var.project_name}-api"
  protocol_type = "HTTP"
}

resource "aws_apigatewayv2_stage" "default" {
  api_id      = aws_apigatewayv2_api.api.id
  name        = "$default"
  auto_deploy = true

  # Per-route limit (ABU-93): the webhook routes need no login, so a flood of junk
  # requests would otherwise use up the account's lambda concurrency. The banks retry on 429.
  default_route_settings {
    throttling_rate_limit  = 20
    throttling_burst_limit = 40
  }
}

# lambda api endpoint used by abundo app to retrieve data from DynamoDB
resource "aws_apigatewayv2_integration" "get_transactions_integration" {
  api_id                 = aws_apigatewayv2_api.api.id
  integration_type       = "AWS_PROXY"
  integration_uri        = aws_lambda_function.app_api.invoke_arn
  payload_format_version = "2.0"
}

# Every authenticated app route shares one shape: the lambda_api integration
# (get_transactions_integration) + the Cognito JWT authorizer, differing only by
# route_key. Collapsed from 23 near-identical resources into a single for_each
# (WHIT-153). No new aws_lambda_permission is needed for any of these —
# app_api_apigw_invoke grants apigateway invoke over
# ${execution_arn}/*/* (any method + route), so adding a route_key here needs no new
# permission or integration.
#
# NOTE: "POST /webhook/banksync" is deliberately NOT in this set — it targets the
# banksync_webhook_integration and is public (no authorizer). It stays a standalone
# resource at the bottom of this file.
locals {
  app_route_keys = toset([
    "GET /transactions",
    "GET /transactions/feed",
    "GET /transactions/uncategorized/count",
    "GET /transactions/uncategorized/feed",
    "GET /transactions/uncategorized/merchants",
    # WHIT-542: rules suggested from the user's hand-filing habits. Rides the shared app_api
    # integration + authorizer like the sibling GET routes, so no new integration is needed.
    "GET /transactions/filing-suggestions",
    # WHIT-576: search over ALL history for the Transactions tab. Same shared integration + authorizer.
    "GET /transactions/search",
    # WHIT-700: every transaction in one pay cycle, for the Insights CSV export. Same shared integration + authorizer.
    "GET /transactions/cycle",
    "POST /transactions/uncategorized/apply-rules",
    # WHIT-537: async apply-rules job — start (POST) + poll status (GET {id}). Both ride the
    # shared app_api integration + app_api_apigw_invoke permission (execution_arn/*/*), so no new
    # integration or permission is needed.
    "POST /transactions/uncategorized/apply-rules/jobs",
    "GET /transactions/uncategorized/apply-rules/jobs/{id}",
    "PATCH /transactions/{id}",
    # WHIT-654: the user deletes one charge from the transaction screen.
    "DELETE /transactions/{id}",
    "PATCH /transactions",
    "GET /categories",
    "POST /categories",
    "GET /categories/{id}/transactions",
    "PATCH /categories/{id}",
    "DELETE /categories/{id}",
    "GET /budgets",
    "GET /budgets/{category}/transactions",
    "PUT /budgets/{category}",
    "DELETE /budgets/{category}",
    "GET /breakdown",
    "GET /homeloan",
    "GET /accounts/balances",
    "POST /accounts/balances/refresh",
    "POST /transactions/sync",
    "GET /repayment",
    "GET /loanfacts",
    "PUT /loanfacts",
    "GET /milestones",
    "PUT /milestones",
    "GET /paycycle",
    "PUT /paycycle",
    "GET /goals",
    "PUT /goals/{id}",
    "DELETE /goals/{id}",
    "GET /rules",
    "POST /rules",
    "PUT /rules/{id}",
    "DELETE /rules/{id}",
    "POST /devices",
    "GET /insights/ai",
    "POST /insights/ai",
    # Card 609: Ask Abundo chat — start a background chat job (POST) + poll it (GET {id}). Same
    # shared integration + authorizer, like the apply-rules job routes.
    "POST /ai/chat",
    "GET /ai/chat/jobs/{id}",
  ])
}

resource "aws_apigatewayv2_route" "app" {
  for_each           = local.app_route_keys
  api_id             = aws_apigatewayv2_api.api.id
  route_key          = each.value
  target             = "integrations/${aws_apigatewayv2_integration.get_transactions_integration.id}"
  authorization_type = "JWT"
  authorizer_id      = aws_apigatewayv2_authorizer.jwt.id
}

resource "aws_lambda_permission" "app_api_apigw_invoke" {
  statement_id  = "AllowAPIGatewayInvokeGetTransactions"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.app_api.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.api.execution_arn}/*/*"
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

# banksync webhook endpoint used by banksync to push transaction data
resource "aws_apigatewayv2_integration" "banksync_webhook_integration" {
  api_id                 = aws_apigatewayv2_api.api.id
  integration_type       = "AWS_PROXY"
  integration_uri        = aws_lambda_function.transaction_ingest.invoke_arn
  payload_format_version = "2.0"
}

resource "aws_apigatewayv2_route" "banksync_webhook_route" {
  api_id    = aws_apigatewayv2_api.api.id
  route_key = "POST /webhook/banksync"
  target    = "integrations/${aws_apigatewayv2_integration.banksync_webhook_integration.id}"
}

resource "aws_lambda_permission" "transaction_ingest_apigw_invoke" {
  statement_id  = "AllowAPIGatewayInvokeBankSync"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.transaction_ingest.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.api.execution_arn}/*/*"
}

# Direct Up-bank webhook endpoint (WHIT-313). Public (no authorizer), like the
# banksync webhook — Up authenticates itself with the X-Up-Authenticity-Signature
# HMAC the lambda verifies. Its own integration (targets up_webhook, NOT the banksync
# integration which targets transaction_ingest).
resource "aws_apigatewayv2_integration" "up_webhook_integration" {
  api_id                 = aws_apigatewayv2_api.api.id
  integration_type       = "AWS_PROXY"
  integration_uri        = aws_lambda_function.up_webhook.invoke_arn
  payload_format_version = "2.0"
}

resource "aws_apigatewayv2_route" "up_webhook_route" {
  api_id    = aws_apigatewayv2_api.api.id
  route_key = "POST /webhook/up"
  target    = "integrations/${aws_apigatewayv2_integration.up_webhook_integration.id}"
}

resource "aws_lambda_permission" "up_webhook_apigw_invoke" {
  statement_id  = "AllowAPIGatewayInvokeUpWebhook"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.up_webhook.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.api.execution_arn}/*/*"
}
