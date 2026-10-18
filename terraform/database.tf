resource "aws_dynamodb_table" "dynamodb_table" {
  name         = "${var.project_name}-dynamodb-table"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "pk"
  range_key    = "sk"

  # Auto-expire rows via their epoch-seconds `expires_at`: FAILED# dead-letter
  # rows (WHIT-54), EVENT# webhook dedup markers (ABU-46), jobs, push receipts
  # and notify markers. Only items that carry the attribute are ever expired —
  # all other rows are untouched.
  ttl {
    attribute_name = "expires_at"
    enabled        = true
  }

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
    projection_type = "ALL"
  }
}
