output "site_url" { value = "https://${aws_cloudfront_distribution.site.domain_name}" }
output "bucket" { value = aws_s3_bucket.site.bucket }
output "distribution_id" { value = aws_cloudfront_distribution.site.id }
output "github_deploy_role_arn" { value = aws_iam_role.github_deploy.arn }
output "dashboard_url" { value = "https://us-east-1.console.aws.amazon.com/cloudwatch/home?region=us-east-1#dashboards/dashboard/${aws_cloudwatch_dashboard.site.dashboard_name}" }
