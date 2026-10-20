# Live, $0 deployment of the static demo: private S3 bucket behind CloudFront.
# Separate root module + state from ../ (the full ECS/RDS design), so they can't affect each other.
terraform {
  required_version = ">= 1.6"
  required_providers {
    aws = { source = "hashicorp/aws", version = "~> 6.0" }
  }
}

provider "aws" {
  region = "eu-north-1" # single-Region project; CloudFront itself is global
  default_tags {
    tags = { Project = "mini-loan-saas", Environment = "demo", ManagedBy = "terraform" }
  }
}

variable "github_repo" {
  type    = string
  default = "sja-thedude/mini-loan-management-saas"
}

data "aws_caller_identity" "current" {}
locals { name = "loan-demo" }
