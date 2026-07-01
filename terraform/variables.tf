variable "aws_region" {
  description = "AWS region to deploy into"
  type        = string
  default     = "ap-southeast-2"
}

variable "project_name" {
  description = "Prefix used for naming all resources"
  type        = string
  default     = "whittle"
}

# Cadence for the self-hosted BankSync sync. Default is hourly (24x/day) to keep
# transactions fresh, bypassing BankSync's daily UI cap. Assumes no per-call rate
# quota beyond that cap. Accepts any EventBridge Scheduler expression, e.g.
# "rate(6 hours)" or "cron(0 */3 * * ? *)".
variable "sync_schedule_expression" {
  description = "EventBridge Scheduler expression controlling how often BankSync feeds are synced"
  type        = string
  default     = "rate(1 hour)"
}
