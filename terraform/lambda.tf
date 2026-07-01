data "archive_file" "lambda_zip" {
  depends_on  = [null_resource.copy_shared]
  type        = "zip"
  source_dir  = "${path.module}/../lambda"
  output_path = "${path.module}/artifacts/lambda.zip"
}

data "archive_file" "lambda_api_zip" {
  depends_on  = [null_resource.copy_shared]
  type        = "zip"
  source_dir  = "${path.module}/../lambda_api"
  output_path = "${path.module}/artifacts/lambda_api.zip"
}

resource "null_resource" "copy_shared" {
  triggers = {
    shared_hash = sha256(join("", [for f in fileset("${path.module}/../shared", "**") : filesha256("${path.module}/../shared/${f}")]))
  }

  provisioner "local-exec" {
    command = "cp ${path.module}/../shared/* ${path.module}/../lambda/ && cp ${path.module}/../shared/* ${path.module}/../lambda_api/"
  }
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

  logging_config {
    log_format = "Text"
    log_group  = aws_cloudwatch_log_group.lambda.name
  }

}

resource "aws_lambda_function" "lambda_api" {
  function_name    = "${var.project_name}-lambda-api"
  role             = aws_iam_role.lambda_exec.arn
  handler          = "handler.lambda_handler"
  runtime          = "python3.12"
  timeout          = 60
  memory_size      = 128
  filename         = data.archive_file.lambda_api_zip.output_path
  source_code_hash = data.archive_file.lambda_api_zip.output_base64sha256

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
