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

# Every authenticated app route shares one shape: the lambda_api integration
# (get_transactions_integration) + the Cognito JWT authorizer, differing only by
# route_key. Collapsed from 23 near-identical resources into a single for_each
# (WHIT-153). No new aws_lambda_permission is needed for any of these —
# get_transactions_invoke_permission grants apigateway invoke over
# ${execution_arn}/*/* (any method + route), so adding a route_key here needs no new
# permission or integration.
#
# NOTE: "POST /webhook/banksync" is deliberately NOT in this set — it targets the
# banksync_webhook_integration and is public (no authorizer). It stays a standalone
# resource at the bottom of this file.
locals {
  app_route_keys = toset([
    "GET /transactions",
    "GET /transactions/range",
    "PATCH /transactions/{id}",
    "PATCH /transactions",
    "GET /categories",
    "POST /categories",
    "PATCH /categories/{id}",
    "DELETE /categories/{id}",
    "GET /budgets",
    "PUT /budgets/{category}",
    "GET /breakdown",
    "GET /homeloan",
    "GET /accounts/balances",
    "GET /repayment",
    "GET /loanfacts",
    "PUT /loanfacts",
    "GET /paycycle",
    "PUT /paycycle",
    "GET /enrichments",
    "POST /enrichments",
    "PUT /enrichments/{id}",
    "DELETE /enrichments/{id}",
    "POST /devices",
    "GET /insights/ai",
    "POST /insights/ai",
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

# WHIT-153: collapsed 23 identical routes into aws_apigatewayv2_route.app (for_each).
# Without these moved{} blocks terraform would DESTROY+RECREATE every route, briefly
# dropping every API route on live infra. moved{} makes it a pure state rename — the
# plan shows only moves (0 add / 0 change / 0 destroy). Same pattern as the authorizer
# moved{} below. These can be garbage-collected in a later card once the rename is
# applied and confirmed.
moved {
  from = aws_apigatewayv2_route.get_transactions_route
  to   = aws_apigatewayv2_route.app["GET /transactions"]
}
moved {
  from = aws_apigatewayv2_route.patch_transaction_category_route
  to   = aws_apigatewayv2_route.app["PATCH /transactions/{id}"]
}
moved {
  from = aws_apigatewayv2_route.patch_transactions_batch_route
  to   = aws_apigatewayv2_route.app["PATCH /transactions"]
}
moved {
  from = aws_apigatewayv2_route.get_categories_route
  to   = aws_apigatewayv2_route.app["GET /categories"]
}
moved {
  from = aws_apigatewayv2_route.post_category_route
  to   = aws_apigatewayv2_route.app["POST /categories"]
}
moved {
  from = aws_apigatewayv2_route.patch_category_route
  to   = aws_apigatewayv2_route.app["PATCH /categories/{id}"]
}
moved {
  from = aws_apigatewayv2_route.delete_category_route
  to   = aws_apigatewayv2_route.app["DELETE /categories/{id}"]
}
moved {
  from = aws_apigatewayv2_route.get_budgets_route
  to   = aws_apigatewayv2_route.app["GET /budgets"]
}
moved {
  from = aws_apigatewayv2_route.put_budget_route
  to   = aws_apigatewayv2_route.app["PUT /budgets/{category}"]
}
moved {
  from = aws_apigatewayv2_route.get_breakdown_route
  to   = aws_apigatewayv2_route.app["GET /breakdown"]
}
moved {
  from = aws_apigatewayv2_route.get_homeloan_route
  to   = aws_apigatewayv2_route.app["GET /homeloan"]
}
moved {
  from = aws_apigatewayv2_route.get_repayment_route
  to   = aws_apigatewayv2_route.app["GET /repayment"]
}
moved {
  from = aws_apigatewayv2_route.get_loanfacts_route
  to   = aws_apigatewayv2_route.app["GET /loanfacts"]
}
moved {
  from = aws_apigatewayv2_route.put_loanfacts_route
  to   = aws_apigatewayv2_route.app["PUT /loanfacts"]
}
moved {
  from = aws_apigatewayv2_route.get_paycycle_route
  to   = aws_apigatewayv2_route.app["GET /paycycle"]
}
moved {
  from = aws_apigatewayv2_route.put_paycycle_route
  to   = aws_apigatewayv2_route.app["PUT /paycycle"]
}
moved {
  from = aws_apigatewayv2_route.get_enrichments_route
  to   = aws_apigatewayv2_route.app["GET /enrichments"]
}
moved {
  from = aws_apigatewayv2_route.post_enrichment_route
  to   = aws_apigatewayv2_route.app["POST /enrichments"]
}
moved {
  from = aws_apigatewayv2_route.put_enrichment_route
  to   = aws_apigatewayv2_route.app["PUT /enrichments/{id}"]
}
moved {
  from = aws_apigatewayv2_route.delete_enrichment_route
  to   = aws_apigatewayv2_route.app["DELETE /enrichments/{id}"]
}
moved {
  from = aws_apigatewayv2_route.post_device_route
  to   = aws_apigatewayv2_route.app["POST /devices"]
}
moved {
  from = aws_apigatewayv2_route.get_insights_ai_route
  to   = aws_apigatewayv2_route.app["GET /insights/ai"]
}
moved {
  from = aws_apigatewayv2_route.post_insights_ai_route
  to   = aws_apigatewayv2_route.app["POST /insights/ai"]
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
