# Customer managed key (CMK). Used for: S3 SSE-KMS on documents, field-level encryption of
# customer PII (with tenant-bound encryption context), SQS/SNS/DynamoDB encryption at rest.
resource "aws_kms_key" "app" {
  description             = "${local.prefix} data key"
  enable_key_rotation     = true # automatic yearly rotation of the backing key material
  deletion_window_in_days = 7
}

resource "aws_kms_alias" "app" {
  name          = "alias/${local.prefix}"
  target_key_id = aws_kms_key.app.key_id
}
