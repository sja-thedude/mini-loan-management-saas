# VPC: your private network in one region. Subnets live in one Availability Zone each.
# PUBLIC subnet  = its route table sends 0.0.0.0/0 to the Internet Gateway.
# PRIVATE subnet = no route to the internet at all. RDS lives here.
# No NAT Gateway (~$33/mo): the app runs in public subnets with a public IP instead.
resource "aws_vpc" "main" {
  cidr_block           = "10.0.0.0/16"
  enable_dns_support   = true
  enable_dns_hostnames = true
  tags                 = { Name = "${local.name}-vpc" }
}

resource "aws_internet_gateway" "main" {
  vpc_id = aws_vpc.main.id
}

resource "aws_subnet" "public" {
  count                   = 2
  vpc_id                  = aws_vpc.main.id
  cidr_block              = cidrsubnet(aws_vpc.main.cidr_block, 8, count.index) # 10.0.0.0/24, 10.0.1.0/24
  availability_zone       = local.azs[count.index]
  map_public_ip_on_launch = false # ECS assigns the public IP explicitly
  tags                    = { Name = "${local.name}-public-${count.index}" }
}

resource "aws_subnet" "private" {
  count             = 2 # RDS requires a subnet group spanning 2 AZs, even for single-AZ
  vpc_id            = aws_vpc.main.id
  cidr_block        = cidrsubnet(aws_vpc.main.cidr_block, 8, count.index + 10) # 10.0.10.0/24, 10.0.11.0/24
  availability_zone = local.azs[count.index]
  tags              = { Name = "${local.name}-private-${count.index}" }
}

resource "aws_route_table" "public" {
  vpc_id = aws_vpc.main.id
  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.main.id
  }
  tags = { Name = "${local.name}-public" }
}

resource "aws_route_table_association" "public" {
  count          = 2
  subnet_id      = aws_subnet.public[count.index].id
  route_table_id = aws_route_table.public.id
}

resource "aws_route_table" "private" {
  vpc_id = aws_vpc.main.id # only the implicit local route: VPC-internal traffic only
  tags   = { Name = "${local.name}-private" }
}

resource "aws_route_table_association" "private" {
  count          = 2
  subnet_id      = aws_subnet.private[count.index].id
  route_table_id = aws_route_table.private.id
}

# Security groups are stateful firewalls attached to network interfaces.
resource "aws_security_group" "app" {
  name        = "${local.name}-app"
  description = "Fargate task: web port from the allowed IP only"
  vpc_id      = aws_vpc.main.id

  ingress {
    description = "Next.js from allowed IP"
    from_port   = 3001
    to_port     = 3001
    protocol    = "tcp"
    cidr_blocks = [var.allowed_cidr]
  }
  egress {
    description = "ECR, Secrets Manager, S3, CloudWatch, RDS"
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

resource "aws_security_group" "db" {
  name        = "${local.name}-db"
  description = "RDS: Postgres only from the app security group"
  vpc_id      = aws_vpc.main.id

  ingress {
    description     = "Postgres from app tasks"
    from_port       = 5432
    to_port         = 5432
    protocol        = "tcp"
    security_groups = [aws_security_group.app.id] # SG reference, not an IP range
  }
}
