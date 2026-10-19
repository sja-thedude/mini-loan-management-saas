# Non-secret runtime config -> SSM Parameter Store (Standard tier is free).
resource "aws_ssm_parameter" "high_value_threshold" {
  name  = "/${local.name}/${var.env}/high-value-threshold-cents"
  type  = "String"
  value = var.high_value_threshold_cents # loans >= this trigger an ops alert
}

resource "aws_ssm_parameter" "notification_sender" {
  name  = "/${local.name}/${var.env}/notification-sender"
  type  = "String"
  value = aws_ses_email_identity.sender.email
}

# Secrets -> Secrets Manager (rotation-capable, audited). The JWT signing key lives here.
resource "random_password" "jwt" {
  length  = 64
  special = false
}

resource "aws_secretsmanager_secret" "jwt" {
  name                    = "${local.name}/${var.env}/jwt-signing-key"
  kms_key_id              = aws_kms_key.app.arn
  recovery_window_in_days = 0
}

resource "aws_secretsmanager_secret_version" "jwt" {
  secret_id     = aws_secretsmanager_secret.jwt.id
  secret_string = random_password.jwt.result
}

resource "aws_cloudwatch_log_group" "worker" {
  name              = "/${local.name}/${var.env}/worker"
  retention_in_days = 7
}
