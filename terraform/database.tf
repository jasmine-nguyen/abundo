resource "aws_dynamodb_table" "dynamodb_table" {
  name         = "${var.project_name}-dynamodb-table"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "pk"
  range_key    = "sk"

  attribute {
    name = "pk"
    type = "S"
  }

  attribute {
    name = "sk"
    type = "S"
  }

  attribute {
    name = "transaction_id"
    type = "S"
  }

  global_secondary_index {
    name = "transaction-id-index"
    key_schema {
      attribute_name = "transaction_id"
      key_type       = "HASH"
    }
    projection_type = "KEYS_ONLY"
  }
}
