# Cost guardrail: every night EventBridge Scheduler calls ecs:UpdateService(desiredCount=0),
# so a forgotten demo can't run for more than a day. Scheduler free tier: 14M invocations/month.
resource "aws_iam_role" "scheduler" {
  name = "${local.name}-scheduler"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "scheduler.amazonaws.com" }
      Action    = "sts:AssumeRole"
      Condition = { StringEquals = { "aws:SourceAccount" = data.aws_caller_identity.current.account_id } }
    }]
  })
}

resource "aws_iam_role_policy" "scheduler" {
  name = "stop-app-service"
  role = aws_iam_role.scheduler.id
  policy = jsonencode({
    Version   = "2012-10-17"
    Statement = [{ Effect = "Allow", Action = "ecs:UpdateService", Resource = aws_ecs_service.app.id }]
  })
}

resource "aws_scheduler_schedule" "stop_app" {
  name                         = "${local.name}-nightly-stop"
  schedule_expression          = var.auto_stop_cron
  schedule_expression_timezone = "UTC"
  flexible_time_window { mode = "OFF" }

  target {
    arn      = "arn:aws:scheduler:::aws-sdk:ecs:updateService" # universal target: any AWS API
    role_arn = aws_iam_role.scheduler.arn
    input = jsonencode({
      Cluster      = aws_ecs_cluster.main.name
      Service      = aws_ecs_service.app.name
      DesiredCount = 0
    })
  }
}
