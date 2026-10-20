# Customer managed key (CMK). Used for: S3 SSE-KMS on documents, field-level encryption of
# customer PII (with tenant-bound encryption context), SQS/SNS/DynamoDB encryption at rest.
resource "aws_kms_key" "app" {
  description             = "${local.prefix} data key"
  enable_key_rotation     = true # automatic yearly rotation of the backing key material
  deletion_window_in_days = 7
  policy                  = data.aws_iam_policy_document.kms.json
}

data "aws_caller_identity" "current" {}

data "aws_iam_policy_document" "kms" {
  # Delegate to IAM: identity policies in this account decide who may use the key.
  statement {
    sid       = "AccountAdministersViaIam"
    actions   = ["kms:*"]
    resources = ["*"]
    principals {
      type        = "AWS"
      identifiers = ["arn:aws:iam::${data.aws_caller_identity.current.account_id}:root"]
    }
  }
  # CloudWatch alarms publish to the KMS-encrypted SNS topic; the service needs the key for that.
  statement {
    sid       = "CloudWatchAlarmsToEncryptedTopic"
    actions   = ["kms:Decrypt", "kms:GenerateDataKey*"]
    resources = ["*"]
    principals {
      type        = "Service"
      identifiers = ["cloudwatch.amazonaws.com"]
    }
  }
}

resource "aws_kms_alias" "app" {
  name          = "alias/${local.prefix}"
  target_key_id = aws_kms_key.app.key_id
}
