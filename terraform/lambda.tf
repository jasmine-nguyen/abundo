data "archive_file" "lambda_zip" {
  type        = "zip"
  source_dir  = "${path.module}/../lambda"
  output_path = "${path.module}/artifacts/lambda.zip"
}

data "archive_file" "lambda_api_zip" {
  type        = "zip"
  source_dir  = "${path.module}/../lambda_api"
  output_path = "${path.module}/artifacts/lambda_api.zip"
}

resource "aws_lambda_function" "lambda" {
  function_name    = "${var.project_name}-lambda"
  role             = aws_iam_role.lambda_exec.arn
  handler          = "handler.lambda_handler"
  runtime          = "python3.12"
  timeout          = 60
  memory_size      = 128
  filename         = data.archive_file.lambda_zip.output_path
  source_code_hash = data.archive_file.lambda_zip.output_base64sha256
  layers           = [aws_lambda_layer_version.shared.arn]

  environment {
    variables = {
      TABLE_NAME = aws_dynamodb_table.dynamodb_table.name
    }
  }

  logging_config {
    log_format = "Text"
    log_group  = aws_cloudwatch_log_group.lambda.name
  }
}

resource "aws_lambda_function" "lambda_api" {
  function_name    = "${var.project_name}-lambda-api"
  role             = aws_iam_role.lambda_api_exec.arn
  handler          = "handler.lambda_handler"
  runtime          = "python3.12"
  timeout          = 60
  memory_size      = 128
  filename         = data.archive_file.lambda_api_zip.output_path
  source_code_hash = data.archive_file.lambda_api_zip.output_base64sha256
  layers           = [aws_lambda_layer_version.shared.arn]

  environment {
    variables = {
      TABLE_NAME = aws_dynamodb_table.dynamodb_table.name
    }
  }

  logging_config {
    log_format = "Text"
    log_group  = aws_cloudwatch_log_group.lambda_api.name
  }
}

resource "aws_cloudwatch_log_group" "lambda" {
  name              = "/aws/lambda/${var.project_name}-lambda"
  retention_in_days = 30
}

resource "aws_cloudwatch_log_group" "lambda_api" {
  name              = "/aws/lambda/${var.project_name}-lambda-api"
  retention_in_days = 30
}
