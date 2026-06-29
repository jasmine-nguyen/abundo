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

  attribute {
    name = "account_id"
    type = "S"
  }

  attribute {
    name = "date"
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

  global_secondary_index {
    name = "date-index"
    key_schema {
      attribute_name = "account_id"
      key_type       = "HASH"
    }
    key_schema {
      attribute_name = "date"
      key_type       = "RANGE"
    }
    projection_type    = "INCLUDE"
    non_key_attributes = ["amount", "category", "transaction_id", "payee", "status"]
  }
}
