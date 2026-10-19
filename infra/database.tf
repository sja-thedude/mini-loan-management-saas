resource "aws_db_subnet_group" "main" {
  name       = "${local.name}-db"
  subnet_ids = aws_subnet.private[*].id
}

# BILLABLE: ~$12/mo instance + ~$2.30/mo storage (free-tier credits may cover it).
resource "aws_db_instance" "main" {
  identifier     = "${local.name}-db"
  engine         = "postgres"
  engine_version = "16"
  instance_class = "db.t4g.micro"

  allocated_storage = 20
  storage_type      = "gp3"
  storage_encrypted = true # encryption at rest with AWS-managed KMS key

  db_name  = "postgres"
  username = "loan_master"
  # RDS generates the master password and stores/rotates it in Secrets Manager.
  manage_master_user_password = true

  db_subnet_group_name   = aws_db_subnet_group.main.name
  vpc_security_group_ids = [aws_security_group.db.id]
  publicly_accessible    = false # no public IP; reachable only inside the VPC
  multi_az               = false # production: true (standby in a second AZ)

  backup_retention_period = 1 # automated daily snapshots + point-in-time restore
  backup_window           = "03:00-04:00"
  maintenance_window      = "sun:04:30-sun:05:30"

  # Learning-project settings so `terraform destroy` works cleanly.
  # Production: deletion_protection = true, skip_final_snapshot = false.
  deletion_protection = false
  skip_final_snapshot = true
  apply_immediately   = true
}
