# CloudFront publishes free default metrics to us-east-1 with dimension Region=Global.
# The dashboard lives in eu-north-1 and reads CloudFront's us-east-1 metrics cross-region.
# (Alarms on CloudFront metrics must be created in us-east-1, which this single-Region account can't use.)
locals {
  cf_dims = { DistributionId = aws_cloudfront_distribution.site.id, Region = "Global" }
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
    ]
  })
}
