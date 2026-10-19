resource "aws_s3_bucket" "documents" {
  bucket        = "${local.prefix}-documents"
  force_destroy = var.force_destroy
}

resource "aws_s3_bucket_public_access_block" "documents" {
  bucket                  = aws_s3_bucket.documents.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

# SSE-KMS with the CMK: reading an object needs s3:GetObject AND kms:Decrypt on the key.
resource "aws_s3_bucket_server_side_encryption_configuration" "documents" {
  bucket = aws_s3_bucket.documents.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm     = "aws:kms"
      kms_master_key_id = aws_kms_key.app.arn
    }
    bucket_key_enabled = true # fewer KMS calls -> lower KMS request cost on real AWS
  }
}

resource "aws_s3_bucket_cors_configuration" "documents" {
  bucket = aws_s3_bucket.documents.id
  cors_rule {
    allowed_methods = ["POST", "GET"]
    allowed_origins = var.documents_cors_origins
    allowed_headers = ["*"]
    max_age_seconds = 300
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "documents" {
  bucket = aws_s3_bucket.documents.id
  rule {
    id     = "abort-incomplete-uploads"
    status = "Enabled"
    filter {}
    abort_incomplete_multipart_upload { days_after_initiation = 1 }
  }
}

# Idempotent notification log written by the worker. Partition by tenant so a tenant's
# records are one Query away and never mixed with another tenant's.
resource "aws_dynamodb_table" "notifications" {
  name         = "${local.prefix}-notifications"
  billing_mode = "PAY_PER_REQUEST" # always-free tier on real AWS: 25 GB storage
  hash_key     = "tenantId"
  range_key    = "eventId"

  attribute {
    name = "tenantId"
    type = "S"
  }
  attribute {
    name = "eventId"
    type = "S"
  }

  ttl {
    attribute_name = "expiresAt"
    enabled        = true
  }

  point_in_time_recovery { enabled = true }

  server_side_encryption {
    enabled     = true
    kms_key_arn = aws_kms_key.app.arn
  }
}
