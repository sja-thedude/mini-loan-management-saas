# CloudFront publishes free default metrics to us-east-1 with dimension Region=Global.
# Free tier: 3 dashboards, 10 standard alarms. No SNS action (SNS is blocked by the account SCP),
# so alarms are visible in the console only.
locals {
  cf_dims = { DistributionId = aws_cloudfront_distribution.site.id, Region = "Global" }
}

resource "aws_cloudwatch_metric_alarm" "cf_5xx" {
  alarm_name          = "${local.name}-cloudfront-5xx-rate"
  alarm_description   = "Origin/edge errors above 5% for 10 minutes"
  namespace           = "AWS/CloudFront"
  metric_name         = "5xxErrorRate"
  dimensions          = local.cf_dims
  statistic           = "Average"
  period              = 300
  evaluation_periods  = 2
  threshold           = 5
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
}

resource "aws_cloudwatch_metric_alarm" "cf_4xx" {
  alarm_name          = "${local.name}-cloudfront-4xx-rate"
  alarm_description   = "Client errors above 25% for 15 minutes (broken links / bad deploy)"
  namespace           = "AWS/CloudFront"
  metric_name         = "4xxErrorRate"
  dimensions          = local.cf_dims
  statistic           = "Average"
  period              = 300
  evaluation_periods  = 3
  threshold           = 25
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
}

resource "aws_cloudwatch_dashboard" "site" {
  dashboard_name = "${local.name}-overview"
  dashboard_body = jsonencode({
    widgets = [
      {
        type = "metric", x = 0, y = 0, width = 12, height = 6
        properties = {
          title   = "Requests", region = "us-east-1", stat = "Sum", period = 300, view = "timeSeries"
          metrics = [["AWS/CloudFront", "Requests", "DistributionId", aws_cloudfront_distribution.site.id, "Region", "Global"]]
        }
      },
      {
        type = "metric", x = 12, y = 0, width = 12, height = 6
        properties = {
          title = "Error rates (%)", region = "us-east-1", stat = "Average", period = 300, view = "timeSeries"
          metrics = [
            ["AWS/CloudFront", "4xxErrorRate", "DistributionId", aws_cloudfront_distribution.site.id, "Region", "Global"],
            ["AWS/CloudFront", "5xxErrorRate", "DistributionId", aws_cloudfront_distribution.site.id, "Region", "Global"],
          ]
        }
      },
      {
        type = "metric", x = 0, y = 6, width = 12, height = 6
        properties = {
          title   = "Bytes downloaded", region = "us-east-1", stat = "Sum", period = 300, view = "timeSeries"
          metrics = [["AWS/CloudFront", "BytesDownloaded", "DistributionId", aws_cloudfront_distribution.site.id, "Region", "Global"]]
        }
      },
      {
        type       = "alarm", x = 12, y = 6, width = 12, height = 6
        properties = { title = "Alarms", alarms = [aws_cloudwatch_metric_alarm.cf_5xx.arn, aws_cloudwatch_metric_alarm.cf_4xx.arn] }
      },
    ]
  })
}
