# Bootstrap module — run ONCE, by hand, from a laptop (see terraform/DEPLOY.md).
#
# It creates the things GitHub Actions needs before it can deploy the main stack:
# the remote-state bucket + lock table, the GitHub<->AWS OIDC trust, and the two
# CI roles. It deliberately keeps its OWN state LOCAL: it builds the very bucket a
# remote backend would live in, so it can't store its state there without a
# chicken-and-egg. This state is tiny (a bucket, a table, an OIDC provider, two
# roles) and re-importable if lost — the durability caveat is in DEPLOY.md.
terraform {
  required_version = ">= 1.5"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0"
    }
  }
}

provider "aws" {
  region = var.aws_region

  # Match the main module's tagging so bootstrap resources group under the same App.
  default_tags {
    tags = {
      App = var.project_name
    }
  }
}

data "aws_caller_identity" "current" {}
