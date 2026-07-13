# A tag-based Resource Group so the whole app shows up as one "folder" in the AWS
# console (Resource Groups section) — every resource carrying App=<project_name>,
# across all services (Lambdas, DynamoDB, IAM, EventBridge, log groups), in one view.
# The App tag is applied to everything by default_tags in providers.tf. A future
# second app, deployed with its own project_name, forms its own separate group.

resource "aws_resourcegroups_group" "app" {
  name        = var.project_name
  # AWS Resource Groups descriptions allow only [\s a-zA-Z0-9 _ . -] — no commas.
  description = "All ${var.project_name} resources grouped by the App tag."

  resource_query {
    query = jsonencode({
      ResourceTypeFilters = ["AWS::AllSupported"]
      TagFilters = [{
        Key    = "App"
        Values = [var.project_name]
      }]
    })
  }
}
