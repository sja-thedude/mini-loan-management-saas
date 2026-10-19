# Reusable module: the event-driven + security services of the loan platform.
# Used by infra/local (against the AWS emulator) and by infra/ (real AWS production design),
# so dev and prod are provisioned from the SAME definitions.
terraform {
  required_providers {
    aws    = { source = "hashicorp/aws", version = "~> 6.0" }
    random = { source = "hashicorp/random", version = "~> 3.6" }
  }
}

variable "name" {
  type    = string
  default = "loan-app"
}

variable "env" {
  description = "Environment name, e.g. local, staging, prod"
  type        = string
}

variable "documents_cors_origins" {
  description = "Browser origins allowed to upload documents directly to S3 (presigned POST)"
  type        = list(string)
}

variable "notification_sender" {
  type    = string
  default = "no-reply@loan-app.example"
}

variable "high_value_threshold_cents" {
  type    = string
  default = "5000000"
}

variable "force_destroy" {
  description = "Allow destroying non-empty buckets (true for dev/learning only)"
  type        = bool
  default     = false
}

data "aws_region" "current" {}

locals {
  name   = var.name
  prefix = "${var.name}-${var.env}"
  region = data.aws_region.current.region
}
