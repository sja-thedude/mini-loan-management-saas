variable "region" {
  type    = string
  default = "us-east-1"
}

variable "alert_email" {
  description = "Where AWS Budgets sends spending alerts"
  type        = string
}

variable "monthly_budget_usd" {
  type    = number
  default = 10
}

variable "allowed_cidr" {
  description = "Your public IP as x.x.x.x/32. Only this address can reach the app (no load balancer in front)."
  type        = string
}

variable "desired_count" {
  description = "Number of running app tasks. Set to 0 to stop paying for Fargate compute."
  type        = number
  default     = 1
}

variable "image_tag" {
  type    = string
  default = "latest"
}

variable "app_origins" {
  description = "Browser origins of the web app (S3 CORS for direct document uploads)"
  type        = list(string)
  default     = ["https://app.example.com"]
}

variable "notification_sender" {
  description = "SES-verified sender address (SES starts in sandbox: verified recipients only)"
  type        = string
  default     = "no-reply@loan-app.example"
}
