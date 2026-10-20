data "aws_iam_policy_document" "ecs_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ecs-tasks.amazonaws.com"]
    }
  }
}

# EXECUTION role: used by the ECS agent BEFORE your code runs: pull image from
# ECR, write logs, fetch the secrets to inject as env vars.
resource "aws_iam_role" "execution" {
  name               = "${local.name}-execution"
  assume_role_policy = data.aws_iam_policy_document.ecs_assume.json
}

resource "aws_iam_role_policy_attachment" "execution_managed" {
  role       = aws_iam_role.execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

resource "aws_iam_role_policy" "execution_secrets" {
  name = "read-app-secrets"
  role = aws_iam_role.execution.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = "secretsmanager:GetSecretValue"
      Resource = [aws_rds_cluster.main.master_user_secret[0].secret_arn]
      }, {
      Effect   = "Allow"
      Action   = "ssm:GetParameters"
      Resource = [aws_ssm_parameter.db_app_password.arn]
    }]
  })
}

# TASK role (what the app code runs as) comes from the shared module: module.app.api_role_arn.

# ECS Exec: the task role opens the SSM Session Manager channel.
resource "aws_iam_role_policy" "task_ecs_exec" {
  name = "ecs-exec"
  role = module.app.api_role_name
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["ssmmessages:CreateControlChannel", "ssmmessages:CreateDataChannel", "ssmmessages:OpenControlChannel", "ssmmessages:OpenDataChannel"]
      Resource = "*"
    }]
  })
}
