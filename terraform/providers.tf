terraform {
  required_version = ">= 1.5"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0"
    }
  }

  # Remote state in S3, locked via DynamoDB (both created by terraform/bootstrap/).
  # `bucket` carries an account-id suffix and a backend block takes no interpolation,
  # so it's supplied at init via -backend-config (GitHub Variable TF_STATE_BUCKET =
  # bootstrap output state_bucket_name); see .github/workflows/deploy.yml and
  # DEPLOY.md. key/region/lock table have no account-specific part, so they're
  # literals here. key MUST equal bootstrap local.state_key — the CI state policy is
  # scoped to exactly this object.
  backend "s3" {
    key            = "abundo/terraform.tfstate"
    region         = "ap-southeast-2"
    dynamodb_table = "abundo-tfstate-lock"
    encrypt        = true
  }
}

provider "aws" {
  region = var.aws_region

  # Stamp every managed resource with App=<project_name> (e.g. "abundo") so all of
  # this app's resources can be filtered and grouped in one place — Resource Groups
  # (see aws_resourcegroups_group.app in resource_groups.tf), Tag Editor, and cost
  # allocation. Purely additive labels: applying this only ADDS a tag, it never
  # renames or recreates a resource. A future second app gets its own project_name,
  # so each app's resources carry a distinct App tag.
  default_tags {
    tags = {
      App = var.project_name
    }
  }
}
