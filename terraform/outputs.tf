output "abundo_api_url" {
  value = aws_apigatewayv2_api.api.api_endpoint
}

# Cognito auth (WHIT-97) — consumed by the client OAuth login card (WHIT-160).
output "cognito_user_pool_id" {
  value = aws_cognito_user_pool.pool.id
}

output "cognito_app_client_id" {
  value = aws_cognito_user_pool_client.app.id
}

output "cognito_hosted_ui_domain" {
  value = "https://${aws_cognito_user_pool_domain.hosted_ui.domain}.auth.${var.aws_region}.amazoncognito.com"
}

output "cognito_issuer_url" {
  value = local.cognito_issuer_url
}
