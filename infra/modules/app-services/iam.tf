# Least-privilege identities for the two workloads. The emulator doesn't ENFORCE IAM, but the
# policies are real and are checked with IAM Access Analyzer policy validation (see docs).
data "aws_iam_policy_document" "assume_ecs_task" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ecs-tasks.amazonaws.com"]
    }
  }
}

data "aws_iam_policy_document" "assume_lambda" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
  }
}

data "aws_iam_policy_document" "api" {
  statement {
    sid       = "DocumentsUnderTenantPrefix"
    actions   = ["s3:PutObject", "s3:GetObject"]
    resources = ["${aws_s3_bucket.documents.arn}/tenants/*"]
  }
  statement {
    sid       = "PiiEncryptAndSseKms"
    actions   = ["kms:Encrypt", "kms:Decrypt", "kms:GenerateDataKey"]
    resources = [aws_kms_key.app.arn]
  }
  statement {
    sid       = "PublishDomainEvents"
    actions   = ["events:PutEvents"]
    resources = [aws_cloudwatch_event_bus.loans.arn]
  }
  statement {
    sid       = "ReadConfig"
    actions   = ["ssm:GetParameter", "ssm:GetParametersByPath"]
    resources = ["arn:aws:ssm:${local.region}:*:parameter/${local.name}/${var.env}/*"]
  }
  statement {
    sid       = "ReadJwtSecret"
    actions   = ["secretsmanager:GetSecretValue"]
    resources = [aws_secretsmanager_secret.jwt.arn]
  }
  statement {
    sid       = "PublishMetrics"
    actions   = ["cloudwatch:PutMetricData"]
    resources = ["*"] # PutMetricData has no resource-level permissions...
    condition {       # ...so scope it with the namespace condition key instead
      test     = "StringEquals"
      variable = "cloudwatch:namespace"
      values   = ["LoanApp"]
    }
  }
}

data "aws_iam_policy_document" "worker" {
  statement {
    sid       = "ConsumeLoanEvents"
    actions   = ["sqs:ReceiveMessage", "sqs:DeleteMessage", "sqs:GetQueueAttributes", "sqs:ChangeMessageVisibility"]
    resources = [aws_sqs_queue.events.arn]
  }
  statement {
    sid       = "IdempotentNotificationLog"
    actions   = ["dynamodb:PutItem", "dynamodb:UpdateItem", "dynamodb:GetItem", "dynamodb:Query"]
    resources = [aws_dynamodb_table.notifications.arn]
  }
  statement {
    sid       = "SendEmail"
    actions   = ["ses:SendEmail"]
    resources = ["*"]
    condition {
      test     = "StringEquals"
      variable = "ses:FromAddress"
      values   = [aws_ses_email_identity.sender.email]
    }
  }
  statement {
    sid       = "OpsAlerts"
    actions   = ["sns:Publish"]
    resources = [aws_sns_topic.ops_alerts.arn]
  }
  statement {
    sid       = "KmsForEncryptedResources"
    actions   = ["kms:Decrypt", "kms:GenerateDataKey"]
    resources = [aws_kms_key.app.arn]
  }
  statement {
    sid       = "ReadConfig"
    actions   = ["ssm:GetParameter"]
    resources = ["arn:aws:ssm:${local.region}:*:parameter/${local.name}/${var.env}/*"]
  }
  statement {
    sid       = "Logs"
    actions   = ["logs:CreateLogStream", "logs:PutLogEvents"]
    resources = ["${aws_cloudwatch_log_group.worker.arn}:*"]
  }
}

resource "aws_iam_role" "api" {
  name               = "${local.prefix}-api-task"
  assume_role_policy = data.aws_iam_policy_document.assume_ecs_task.json
}

resource "aws_iam_role_policy" "api" {
  name   = "api"
  role   = aws_iam_role.api.id
  policy = data.aws_iam_policy_document.api.json
}

resource "aws_iam_role" "worker" {
  name               = "${local.prefix}-worker"
  assume_role_policy = data.aws_iam_policy_document.assume_lambda.json
}

resource "aws_iam_role_policy" "worker" {
  name   = "worker"
  role   = aws_iam_role.worker.id
  policy = data.aws_iam_policy_document.worker.json
}

