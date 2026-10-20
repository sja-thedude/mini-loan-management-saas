# Observability: one dashboard for the whole system, alarms routed to the ops SNS topic, and
# saved Logs Insights queries. All within the always-free CloudWatch allowance
# (3 dashboards, 10 alarms; query definitions are free).

locals {
  events_queue_name = "${local.name}-prod-loan-events"
  dlq_name          = "${local.name}-prod-loan-events-dlq"
}

resource "aws_cloudwatch_dashboard" "app" {
  dashboard_name = "${local.name}-operations"
  dashboard_body = jsonencode({
    widgets = [
      {
        type = "metric", x = 0, y = 0, width = 8, height = 6
        properties = {
          title   = "Loan decisions (business metric)", region = var.region, stat = "Sum", period = 300, view = "timeSeries"
          metrics = [["LoanApp", "LoanDecisions", "Decision", "APPROVED"], ["LoanApp", "LoanDecisions", "Decision", "REJECTED"]]
        }
      },
      {
        type = "metric", x = 8, y = 0, width = 8, height = 6
        properties = {
          title = "Worker Lambda", region = var.region, period = 300, view = "timeSeries"
          metrics = [
            ["AWS/Lambda", "Invocations", "FunctionName", aws_lambda_function.worker.function_name, { stat = "Sum" }],
            ["AWS/Lambda", "Errors", "FunctionName", aws_lambda_function.worker.function_name, { stat = "Sum" }],
            ["AWS/Lambda", "Duration", "FunctionName", aws_lambda_function.worker.function_name, { stat = "p95", yAxis = "right" }],
          ]
        }
      },
      {
        type = "metric", x = 16, y = 0, width = 8, height = 6
        properties = {
          title = "Event queue health", region = var.region, period = 300, view = "timeSeries"
          metrics = [
            ["AWS/SQS", "ApproximateNumberOfMessagesVisible", "QueueName", local.events_queue_name, { stat = "Maximum" }],
            ["AWS/SQS", "ApproximateAgeOfOldestMessage", "QueueName", local.events_queue_name, { stat = "Maximum", yAxis = "right" }],
            ["AWS/SQS", "ApproximateNumberOfMessagesVisible", "QueueName", local.dlq_name, { stat = "Maximum", label = "DLQ depth" }],
          ]
        }
      },
      {
        type = "metric", x = 0, y = 6, width = 8, height = 6
        properties = {
          title = "ECS service (CPU / memory %)", region = var.region, stat = "Average", period = 300, view = "timeSeries"
          metrics = [
            ["AWS/ECS", "CPUUtilization", "ClusterName", aws_ecs_cluster.main.name, "ServiceName", aws_ecs_service.app.name],
            ["AWS/ECS", "MemoryUtilization", "ClusterName", aws_ecs_cluster.main.name, "ServiceName", aws_ecs_service.app.name],
          ]
        }
      },
      {
        type = "metric", x = 8, y = 6, width = 8, height = 6
        properties = {
          title = "Aurora Serverless v2 (ACU; 0 = paused)", region = var.region, period = 300, view = "timeSeries"
          metrics = [
            ["AWS/RDS", "ServerlessDatabaseCapacity", "DBClusterIdentifier", aws_rds_cluster.main.cluster_identifier, { stat = "Maximum" }],
            ["AWS/RDS", "DatabaseConnections", "DBClusterIdentifier", aws_rds_cluster.main.cluster_identifier, { stat = "Maximum", yAxis = "right" }],
          ]
        }
      },
      {
        type = "log", x = 16, y = 6, width = 8, height = 6
        properties = {
          title = "API 5xx (last 3h)", region = var.region, view = "table"
          query = "SOURCE '${aws_cloudwatch_log_group.app.name}' | fields @timestamp, path, status, requestId | filter status >= 500 | sort @timestamp desc | limit 20"
        }
      },
    ]
  })
}

resource "aws_cloudwatch_metric_alarm" "worker_errors" {
  alarm_name          = "${local.name}-worker-errors"
  alarm_description   = "Notification worker Lambda is failing"
  namespace           = "AWS/Lambda"
  metric_name         = "Errors"
  dimensions          = { FunctionName = aws_lambda_function.worker.function_name }
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 0
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [module.app.ops_topic_arn]
}

resource "aws_cloudwatch_metric_alarm" "events_backlog" {
  alarm_name          = "${local.name}-events-oldest-message-age"
  alarm_description   = "Loan events waiting > 10 minutes: worker stuck or throttled"
  namespace           = "AWS/SQS"
  metric_name         = "ApproximateAgeOfOldestMessage"
  dimensions          = { QueueName = local.events_queue_name }
  statistic           = "Maximum"
  period              = 300
  evaluation_periods  = 2
  threshold           = 600
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [module.app.ops_topic_arn]
}

# Metric filter: turns structured API error logs into a metric + alarm (no extra code).
resource "aws_cloudwatch_log_metric_filter" "api_5xx" {
  name           = "${local.name}-api-5xx"
  log_group_name = aws_cloudwatch_log_group.app.name
  pattern        = "{ $.msg = \"request\" && $.status >= 500 }"
  metric_transformation {
    name          = "Api5xx"
    namespace     = "LoanApp"
    value         = "1"
    default_value = "0"
  }
}

resource "aws_cloudwatch_metric_alarm" "api_5xx" {
  alarm_name          = "${local.name}-api-5xx"
  alarm_description   = "API returned 5xx responses"
  namespace           = "LoanApp"
  metric_name         = "Api5xx"
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 5
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [module.app.ops_topic_arn]
}

# Saved Logs Insights queries (CloudWatch > Logs Insights > Saved queries).
resource "aws_cloudwatch_query_definition" "slow_requests" {
  name            = "${local.name}/slowest-api-requests"
  log_group_names = [aws_cloudwatch_log_group.app.name]
  query_string    = <<-Q
    fields @timestamp, method, path, status, ms, tenantId, requestId
    | filter msg = "request"
    | sort ms desc
    | limit 25
  Q
}

resource "aws_cloudwatch_query_definition" "requests_by_tenant" {
  name            = "${local.name}/requests-by-tenant"
  log_group_names = [aws_cloudwatch_log_group.app.name]
  query_string    = <<-Q
    filter msg = "request" and ispresent(tenantId)
    | stats count(*) as requests, avg(ms) as avg_ms, sum(status >= 500) as errors by tenantId
    | sort requests desc
  Q
}

resource "aws_cloudwatch_query_definition" "worker_failures" {
  name            = "${local.name}/worker-failures"
  log_group_names = [module.app.worker_log_group]
  query_string    = <<-Q
    fields @timestamp, @message
    | filter @message like /record_failed|duplicate_skipped/
    | sort @timestamp desc
    | limit 50
  Q
}
