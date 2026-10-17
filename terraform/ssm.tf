# The SecureString secrets the lambdas read. Their values are set by hand in the
# console or CLI. Terraform no longer manages these parameters (ABU-93): a managed
# parameter's real value is written into the state file on every refresh, and the PR
# preview login can read that file. The `removed` blocks drop them from state without
# deleting them in AWS; iam.tf grants access by the ARNs below.
#
# banksync-webhook-secret: verifies BankSync webhook deliveries.
# banksync-api-key: the sync-trigger lambda calls POST /v1/feeds/{id}/sync with it.
# anthropic-api-key: lambda_api calls the Messages API for AI insights and chat (WHIT-104).
# expo-access-token: an Expo PAT; the push sender (shared/push.py) sends it as a Bearer
#   token because the project has Enhanced Security for Push Notifications on.
# up-personal-access-token: the up-webhook lambda fetches the full transaction with it (WHIT-313).
# up-webhook-signing-secret: the secretKey Up returns at webhook registration, used to
#   verify each delivery's HMAC signature.
locals {
  ssm_parameter_arn_prefix = "arn:aws:ssm:${var.aws_region}:${data.aws_caller_identity.current.account_id}:parameter/${var.project_name}"

  banksync_webhook_secret_arn   = "${local.ssm_parameter_arn_prefix}/banksync-webhook-secret"
  banksync_api_key_arn          = "${local.ssm_parameter_arn_prefix}/banksync-api-key"
  anthropic_api_key_arn         = "${local.ssm_parameter_arn_prefix}/anthropic-api-key"
  expo_access_token_arn         = "${local.ssm_parameter_arn_prefix}/expo-access-token"
  up_personal_access_token_arn  = "${local.ssm_parameter_arn_prefix}/up-personal-access-token"
  up_webhook_signing_secret_arn = "${local.ssm_parameter_arn_prefix}/up-webhook-signing-secret"
}

removed {
  from = aws_ssm_parameter.banksync_webhook_secret
  lifecycle {
    destroy = false
  }
}

removed {
  from = aws_ssm_parameter.banksync_api_key
  lifecycle {
    destroy = false
  }
}

removed {
  from = aws_ssm_parameter.anthropic_api_key
  lifecycle {
    destroy = false
  }
}

removed {
  from = aws_ssm_parameter.expo_access_token
  lifecycle {
    destroy = false
  }
}

removed {
  from = aws_ssm_parameter.up_personal_access_token
  lifecycle {
    destroy = false
  }
}

removed {
  from = aws_ssm_parameter.up_webhook_signing_secret
  lifecycle {
    destroy = false
  }
}
