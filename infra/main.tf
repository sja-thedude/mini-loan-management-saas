terraform {
  required_version = ">= 1.6"
  required_providers {
    aws     = { source = "hashicorp/aws", version = "~> 6.0" }
    random  = { source = "hashicorp/random", version = "~> 3.6" }
    archive = { source = "hashicorp/archive", version = "~> 2.7" }
  }
  # Learning project: state is local (and gitignored). It CONTAINS SECRETS (generated
  # passwords). Production: S3 backend with encryption + state locking.
}

provider "aws" {
  region = var.region
  default_tags {
    tags = { Project = "mini-loan-saas", Environment = "learning", ManagedBy = "terraform" }
  }
}

data "aws_availability_zones" "available" { state = "available" }
data "aws_caller_identity" "current" {}

locals {
  name = "loan-app"
  azs  = slice(data.aws_availability_zones.available.names, 0, 2)
}
