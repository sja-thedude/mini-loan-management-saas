# GitHub Actions -> AWS without stored keys. GitHub issues a signed OIDC token per job;
# STS exchanges it for temporary credentials of this role, ONLY for this repo's main/dev branches.
variable "enable_github_oidc" {
  description = "Create the GitHub OIDC provider + deploy role. Off: this project account's SCP (p-cckwuvh0) denies iam:CreateOpenIDConnectProvider."
  type        = bool
  default     = false
}

resource "aws_iam_openid_connect_provider" "github" {
  count          = var.enable_github_oidc ? 1 : 0
  url            = "https://token.actions.githubusercontent.com"
  client_id_list = ["sts.amazonaws.com"]
}

data "aws_iam_policy_document" "github_trust" {
  count = var.enable_github_oidc ? 1 : 0
  statement {
    actions = ["sts:AssumeRoleWithWebIdentity"]
    principals {
      type        = "Federated"
      identifiers = [aws_iam_openid_connect_provider.github[0].arn]
    }
    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:aud"
      values   = ["sts.amazonaws.com"]
    }
    condition {
      test     = "StringLike"
      variable = "token.actions.githubusercontent.com:sub"
      values   = ["repo:${var.github_repo}:ref:refs/heads/main", "repo:${var.github_repo}:ref:refs/heads/dev"]
    }
  }
}

resource "aws_iam_role" "github_deploy" {
  count                = var.enable_github_oidc ? 1 : 0
  name                 = "${local.name}-github-deploy"
  assume_role_policy   = data.aws_iam_policy_document.github_trust[0].json
  max_session_duration = 3600
}

# Least privilege: sync files into this one bucket and invalidate this one distribution.
resource "aws_iam_role_policy" "github_deploy" {
  count = var.enable_github_oidc ? 1 : 0
  name  = "deploy-static-site"
  role  = aws_iam_role.github_deploy[0].id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      { Sid = "ListBucket", Effect = "Allow", Action = "s3:ListBucket", Resource = aws_s3_bucket.site.arn },
      { Sid = "WriteObjects", Effect = "Allow", Action = ["s3:PutObject", "s3:DeleteObject"], Resource = "${aws_s3_bucket.site.arn}/*" },
      { Sid = "Invalidate", Effect = "Allow", Action = "cloudfront:CreateInvalidation", Resource = aws_cloudfront_distribution.site.arn },
    ]
  })
}
