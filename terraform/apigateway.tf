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
  api_id    = aws_apigatewayv2_api.api.id
  route_key = "GET /transactions"
  target    = "integrations/${aws_apigatewayv2_integration.get_transactions_integration.id}"
}

# PATCH a single transaction's category; reuses the lambda_api integration.
# No new lambda permission needed: get_transactions_invoke_permission already
# grants apigateway invoke over ${execution_arn}/*/* (any method + route).
resource "aws_apigatewayv2_route" "patch_transaction_category_route" {
  api_id    = aws_apigatewayv2_api.api.id
  route_key = "PATCH /transactions/{id}"
  target    = "integrations/${aws_apigatewayv2_integration.get_transactions_integration.id}"
}

resource "aws_lambda_permission" "get_transactions_invoke_permission" {
  statement_id  = "AllowAPIGatewayInvokeGetTransactions"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.lambda_api.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.api.execution_arn}/*/*"
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
