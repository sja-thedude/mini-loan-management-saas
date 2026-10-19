# Generated here, stored in Secrets Manager, injected into containers by ECS at start.
# Never in the image, the repo, or the task definition in plain text.
resource "random_password" "db_app" {
  length  = 32
  special = false # used in a connection URL and in DDL; alphanumeric avoids escaping
}

resource "aws_secretsmanager_secret" "app" {
  name                    = "${local.name}/app"
  recovery_window_in_days = 0 # learning project: allow immediate delete on destroy
}

resource "aws_secretsmanager_secret_version" "app" {
  secret_id = aws_secretsmanager_secret.app.id
  secret_string = jsonencode({
    DB_PASSWORD = random_password.db_app.result
  })
}
