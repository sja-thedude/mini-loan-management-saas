# Domain events flow:  API (transactional outbox) -> EventBridge bus -> rule -> SQS -> worker
resource "aws_cloudwatch_event_bus" "loans" {
  name = "${local.prefix}-events"
}

resource "aws_sqs_queue" "events_dlq" {
  name                      = "${local.prefix}-loan-events-dlq"
  message_retention_seconds = 1209600 # 14 days to inspect and redrive poison messages
  sqs_managed_sse_enabled   = true
}

resource "aws_sqs_queue" "events" {
  name                       = "${local.prefix}-loan-events"
  visibility_timeout_seconds = 60 # > worker max processing time, or messages get redelivered mid-flight
  receive_wait_time_seconds  = 20 # long polling: fewer empty receives (cheaper)
  sqs_managed_sse_enabled    = true
  redrive_policy = jsonencode({
    deadLetterTargetArn = aws_sqs_queue.events_dlq.arn
    maxReceiveCount     = 5 # after 5 failed attempts the message parks in the DLQ
  })
}

resource "aws_cloudwatch_event_rule" "loan_events" {
  name           = "${local.prefix}-loan-domain-events"
  event_bus_name = aws_cloudwatch_event_bus.loans.name
  event_pattern = jsonencode({
    source        = ["loan-app.api"]
    "detail-type" = ["loan.approved", "loan.rejected", "loan.created", "installment.paid", "loan.closed"]
  })
}

resource "aws_cloudwatch_event_target" "to_sqs" {
  rule           = aws_cloudwatch_event_rule.loan_events.name
  event_bus_name = aws_cloudwatch_event_bus.loans.name
  arn            = aws_sqs_queue.events.arn
}

# Queue policy: only EventBridge, and only from THIS rule, may send.
resource "aws_sqs_queue_policy" "events" {
  queue_url = aws_sqs_queue.events.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "events.amazonaws.com" }
      Action    = "sqs:SendMessage"
      Resource  = aws_sqs_queue.events.arn
      Condition = { ArnEquals = { "aws:SourceArn" = aws_cloudwatch_event_rule.loan_events.arn } }
    }]
  })
}

# Ops alerts (e.g. high-value approvals) fan out via SNS. Locally an SQS "inbox" subscribes
# so tests can assert delivery; in production you'd add email/Slack/PagerDuty subscriptions.
resource "aws_sns_topic" "ops_alerts" {
  name              = "${local.prefix}-ops-alerts"
  kms_master_key_id = aws_kms_key.app.arn
}

resource "aws_sqs_queue" "ops_inbox" {
  name = "${local.prefix}-ops-alerts-inbox"
}

resource "aws_sqs_queue_policy" "ops_inbox" {
  queue_url = aws_sqs_queue.ops_inbox.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "sns.amazonaws.com" }
      Action    = "sqs:SendMessage"
      Resource  = aws_sqs_queue.ops_inbox.arn
      Condition = { ArnEquals = { "aws:SourceArn" = aws_sns_topic.ops_alerts.arn } }
    }]
  })
}

resource "aws_sns_topic_subscription" "ops_inbox" {
  topic_arn            = aws_sns_topic.ops_alerts.arn
  protocol             = "sqs"
  endpoint             = aws_sqs_queue.ops_inbox.arn
  raw_message_delivery = true
}

resource "aws_ses_email_identity" "sender" {
  email = var.notification_sender
}
