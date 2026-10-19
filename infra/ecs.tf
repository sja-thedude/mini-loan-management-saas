resource "aws_ecr_repository" "repo" {
  for_each             = toset(["api", "web"])
  name                 = "${local.name}-${each.key}"
  image_tag_mutability = "MUTABLE"
  force_delete         = true
  image_scanning_configuration { scan_on_push = true }
}

resource "aws_ecr_lifecycle_policy" "repo" {
  for_each   = aws_ecr_repository.repo
  repository = each.value.name
  policy = jsonencode({
    rules = [{
      rulePriority = 1
      description  = "Keep last 5 images (storage costs money)"
      selection    = { tagStatus = "any", countType = "imageCountMoreThan", countNumber = 5 }
      action       = { type = "expire" }
    }]
  })
}

resource "aws_cloudwatch_log_group" "app" {
  name              = "/ecs/${local.name}"
  retention_in_days = 7 # logs are billed per GB stored; never keep forever by default
}

resource "aws_ecs_cluster" "main" {
  name = local.name
}

locals {
  ecr = { for k, r in aws_ecr_repository.repo : k => "${r.repository_url}:${var.image_tag}" }
  log = { logDriver = "awslogs", options = { "awslogs-group" = aws_cloudwatch_log_group.app.name, "awslogs-region" = var.region } }
}

# Task definition = the "docker-compose file" for one task: images, CPU/memory,
# env, secrets, ports, health checks, logging, IAM roles.
resource "aws_ecs_task_definition" "app" {
  family                   = local.name
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc" # task gets its own ENI; containers share localhost
  cpu                      = 512
  memory                   = 1024
  execution_role_arn       = aws_iam_role.execution.arn
  task_role_arn            = module.app.api_role_arn
  runtime_platform {
    cpu_architecture        = "ARM64" # Graviton: ~20% cheaper than x86
    operating_system_family = "LINUX"
  }

  container_definitions = jsonencode([
    {
      name      = "api"
      image     = local.ecr["api"]
      essential = true
      environment = [
        { name = "DB_HOST", value = aws_db_instance.main.address },
        { name = "AWS_REGION", value = var.region },
        { name = "S3_BUCKET", value = module.app.documents_bucket },
        { name = "KMS_KEY_ID", value = module.app.kms_key_arn },
        { name = "EVENT_BUS_NAME", value = module.app.event_bus },
        { name = "JWT_SECRET_ID", value = module.app.jwt_secret_arn }, # fetched by the app via the task role
        { name = "SSM_PREFIX", value = module.app.ssm_prefix },
        { name = "METRICS_ENABLED", value = "true" },
        { name = "COOKIE_SECURE", value = "false" }, # no HTTPS without a load balancer/CloudFront
      ]
      secrets = [
        { name = "DB_PASSWORD", valueFrom = "${aws_secretsmanager_secret.app.arn}:DB_PASSWORD::" },
      ]
      healthCheck = {
        command     = ["CMD-SHELL", "wget -qO- http://localhost:4000/api/health || exit 1"]
        interval    = 15
        timeout     = 5
        retries     = 3
        startPeriod = 30
      }
      logConfiguration = merge(local.log, { options = merge(local.log.options, { "awslogs-stream-prefix" = "api" }) })
    },
    {
      name             = "web"
      image            = local.ecr["web"]
      essential        = true
      portMappings     = [{ containerPort = 3001, protocol = "tcp" }]
      dependsOn        = [{ containerName = "api", condition = "HEALTHY" }]
      logConfiguration = merge(local.log, { options = merge(local.log.options, { "awslogs-stream-prefix" = "web" }) })
    },
  ])
}

# One-off task: creates the least-privilege DB role. Only THIS task gets master creds.
resource "aws_ecs_task_definition" "db_bootstrap" {
  family                   = "${local.name}-db-bootstrap"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = 256
  memory                   = 512
  execution_role_arn       = aws_iam_role.execution.arn
  runtime_platform {
    cpu_architecture        = "ARM64"
    operating_system_family = "LINUX"
  }
  container_definitions = jsonencode([{
    name        = "bootstrap"
    image       = local.ecr["api"]
    essential   = true
    command     = ["node", "dist/scripts/bootstrap-db.js"]
    environment = [{ name = "DB_HOST", value = aws_db_instance.main.address }]
    secrets = [
      { name = "DB_MASTER_USER", valueFrom = "${aws_db_instance.main.master_user_secret[0].secret_arn}:username::" },
      { name = "DB_MASTER_PASSWORD", valueFrom = "${aws_db_instance.main.master_user_secret[0].secret_arn}:password::" },
      { name = "DB_PASSWORD", valueFrom = "${aws_secretsmanager_secret.app.arn}:DB_PASSWORD::" },
    ]
    logConfiguration = merge(local.log, { options = merge(local.log.options, { "awslogs-stream-prefix" = "bootstrap" }) })
  }])
}

# BILLABLE: ~$14/mo while desired_count = 1 (0.5 vCPU / 1 GB ARM) + ~$3.60/mo public IPv4.
resource "aws_ecs_service" "app" {
  name            = local.name
  cluster         = aws_ecs_cluster.main.id
  task_definition = aws_ecs_task_definition.app.arn
  desired_count   = var.desired_count
  launch_type     = "FARGATE"

  network_configuration {
    subnets          = aws_subnet.public[*].id
    security_groups  = [aws_security_group.app.id]
    assign_public_ip = true # how the task reaches ECR/Secrets Manager without a NAT Gateway
  }

  deployment_circuit_breaker {
    enable   = true
    rollback = true # failed health checks -> automatic rollback to previous task def
  }
}
