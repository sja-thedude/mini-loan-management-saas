# Event-driven + security services for the app, provisioned against the LOCAL AWS emulator
# (moto on localhost:4566). The same resource definitions target real AWS by removing the
# endpoint overrides. Nothing here touches the real AWS account.
terraform {
  required_version = ">= 1.6"
  required_providers {
    aws    = { source = "hashicorp/aws", version = "~> 6.0" }
    random = { source = "hashicorp/random", version = "~> 3.6" }
  }
}

variable "endpoint" {
  type    = string
  default = "http://localhost:4566"
}

variable "env" {
  type    = string
  default = "local"
}

provider "aws" {
  region                      = "us-east-1"
  access_key                  = "test" # emulator only; never real credentials
  secret_key                  = "test"
  skip_credentials_validation = true
  skip_metadata_api_check     = true
  skip_requesting_account_id  = true
  s3_use_path_style           = true
  endpoints {
    s3             = var.endpoint
    sqs            = var.endpoint
    sns            = var.endpoint
    ses            = var.endpoint
    events         = var.endpoint
    kms            = var.endpoint
    ssm            = var.endpoint
    secretsmanager = var.endpoint
    dynamodb       = var.endpoint
    cloudwatch     = var.endpoint
    logs           = var.endpoint
    iam            = var.endpoint
    sts            = var.endpoint
  }
}

module "app" {
  source                 = "../modules/app-services"
  env                    = var.env
  documents_cors_origins = ["http://localhost:3001"]
  force_destroy          = true
}
