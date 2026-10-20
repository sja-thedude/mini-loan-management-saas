output "site_url" { value = "https://${aws_cloudfront_distribution.site.domain_name}" }
output "bucket" { value = aws_s3_bucket.site.bucket }
output "distribution_id" { value = aws_cloudfront_distribution.site.id }
output "github_deploy_role_arn" { value = var.enable_github_oidc ? aws_iam_role.github_deploy[0].arn : "disabled (SCP denies OIDC providers)" }
output "dashboard_url" { value = "https://eu-north-1.console.aws.amazon.com/cloudwatch/home?region=eu-north-1#dashboards/dashboard/${aws_cloudwatch_dashboard.site.dashboard_name}" }
