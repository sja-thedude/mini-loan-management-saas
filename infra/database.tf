resource "aws_db_subnet_group" "main" {
  name       = "${local.name}-db"
  subnet_ids = aws_subnet.private[*].id
}

# Aurora Serverless v2 PostgreSQL that SCALES TO ZERO: after 5 idle minutes it pauses and
# compute billing stops (storage only, ~$0.10/GB-month). The first connection resumes it in
# ~15s, so the app uses a 30s connect timeout. Chosen over RDS db.t4g.micro (~$12/month
# always-on) to keep the whole project under $5/month.
resource "aws_rds_cluster" "main" {
  cluster_identifier = "${local.name}-db"
  engine             = "aurora-postgresql"
  engine_mode        = "provisioned" # Serverless v2 runs on the provisioned engine mode
  engine_version     = var.aurora_engine_version

  database_name               = "postgres"
  master_username             = "loan_master"
  manage_master_user_password = true # RDS generates + stores the master password in Secrets Manager

  db_subnet_group_name   = aws_db_subnet_group.main.name
  vpc_security_group_ids = [aws_security_group.db.id]
  storage_encrypted      = true

  serverlessv2_scaling_configuration {
    min_capacity             = 0   # scale to zero
    max_capacity             = 1   # cap: 1 ACU ≈ 2 GiB RAM; also caps cost at ~$0.12/h
    seconds_until_auto_pause = 300 # pause after 5 idle minutes
  }

  backup_retention_period = 1
  preferred_backup_window = "03:00-04:00"

  # Learning-project settings so `terraform destroy` works cleanly.
  deletion_protection = false
  skip_final_snapshot = true
  apply_immediately   = true
}

resource "aws_rds_cluster_instance" "main" {
  identifier          = "${local.name}-db-1"
  cluster_identifier  = aws_rds_cluster.main.id
  instance_class      = "db.serverless"
  engine              = aws_rds_cluster.main.engine
  engine_version      = aws_rds_cluster.main.engine_version
  publicly_accessible = false
}
