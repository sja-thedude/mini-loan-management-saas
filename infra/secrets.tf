# The app's DB password: generated here, stored as an SSM SecureString (Standard tier = free,
# encrypted with the AWS-managed aws/ssm key), injected into the container by ECS at start.
# Secrets Manager (~$0.40/secret/month) is used where rotation matters: the Aurora master
# password (managed by RDS) and the JWT signing key (in the app-services module).
resource "random_password" "db_app" {
  length  = 32
  special = false # used in a connection URL and in DDL; alphanumeric avoids escaping
}

resource "aws_ssm_parameter" "db_app_password" {
  name  = "/${local.name}/prod/db-app-password"
  type  = "SecureString"
  value = random_password.db_app.result
}
