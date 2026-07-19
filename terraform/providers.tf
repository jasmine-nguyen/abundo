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
