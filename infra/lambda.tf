# Notification worker on Lambda: SQS event source mapping -> apps/worker/src/handler.ts.
# Build first: `npm run build -w apps/worker` (the AWS SDK v3 is provided by the nodejs22.x runtime).
data "archive_file" "worker" {
  type        = "zip"
  source_dir  = "${path.module}/../apps/worker/dist"
  output_path = "${path.module}/.build/worker.zip"
}

resource "aws_lambda_function" "worker" {
  function_name    = "${local.name}-notification-worker"
  role             = module.app.worker_role_arn
  runtime          = "nodejs22.x"
  architectures    = ["arm64"]
  handler          = "handler.handler"
  filename         = data.archive_file.worker.output_path
  source_code_hash = data.archive_file.worker.output_base64sha256
  memory_size      = 256
  timeout          = 30 # must stay below the queue's 60s visibility timeout
  # Cap concurrency so a burst can't exhaust SES quotas or downstream limits.
  reserved_concurrent_executions = 5

  environment {
    variables = {
      NOTIFICATIONS_TABLE = module.app.notifications_table
      OPS_TOPIC_ARN       = module.app.ops_topic_arn
      SSM_PREFIX          = module.app.ssm_prefix
    }
  }

  logging_config {
    log_format = "JSON"
    log_group  = module.app.worker_log_group # module's log group, 7-day retention, scoped IAM
  }
}

resource "aws_lambda_event_source_mapping" "worker" {
  event_source_arn                   = module.app.events_queue_arn
  function_name                      = aws_lambda_function.worker.arn
  batch_size                         = 10
  maximum_batching_window_in_seconds = 2
  function_response_types            = ["ReportBatchItemFailures"] # partial batch failures
  scaling_config { maximum_concurrency = 5 }
}

# Alarm on anything landing in the DLQ: those are events that failed 5 times.
resource "aws_cloudwatch_metric_alarm" "dlq_not_empty" {
  alarm_name          = "${local.name}-events-dlq-not-empty"
  namespace           = "AWS/SQS"
  metric_name         = "ApproximateNumberOfMessagesVisible"
  dimensions          = { QueueName = "${local.name}-prod-loan-events-dlq" }
  statistic           = "Maximum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 0
  comparison_operator = "GreaterThanThreshold"
  alarm_actions       = [module.app.ops_topic_arn]
  treat_missing_data  = "notBreaching"
}
